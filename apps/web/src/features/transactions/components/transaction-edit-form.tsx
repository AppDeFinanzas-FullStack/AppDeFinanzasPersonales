import { Note, Rate, UpdateTransactionInput } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, parseAmountInput, todayFor } from '@finanzas/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldSelect } from '@/features/accounts/components/account-form';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { TRANSACTIONS_KEY } from '../hooks/use-transactions';

import {
  convertWithStoredRates,
  CurrencyChangeConfirm,
  MAX_AMOUNT,
} from './currency-change-confirm';
import { isGone, TransactionDetailData } from './transaction-detail';

const updateTransactionEndpoint = (
  id: string,
): Endpoint<UpdateTransactionInput, TransactionDetailData> => ({
  method: 'PATCH',
  path: `/api/transactions/${encodeURIComponent(id)}`,
  input: UpdateTransactionInput,
  output: TransactionDetailData,
});

/** Every mutation of a movement refreshes these (plan §4.6.4). */
const AFFECTED_KEYS = [TRANSACTIONS_KEY, ['accounts'], ['dashboard'], ['budgets']] as const;

interface EditValues {
  amount: string;
  accountId: string;
  fromAccountId: string;
  toAccountId: string;
  amountInNewCurrency: string;
  date: string;
  note: string;
  rate: string;
}

const EditDraft = z
  .object({
    amount: z.string(),
    accountId: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    amountInNewCurrency: z.string(),
    date: z.string(),
    note: z.string(),
    rate: z.string(),
  })
  .partial();

/** The rate the user may edit by hand, and the field it travels in (RF-M3-10, plan §4.6.2). */
type RateField = 'rateUsdBob' | 'rateCurBob' | 'declaredRate';

const unsigned = (amount: string): string => (amount.startsWith('-') ? amount.slice(1) : amount);

/** What the user typed as an amount, as decimal text; `null` when it is not one (RF-M7-02). */
function amountText(raw: string): string | null {
  const value = parseAmountInput(raw.trim());
  return value === null ? null : value.toFixed(2);
}

interface TransactionEditFormProps {
  transaction: TransactionDetailData;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * `<TransactionEditForm>` with the draft `transaction-edit:{id}` (plan §4.6.4). The stored rate is
 * kept unless the user edits it (RF-M3-10); in a linked movement the amount, the account and the
 * date are locked (RF-M6-09). Saving waits for the answer to show the balance errors.
 */
export function TransactionEditForm({ transaction, onDone, onCancel }: TransactionEditFormProps) {
  const { t } = useTranslation('transactions');
  const me = useMe();
  const queryClient = useQueryClient();
  const active = useAccounts('active');
  const archived = useAccounts('archived');
  const [formError, setFormError] = useState<string | null>(null);
  const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());

  const transfer = transaction.kind === 'transfer';
  const out = transfer
    ? transaction.entries.find((entry) => entry.amount.startsWith('-'))
    : undefined;
  const arrival = transfer ? transaction.entries.find((entry) => entry !== out) : undefined;
  const main = out ?? transaction.entries[0];
  const locked = transaction.linkedLocked;
  const crossCurrency =
    out !== undefined && arrival !== undefined && out.currencyCode !== arrival.currencyCode;
  const currency = main?.currencyCode ?? 'BOB';
  const rateField: RateField = crossCurrency
    ? 'declaredRate'
    : currency === 'BOB'
      ? 'rateUsdBob'
      : 'rateCurBob';
  const storedRate =
    rateField === 'declaredRate'
      ? (transaction.declaredRate ?? '')
      : rateField === 'rateUsdBob'
        ? (transaction.rateUsdBob ?? '')
        : transaction.rateCurBob;
  const storedAmount = main === undefined ? '' : unsigned(main.amount);

