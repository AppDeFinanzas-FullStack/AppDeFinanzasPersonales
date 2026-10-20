import {
  Amount,
  Rate,
  type CategoryChip,
  type CreateTransactionInput,
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
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { useSettings } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { useCreateTransaction, useRegisterContext } from '../hooks/use-register-context';

import { AccountChip } from './account-chip';
import { AllCategoriesSheet } from './all-categories-sheet';
import { AmountInput } from './amount-input';
import { CategoryGrid } from './category-grid';
import { DateChips } from './date-chips';
import { KindToggle, type RegisterKind } from './kind-toggle';
import { TransferFields } from './transfer-fields';

interface RegisterValues {
  /** The UUID v7 of the movement, kept in the draft so a retry is idempotent (ADR-11). */
  id: string;
  kind: RegisterKind;
  amount: string;
  categoryId: string;
  date: string;
  /** Transfer only: origin and destination, and between two currencies the rate and what arrives. */
  fromAccountId: string;
  toAccountId: string;
  rate: string;
  amountIn: string;
}

const RegisterDraft = z
  .object({
    id: z.string(),
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: z.string(),
    categoryId: z.string(),
    date: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    rate: z.string(),
    amountIn: z.string(),
  })
  .partial();

/** The kinds of this form (plan §4.7.4). */
const KINDS: readonly RegisterKind[] = ['expense', 'income', 'transfer'];

/** A typed amount as decimal text with 2 decimals, or `null`. */
const decimalText = (raw: string): string | null => parseAmountInput(raw)?.toFixed(2) ?? null;

/** After this long the context is refreshed in the background once the user starts typing. */
const CONTEXT_FRESH_MS = 60_000;

/**
 * The form of `/registrar` (plan §4.7.3, §4.7.4): it opens as an expense with the focus on the
 * amount, or restores the `register` draft with its kind (RF-M7-02, RF-M7-08). "Guardar" is
 * enabled with an amount over 0 and a category (RF-M7-06), and Enter in the amount saves.
 */
export function RegisterForm() {
  const { t } = useTranslation('register');
  const me = useMe();
  const settings = useSettings();
  const context = useRegisterContext();
  const create = useCreateTransaction();
  const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());
  const amountRef = useRef<HTMLInputElement>(null);
  const refreshed = useRef(false);
  const [firstId] = useState(() => uuidv7());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [picked, setPicked] = useState<CategoryChip | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const rates = useCurrentRate();
  const emptyTransfer = { fromAccountId: '', toAccountId: '', rate: '', amountIn: '' };
  const form = useForm<RegisterValues>({
    defaultValues: {
      id: firstId,
      kind: 'expense',
      amount: '',
      categoryId: '',
      date: today,
      ...emptyTransfer,
    },
  });
  const draft = useDraft('register', form, { userId: me.data?.id ?? '', schema: RegisterDraft });
  const [kind, amount, categoryId, date, fromAccountId, toAccountId, rate, amountIn] = useWatch({
    control: form.control,
    name: [
      'kind',
      'amount',
      'categoryId',
      'date',
      'fromAccountId',
      'toAccountId',
      'rate',
      'amountIn',
    ],
  });

  // RF-M7-02: the focus starts on the amount.
  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  const chipKind = kind === 'income' ? 'income' : 'expense';
  const data = context.data;
  // RF-M7-03: the default account of the settings, else the last one used for the kind (the API
  // already falls back to the first active one).
  const accountId = data === undefined ? null : (data.defaultAccountId ?? data.lastUsed[chipKind]);
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
    amountIn !== '' || !crossCurrency || parsed === null || rateDecimal === null || rateDecimal.isZero()
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

  const ready =
    kind === 'transfer'
      ? transferReady
      : amountOk && categoryId !== '' && account !== undefined;

  const setTransfer = (name: 'fromAccountId' | 'toAccountId' | 'rate' | 'amountIn', value: string) => {
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

  const save = (values: RegisterValues) => {
    if (!ready || amountText === null) return;
    if (values.kind !== 'transfer' && account === undefined) return;
    setFormError(null);
    const input: CreateTransactionInput =
      values.kind === 'transfer'
        ? {
            kind: 'transfer' as const,
            id: values.id,
            fromAccountId: fromId,
            toAccountId: toId,
            amountOut: amountText,
            date: values.date,
            ...(crossCurrency && rateText !== null && amountInText !== null
              ? { declaredRate: rateText, amountIn: amountInText }
              : {}),
          }
        : {
            kind: chipKind,
            id: values.id,
            accountId: account?.id ?? '',
            categoryId: values.categoryId,
            amount: amountText,
            date: values.date,
          };
    create.mutate(input, {
        onSuccess: () => {
          // A new movement starts with a new id (plan §4.7.3); a transfer keeps its pair.
          form.reset({
            id: uuidv7(),
            kind: values.kind,
            amount: '',
            categoryId: '',
            date: today,
            ...emptyTransfer,
            ...(values.kind === 'transfer' ? { fromAccountId: fromId, toAccountId: toId } : {}),
          });
          draft.clear();
          setPicked(undefined);
          amountRef.current?.focus();
        },
        onError: (error) => {
          // The form keeps what the user wrote (EC-M7-02).
          setFormError(messageForError(error instanceof ApiError ? error : { code: '' }));
        },
      },
    );
  };

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
    </>
  );
}
