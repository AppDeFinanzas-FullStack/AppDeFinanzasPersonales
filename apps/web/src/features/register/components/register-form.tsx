import {
  Amount,
  Rate,
  type CategoryChip,
  type CreateTransactionInput,
  type ShortcutDto,
} from '@finanzas/contracts';
import {
  amountInFrom,
  BOLIVIA_TIME_ZONE,
  parseAmountInput,
  parseMoney,
  rateFromAmounts,
  todayFor,
  transferPrefill,
} from '@finanzas/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { QuickAccountForm } from '@/features/accounts/components/quick-account-form';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { useFormatters, useSettings } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import {
  REGISTER_CONTEXT_KEY,
  useCreateTransaction,
  useRegisterContext,
} from '../hooks/use-register-context';

import { AccountChip } from './account-chip';
import { AllCategoriesSheet } from './all-categories-sheet';
import { AmountInput } from './amount-input';
import { AskRateDialog } from './ask-rate-dialog';
import { CategoryGrid } from './category-grid';
import { DateChips } from './date-chips';
import { FeeField } from './fee-field';
import { KindToggle, type RegisterKind } from './kind-toggle';
import { SaveAsShortcutDialog, type ShortcutDraft } from './save-as-shortcut-dialog';
import { NoteField, SecondLevel } from './second-level';
import { ShortcutChips } from './shortcut-chips';
import { TransferFields } from './transfer-fields';

interface RegisterValues {
  /** The UUID v7 of the movement, kept in the draft so a retry is idempotent (ADR-11). */
  id: string;
  kind: RegisterKind;
  amount: string;
  /** The account the user chose; empty takes the preselected one (RF-M7-03). */
  accountId: string;
  categoryId: string;
  date: string;
  /** Transfer only: origin and destination, and between two currencies the rate and what arrives. */
  fromAccountId: string;
  toAccountId: string;
  rate: string;
  amountIn: string;
  /** Second level (plan §4.7.4): the note and, for a transfer, its fee. */
  note: string;
  feeAmount: string;
  feeCategoryId: string;
}

const RegisterDraft = z
  .object({
    id: z.string(),
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: z.string(),
    accountId: z.string(),
    categoryId: z.string(),
    date: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    rate: z.string(),
    amountIn: z.string(),
    note: z.string(),
    feeAmount: z.string(),
    feeCategoryId: z.string(),
  })
  .partial();

/** An expense or an income as Registrar sends it. */
type SimpleInput = Extract<CreateTransactionInput, { kind: 'expense' | 'income' }>;

/** The kinds of this form (plan §4.7.4). */
const KINDS: readonly RegisterKind[] = ['expense', 'income', 'transfer'];

/** After this long the context is refreshed in the background once the user starts typing. */
const CONTEXT_FRESH_MS = 60_000;

/** A typed amount as decimal text with 2 decimals, or `null`. */
const decimalText = (raw: string): string | null => parseAmountInput(raw)?.toFixed(2) ?? null;

const EMPTY_TRANSFER = { fromAccountId: '', toAccountId: '', rate: '', amountIn: '' };
const EMPTY_SECOND = { note: '', feeAmount: '', feeCategoryId: '' };

/**
 * The form of `/registrar` (plan §4.7.3, §4.7.4): it opens as an expense with the focus on the
 * amount, or restores the `register` draft with its kind (RF-M7-02, RF-M7-08). "Guardar" is
 * enabled with an amount over 0 and a category (RF-M7-06), and Enter in the amount saves. A
 * transfer takes origin and destination instead, and between two currencies a declared rate.
 */