  const form = useForm<EditValues>({
    defaultValues: {
      amount: storedAmount,
      accountId: transfer ? '' : (main?.accountId ?? ''),
      fromAccountId: out?.accountId ?? '',
      toAccountId: arrival?.accountId ?? '',
      amountInNewCurrency: '',
      date: transaction.date,
      note: transaction.note ?? '',
      rate: storedRate,
    },
  });
  const draft = useDraft(`transaction-edit:${transaction.id}`, form, {
    userId: me.data?.id ?? '',
    schema: EditDraft,
  });
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    clearErrors,
    formState: { errors },
  } = form;
  const accountId = useWatch({ control: form.control, name: 'accountId' });
  const fromAccountId = useWatch({ control: form.control, name: 'fromAccountId' });
  const toAccountId = useWatch({ control: form.control, name: 'toAccountId' });

  const all = [...(active.data?.items ?? []), ...(archived.data?.items ?? [])];
  const accountOf = (id: string) => all.find((account) => account.id === id);
  const activeItems = active.data?.items ?? [];
  /** Active accounts of that currency, plus the current one even if archived. */
  const optionsFor = (currencyCode: string | null, current: string | undefined) => {
    const options = activeItems.filter(
      (account) => currencyCode === null || account.currencyCode === currencyCode,
    );
    const stored = current === undefined ? undefined : accountOf(current);
    return stored !== undefined && !options.some((account) => account.id === stored.id)
      ? [...options, stored]
      : options;
  };
  const labelOf = (account: { name: string; status: string }) =>
    account.status === 'active' ? account.name : t('edit.archived', { name: account.name });

  const newCurrency = transfer ? null : (accountOf(accountId)?.currencyCode ?? currency);
  const currencyChanged = newCurrency !== null && newCurrency !== currency;
  const prefilled =
    currencyChanged &&
    convertWithStoredRates(storedAmount, transaction.rateCurBob, transaction.rateUsdBob, newCurrency) !==
      null;

  const save = useMutation({
    mutationFn: (input: UpdateTransactionInput) =>
      call(updateTransactionEndpoint(transaction.id), input),
    onSuccess: async () => {
      draft.clear();
      await Promise.all(
        AFFECTED_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      onDone();
    },
    onError: (error) => {
      // EC-M6-02: deleted in another context; nothing was saved.
      setFormError(
        isGone(error)
          ? t('detail.gone')
          : messageForError(error instanceof ApiError ? error : { code: '' }),
      );
    },
  });

  /** A new account of another currency prefills the converted amount (RF-M6-07). */
  const onAccountChange = (next: string) => {
    clearErrors('amountInNewCurrency');
    const target = accountOf(next)?.currencyCode;
    if (target === undefined || target === currency) {
      setValue('amountInNewCurrency', '');
      return;
    }
    const converted = convertWithStoredRates(
      form.getValues('amount'),
      transaction.rateCurBob,
      transaction.rateUsdBob,
      target,
    );
    setValue('amountInNewCurrency', converted ?? '');
    if (converted !== null && MAX_AMOUNT.lessThan(converted)) {
      setError('amountInNewCurrency', { message: t('currencyChange.tooLarge') });
    }
  };

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    const input: UpdateTransactionInput = {};
    let invalid = false;
    const fail = (field: keyof EditValues, message: string) => {
      setError(field, { message });
      invalid = true;
    };

    if (!locked) {
      if (transfer) {
        if (values.fromAccountId !== out?.accountId) input.fromAccountId = values.fromAccountId;
        if (values.toAccountId !== arrival?.accountId) input.toAccountId = values.toAccountId;
      } else if (values.accountId !== main?.accountId) {
        input.accountId = values.accountId;
      }
      if (currencyChanged) {
        const converted = amountText(values.amountInNewCurrency);
        if (converted !== null && MAX_AMOUNT.lessThan(converted)) {
          fail('amountInNewCurrency', t('currencyChange.tooLarge'));
        } else if (converted === null || converted === '0.00') {
          fail('amountInNewCurrency', t('edit.errors.amount'));
        } else {
          input.amountInNewCurrency = converted;
        }
      } else {
        const amount = amountText(values.amount);
        if (amount === null || amount === '0.00' || MAX_AMOUNT.lessThan(amount)) {
          fail('amount', t('edit.errors.amount'));
        } else if (amount !== storedAmount) {
          input.amount = amount;
        }
      }
      if (values.date !== transaction.date) {
        if (values.date === '' || values.date > today) fail('date', t('edit.errors.date'));
        else input.date = values.date;
      }
    }

    const note = Note.safeParse(values.note);
    if (!note.success) {
      fail('note', t('edit.errors.note'));
    } else if (note.data !== (transaction.note ?? '')) {
      input.note = note.data === '' ? null : note.data;
    }

    if (values.rate.trim() !== storedRate) {
      const rate = amountText(values.rate);
      if (rate === null || !Rate.safeParse(rate).success || rate === '0.00') {
        fail('rate', t('edit.errors.rate'));
      } else if (rate !== storedRate) {
        input[rateField] = rate;
      }
    }

    if (invalid) return;
    if (Object.keys(input).length === 0) {
      draft.clear();
      onDone();
      return;
    }
    save.mutate(input);
  });

  const rateLabel =
    rateField === 'declaredRate'
      ? t('edit.declaredRate')
      : rateField === 'rateUsdBob' || currency === 'USD'
        ? t('edit.rateUsd')
        : t('edit.rateCur', { code: currency });

  const fieldError = (field: keyof EditValues) =>
    errors[field]?.message === undefined ? null : (
      <p id={`edit-${field}-error`} role="alert" className="text-sm text-destructive">
        {errors[field].message}
      </p>
    );
  const lockedHelp = locked ? (
    <p className="text-sm text-muted-foreground">{t('edit.locked')}</p>
  ) : null;

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      {draft.restoredWithIssues && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('edit.draftIssues')}
        </p>
      )}

      {!currencyChanged && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-amount">{t('edit.amount')}</Label>
          <Input
            id="edit-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 tabular-nums"
            disabled={locked}
            aria-invalid={errors.amount !== undefined}
            {...register('amount')}
          />
          {lockedHelp}
          {fieldError('amount')}
        </div>
      )}

      {transfer ? (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-from">{t('edit.from')}</Label>
            <FieldSelect id="edit-from" disabled={locked} {...register('fromAccountId')}>
              {optionsFor(out?.currencyCode ?? null, out?.accountId)
                .filter((account) => account.id !== toAccountId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {labelOf(account)}
                  </option>
                ))}
            </FieldSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-to">{t('edit.to')}</Label>
            <FieldSelect id="edit-to" disabled={locked} {...register('toAccountId')}>
              {optionsFor(arrival?.currencyCode ?? null, arrival?.accountId)
                .filter((account) => account.id !== fromAccountId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {labelOf(account)}
                  </option>
                ))}
            </FieldSelect>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-account">{t('edit.account')}</Label>
          <FieldSelect
            id="edit-account"
            disabled={locked}
            {...register('accountId', {
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                onAccountChange(event.target.value);
              },
            })}
          >
            {optionsFor(null, main?.accountId).map((account) => (
              <option key={account.id} value={account.id}>
                {labelOf(account)}
              </option>
            ))}
          </FieldSelect>
        </div>
      )}

      {currencyChanged && newCurrency !== null && (
        <CurrencyChangeConfirm
          id="edit-amount-in-new-currency"
          code={newCurrency}
          prefilled={prefilled}
          field={register('amountInNewCurrency')}
          error={errors.amountInNewCurrency?.message}
        />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-date">{t('edit.date')}</Label>
        <Input
          id="edit-date"
          type="date"
          className="h-11"
          max={today}
          disabled={locked}
          aria-invalid={errors.date !== undefined}
          {...register('date')}
        />
        {fieldError('date')}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-note">{t('edit.note')}</Label>
        <Input
          id="edit-note"
          autoComplete="off"
          maxLength={140}
          className="h-11"
          aria-invalid={errors.note !== undefined}
          {...register('note')}
        />
        {fieldError('note')}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-rate">{rateLabel}</Label>
        <Input
          id="edit-rate"
          inputMode="decimal"
          autoComplete="off"
          className="h-11 tabular-nums"
          aria-describedby="edit-rate-help"
          aria-invalid={errors.rate !== undefined}
          {...register('rate')}
        />
        <p id="edit-rate-help" className="text-sm text-muted-foreground">
          {t('edit.rateHelp')}
        </p>
        {fieldError('rate')}
      </div>

      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {save.isPending ? t('edit.saving') : t('edit.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11"
          onClick={() => {
            draft.clear();
            onCancel();
          }}
        >
          {t('edit.cancel')}
        </Button>
      </div>
    </form>
  );
}
