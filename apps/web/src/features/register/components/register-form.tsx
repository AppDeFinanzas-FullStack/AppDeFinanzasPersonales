import { Amount, type CategoryChip, type CreateTransactionInput } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, parseAmountInput, todayFor } from '@finanzas/domain';
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
import { KindToggle, type RegisterKind } from './kind-toggle';

interface RegisterValues {
  /** The UUID v7 of the movement, kept in the draft so a retry is idempotent (ADR-11). */
  id: string;
  kind: RegisterKind;
  amount: string;
  /** The account the user chose; empty takes the preselected one (RF-M7-03). */
  accountId: string;
  categoryId: string;
  date: string;
}

const RegisterDraft = z
  .object({
    id: z.string(),
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: z.string(),
    accountId: z.string(),
    categoryId: z.string(),
    date: z.string(),
  })
  .partial();

/** An expense or an income as Registrar sends it. */
type SimpleInput = Extract<CreateTransactionInput, { kind: 'expense' | 'income' }>;

/** The kinds of this form: an expense or an income. */
const KINDS: readonly RegisterKind[] = ['expense', 'income'];

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
  /** The movement waiting for a rate (EC-M7-04). */
  const [askRate, setAskRate] = useState<SimpleInput | null>(null);
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
    },
  });
  const draft = useDraft('register', form, { userId: me.data?.id ?? '', schema: RegisterDraft });
  const [kind, amount, chosenAccountId, categoryId, date] = useWatch({
    control: form.control,
    name: ['kind', 'amount', 'accountId', 'categoryId', 'date'],
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
  const ready =
    amountText !== null &&
    Amount.safeParse(amountText).success &&
    categoryId !== '' &&
    account !== undefined;

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

  const send = (input: SimpleInput) => {
    setFormError(null);
    create.mutate(input, {
      onSuccess: () => {
        setAskRate(null);
        // A new movement starts with a new id (plan §4.7.3).
        form.reset({
          id: uuidv7(),
          kind: input.kind,
          amount: '',
          accountId: '',
          categoryId: '',
          date: today,
        });
        draft.clear();
        setPicked(undefined);
        amountRef.current?.focus();
      },
      onError: (error) => {
        // EC-M7-04: without any rate, ask for the dollar and resend with the same id.
        if (
          error instanceof ApiError &&
          error.code === 'RATE_REQUIRED' &&
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
    if (!ready || account === undefined || amountText === null) return;
    send({
      kind: chipKind,
      id: values.id,
      accountId: account.id,
      categoryId: values.categoryId,
      amount: amountText,
      date: values.date,
    });
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
        <AmountInput id="register-amount" value={amount} onChange={onAmount} inputRef={amountRef} />
        <AccountChip account={account} kind={kind} loading={context.isPending} />
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
      <AskRateDialog
        key={askRate?.id ?? 'none'}
        open={askRate !== null}
        pending={create.isPending}
        onConfirm={(rate) => {
          if (askRate !== null) send({ ...askRate, manualUsdRate: rate });
        }}
        onCancel={() => {
          setAskRate(null);
        }}
      />
    </>
  );
}