export function RegisterForm() {
  const { t } = useTranslation('register');
  const me = useMe();
  const settings = useSettings();
  const context = useRegisterContext();
  const create = useCreateTransaction();
  const rates = useCurrentRate();
  const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());
  const amountRef = useRef<HTMLInputElement>(null);
  const refreshed = useRef(false);
  const [firstId] = useState(() => uuidv7());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [picked, setPicked] = useState<CategoryChip | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  /** The movement waiting for a rate (EC-M7-04). */
  const [askRate, setAskRate] = useState<SimpleInput | null>(null);
  /** EC-M6-08: the API asked for the category of the fee. */
  const [feeAskCategory, setFeeAskCategory] = useState(false);
  const [shortcut, setShortcut] = useState<ShortcutDraft | null>(null);
  const queryClient = useQueryClient();
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();

  const form = useForm<RegisterValues>({
    defaultValues: {
      id: firstId,
      kind: 'expense',
      amount: '',
      accountId: '',
      categoryId: '',
      date: today,
      ...EMPTY_TRANSFER,
      ...EMPTY_SECOND,
    },
  });
  const draft = useDraft('register', form, { userId: me.data?.id ?? '', schema: RegisterDraft });
  const [
    kind,
    amount,
    chosenAccountId,
    categoryId,
    date,
    fromAccountId,
    toAccountId,
    rate,
    amountIn,
    note,
    feeAmount,
    feeCategoryId,
  ] = useWatch({
    control: form.control,
    name: [
      'kind',
      'amount',
      'accountId',
      'categoryId',
      'date',
      'fromAccountId',
      'toAccountId',
      'rate',
      'amountIn',
      'note',
      'feeAmount',
      'feeCategoryId',
    ],
  });
  const accountIssue = form.formState.errors.accountId?.message;

  // RF-M7-02: the focus starts on the amount.
  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  const chipKind = kind === 'income' ? 'income' : 'expense';
  const data = context.data;

  // EC-M7-08, RF-M2-11: a draft whose account is no longer active empties it and marks it.
  useEffect(() => {
    if (data === undefined || chosenAccountId === '') return;
    if (data.accounts.some((item) => item.id === chosenAccountId)) return;
    form.setValue('accountId', '', { shouldDirty: true });
    form.setError('accountId', { type: 'reselect', message: t('account.reselect') });
  }, [data, chosenAccountId, form, t]);

  // RF-M7-03: the account the user chose, else the default one of the settings, else the last one
  // used for the kind (the API already falls back to the first active one).
  const accountId =
    chosenAccountId !== ''
      ? chosenAccountId
      : data === undefined
        ? null
        : (data.defaultAccountId ?? data.lastUsed[chipKind]);
  const account = data?.accounts.find((item) => item.id === accountId);
  const parsed = parseAmountInput(amount);
  const amountText = parsed === null ? null : parsed.toFixed(2);
  const amountOk = amountText !== null && Amount.safeParse(amountText).success;

  // A transfer opens with the last pair used, else the account above and another one (plan §4.7.3).
  const accounts = data?.accounts ?? [];
  const pair = data?.lastUsed.transferPair ?? null;
  const fromId = fromAccountId !== '' ? fromAccountId : (pair?.from ?? accountId ?? '');
  const toId =
    toAccountId !== ''
      ? toAccountId
      : (pair?.to ?? accounts.find((item) => item.id !== fromId)?.id ?? '');
  const from = accounts.find((item) => item.id === fromId);
  const to = accounts.find((item) => item.id === toId);
  const crossCurrency =
    from !== undefined && to !== undefined && from.currencyCode !== to.currencyCode;

  // RF-M3-07: the declared rate is prefilled from the reference in use, by direction.
  const prefill = (out: string, into: string): string => {
    const current = rates.data;
    if (current === undefined) return '';
    const bid = current.references.parallel_bid?.value;
    const ask = current.references.parallel_ask?.value;
    const manual =
      current.inUse.kind === 'manual' && current.inUse.value !== null ? current.inUse.value : null;
    const value = transferPrefill({
      from: out,
      to: into,
      date,
      manual: manual === null ? null : parseMoney(manual),
      parallel:
        bid === undefined || ask === undefined
          ? null
          : { bid: parseMoney(bid), ask: parseMoney(ask) },
      customRates: {},
    });
    return value === null ? '' : value.toFixed(2);
  };
  const shownRate =
    crossCurrency && rate === '' ? prefill(from.currencyCode, to.currencyCode) : rate;
  const rateDecimal = parseAmountInput(shownRate);
  const shownAmountIn =
    amountIn !== '' ||
    !crossCurrency ||
    parsed === null ||
    rateDecimal === null ||
    rateDecimal.isZero()
      ? amountIn
      : amountInFrom(parsed, rateDecimal, from.currencyCode).toFixed(2);
  const amountInText = decimalText(shownAmountIn);
  const rateText = rateDecimal === null ? null : rateDecimal.toFixed(2);

  const transferReady =
    amountOk &&
    from !== undefined &&
    to !== undefined &&
    fromId !== toId &&
    (!crossCurrency ||
      (rateText !== null &&
        Rate.safeParse(rateText).success &&
        amountInText !== null &&
        Amount.safeParse(amountInText).success));

  // RF-M6-05: an optional fee, valid when given; without its category the API asks for one.
  const feeText = feeAmount.trim() === '' ? null : decimalText(feeAmount);
  const feeOk =
    feeAmount.trim() === '' ||
    (feeText !== null &&
      Amount.safeParse(feeText).success &&
      (!feeAskCategory || feeCategoryId !== ''));
  const noteText = note.trim();

  const ready =
    kind === 'transfer'
      ? transferReady && feeOk
      : amountOk && categoryId !== '' && account !== undefined;

  const setTransfer = (
    name: 'fromAccountId' | 'toAccountId' | 'rate' | 'amountIn',
    value: string,
  ) => {
    form.setValue(name, value, { shouldDirty: true });
  };
  const onFrom = (id: string) => {
    setTransfer('fromAccountId', id);
    setTransfer('toAccountId', toId);
    setTransfer('rate', '');
    setTransfer('amountIn', '');
  };
  const onTo = (id: string) => {
    setTransfer('fromAccountId', fromId);
    setTransfer('toAccountId', id);
    setTransfer('rate', '');
    setTransfer('amountIn', '');
  };
  const onRate = (next: string) => {
    setTransfer('rate', next);
    setTransfer('amountIn', '');
  };
  // RF-M3-08: what arrives sets the rate.
  const onAmountIn = (next: string) => {
    setTransfer('amountIn', next);
    const into = parseAmountInput(next);
    if (from !== undefined && parsed !== null && into !== null && !into.isZero()) {
      setTransfer('rate', rateFromAmounts(parsed, into, from.currencyCode).toFixed(2));
    }
  };

  const onAmount = (next: string) => {
    form.setValue('amount', next, { shouldDirty: true });
    // The screen makes no request before the user types (plan §4.7.4); an old context is
    // refreshed once, in the background, with the first keystroke.
    if (!refreshed.current && Date.now() - context.dataUpdatedAt > CONTEXT_FRESH_MS) {
      refreshed.current = true;
      void context.refetch();
    }
  };

  const onKind = (next: RegisterKind) => {
    if (next === kind) return;
    form.setValue('kind', next, { shouldDirty: true });
    // A category belongs to one kind.
    form.setValue('categoryId', '', { shouldDirty: true });
    setPicked(undefined);
  };

  const onCategory = (category: CategoryChip) => {
    form.setValue('categoryId', category.id, { shouldDirty: true });
    setPicked(category);
  };

  /** The text of an error; a negative balance shows the amount in its account's currency. */
  const errorText = (error: unknown): string => {
    if (!(error instanceof ApiError)) return messageForError({ code: '' });
    const balance = error.data?.['resultingBalance'];
    const currency = data?.accounts.find((item) => item.id === error.data?.['accountId'])
      ?.currencyCode;
    if (error.code === 'NEGATIVE_BALANCE' && typeof balance === 'string' && currency !== undefined) {
      return messageForError({
        code: error.code,
        data: { ...error.data, resultingBalance: formatters.money(balance, symbolOf(currency)) },
      });
    }
    return messageForError(error);
  };

  const send = (input: CreateTransactionInput) => {
    setFormError(null);
    create.mutate(input, {
      onSuccess: () => {
        setAskRate(null);
        // A new movement starts with a new id (plan §4.7.3); a transfer keeps its pair.
        form.reset({
          id: uuidv7(),
          kind: input.kind,
          amount: '',
          accountId: '',
          categoryId: '',
          date: today,
          ...EMPTY_TRANSFER,
          ...EMPTY_SECOND,
          ...(input.kind === 'transfer'
            ? { fromAccountId: input.fromAccountId, toAccountId: input.toAccountId }
            : {}),
        });
        draft.clear();
        setPicked(undefined);
        setFeeAskCategory(false);
        amountRef.current?.focus();
      },
      onError: (error) => {
        if (error instanceof ApiError && error.code === 'FEE_CATEGORY_REQUIRED') {
          setFeeAskCategory(true);
        }
        // EC-M7-04: without any rate, ask for the dollar and resend with the same id.
        if (
          error instanceof ApiError &&
          error.code === 'RATE_REQUIRED' &&
          input.kind !== 'transfer' &&
          input.manualUsdRate === undefined
        ) {
          setAskRate(input);
          return;
        }
        setAskRate(null);
        // The form keeps what the user wrote (EC-M7-02).
        setFormError(errorText(error));
      },
    });
  };

  const save = (values: RegisterValues) => {
    if (!ready || amountText === null) return;
    if (values.kind === 'transfer') {
      send({
        kind: 'transfer',
        id: values.id,
        fromAccountId: fromId,
        toAccountId: toId,
        amountOut: amountText,
        date: values.date,
        ...(crossCurrency && rateText !== null && amountInText !== null
          ? { declaredRate: rateText, amountIn: amountInText }
          : {}),
        ...(noteText === '' ? {} : { note: noteText }),
        ...(feeText === null
          ? {}
          : {
              fee: {
                id: uuidv7(),
                amount: feeText,
                ...(feeCategoryId === '' ? {} : { categoryId: feeCategoryId }),
              },
            }),
      });
      return;
    }
    if (account === undefined) return;
    send({
      kind: chipKind,
      id: values.id,
      accountId: account.id,
      categoryId: values.categoryId,
      amount: amountText,
      date: values.date,
      ...(noteText === '' ? {} : { note: noteText }),
    });
  };

  /** What the form holds now, as a shortcut of its kind (RF-M7-10). */
  const shortcutDraft = (): ShortcutDraft | null => {
    const base = {
      ...(amountOk && amountText !== null ? { amount: amountText } : {}),
      ...(noteText === '' ? {} : { note: noteText }),
    };
    if (kind === 'transfer') {
      if (from === undefined || to === undefined || fromId === toId) return null;
      return { kind: 'transfer', accountId: fromId, destAccountId: toId, ...base };
    }
    if (account === undefined || categoryId === '') return null;
    return { kind: chipKind, accountId: account.id, categoryId, ...base };
  };
  // RF-M7-09: a shortcut fills the form without saving; without an amount the focus stays on it.
  const onShortcut = (shortcut: ShortcutDto) => {
    const set = (name: keyof RegisterValues, value: string) => {
      form.setValue(name, value, { shouldDirty: true });
    };
    set('kind', shortcut.kind);
    set('amount', shortcut.amount ?? '');
    set('note', shortcut.note ?? '');
    if (shortcut.kind === 'transfer') {
      set('fromAccountId', shortcut.accountId);
      set('toAccountId', shortcut.destAccountId ?? '');
      set('rate', '');
      set('amountIn', '');
      set('categoryId', '');
      setPicked(undefined);
    } else {
      set('accountId', shortcut.accountId);
      set('categoryId', shortcut.categoryId ?? '');
      setPicked(
        data?.grid[shortcut.kind].find((chip) => chip.id === shortcut.categoryId) ?? undefined,
      );
    }
    if (shortcut.amount === null) amountRef.current?.focus();
  };
  const alwaysShowNote = settings.data?.alwaysShowNote ?? false;
  const setNote = (next: string) => {
    form.setValue('note', next, { shouldDirty: true });
  };

  // EC-M7-01: without accounts, the minimal account form takes the place of Registrar.
  if (data !== undefined && data.accounts.length === 0) {
    return (
      <QuickAccountForm
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: REGISTER_CONTEXT_KEY });
        }}
      />
    );
  }

  return (
    <>
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          void form.handleSubmit(save)(event);
        }}
      >
        <KindToggle value={kind} kinds={KINDS} onChange={onKind} />
        <ShortcutChips
          shortcuts={(data?.shortcuts ?? []).filter((item) => item.kind === kind)}
          onPick={onShortcut}
        />
        <AmountInput id="register-amount" value={amount} onChange={onAmount} inputRef={amountRef} />
        {kind !== 'transfer' && (
          <AccountChip account={account} kind={kind} loading={context.isPending} />
        )}
        {kind === 'transfer' && (
          <TransferFields
            accounts={accounts}
            fromId={fromId}
            toId={toId}
            onFrom={onFrom}
            onTo={onTo}
            exchange={
              crossCurrency
                ? { rate: shownRate, amountIn: shownAmountIn, onRate, onAmountIn }
                : null
            }
          />
        )}
        {accountIssue !== undefined && (
          <p role="status" className="text-sm text-destructive">
            {accountIssue}
          </p>
        )}
        {context.isError && data === undefined && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t('loadError')}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => {
                void context.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </div>
        )}
        {kind !== 'transfer' && (
          <CategoryGrid
            chips={data?.grid[chipKind] ?? []}
            extra={picked}
            selectedId={categoryId}
            loading={context.isPending}
            onSelect={onCategory}
            onShowAll={() => {
              setSheetOpen(true);
            }}
          />
        )}
        <DateChips
          value={date}
          today={today}
          weekStart={settings.data?.weekStart ?? 'monday'}
          onChange={(next) => {
            form.setValue('date', next, { shouldDirty: true });
          }}
        />
        {alwaysShowNote && <NoteField value={note} onChange={setNote} />}
        <SecondLevel
          note={alwaysShowNote ? null : { value: note, onChange: setNote }}
          account={
            kind === 'transfer' || account === undefined
              ? null
              : {
                  accounts,
                  value: account.id,
                  onChange: (id) => {
                    form.setValue('accountId', id, { shouldDirty: true });
                  },
                }
          }
          fee={
            kind === 'transfer' ? (
              <FeeField
                amount={feeAmount}
                onAmount={(next) => {
                  form.setValue('feeAmount', next, { shouldDirty: true });
                }}
                askCategory={feeAskCategory}
                categoryId={feeCategoryId}
                onCategory={(id) => {
                  form.setValue('feeCategoryId', id, { shouldDirty: true });
                }}
              />
            ) : null
          }
          onSaveAsShortcut={() => {
            const next = shortcutDraft();
            if (next === null) {
              setFormError(t('shortcut.incomplete'));
              return;
            }
            setShortcut(next);
          }}
        />
        {formError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={!ready || create.isPending}>
          {create.isPending ? t('saving') : t('save')}
        </Button>
      </form>
      <AllCategoriesSheet
        open={sheetOpen}
        kind={chipKind}
        selectedId={categoryId}
        onOpenChange={setSheetOpen}
        onSelect={onCategory}
      />
      {shortcut !== null && (
        <SaveAsShortcutDialog
          shortcut={shortcut}
          onClose={() => {
            setShortcut(null);
          }}
        />
      )}
      <AskRateDialog
        key={askRate?.id ?? 'none'}
        open={askRate !== null}
        pending={create.isPending}
        onConfirm={(value) => {
          if (askRate !== null) send({ ...askRate, manualUsdRate: value });
        }}
        onCancel={() => {
          setAskRate(null);
        }}
      />
    </>
  );
}
