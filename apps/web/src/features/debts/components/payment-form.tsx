import { Amount, type DebtDto, type PaymentInput } from '@finanzas/contracts';
import {
  BOLIVIA_TIME_ZONE,
  parseAmountInput,
  parseMoney,
  proposeSplit,
  todayFor,
} from '@finanzas/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldSelect } from '@/features/accounts/components/account-form';
import { useAccounts, useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { EarmarkConfirmDialog } from '@/features/goals/components/earmark-confirm-dialog';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import {
  amountInAccount,
  ExchangeField,
  invalidateAfterDebtChange,
  useDeclaredRate,
} from './debt-form';

const paymentEndpoint = (debtId: string): Endpoint<PaymentInput, unknown> => ({
  method: 'POST',
  path: `/api/debts/${encodeURIComponent(debtId)}/payments`,
  input: z.custom<PaymentInput>(),
  output: z.unknown(),
});

const EarmarkProposal = z.array(z.object({ goalId: z.string(), amount: z.string() }));

/** The payment waiting for the user to choose which earmarks to take (EC-M13-04). */
interface PendingEarmark {
  input: PaymentInput;
  accountId: string;
  shortfall: string;
  proposal: { goalId: string; amount: string }[];
}

type FieldName = 'amount' | 'interest' | 'capital' | 'date' | 'rate';
type FieldErrors = Partial<Record<FieldName, string>>;

/** The part of the breakdown the user typed; the other one follows (RF-M13-05). */
interface Edit {
  field: 'interest' | 'capital';
  value: string;
}

/** Records a payment of a debt with its breakdown into interest and capital (RF-M13-05). */
export function PaymentForm({
  debt,
  open,
  onOpenChange,
}: {
  debt: DebtDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('debts');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('actions.close')}>
        <DialogHeader>
          <DialogTitle>{t('payment.title')}</DialogTitle>
          <DialogDescription>
            {t('payment.description', {
              person: debt.person,
              pending: formatters.money(debt.pending, symbolOf(debt.currencyCode)),
            })}
          </DialogDescription>
        </DialogHeader>
        <PaymentFormFields
          debt={debt}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PaymentFormFields({ debt, onDone }: { debt: DebtDto; onDone: () => void }) {
  const { t } = useTranslation('debts');
  const me = useMe();
  const accounts = useAccounts('active');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const queryClient = useQueryClient();
  const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());

  // The ids are kept while the form is open, so a retry never duplicates the payment (ADR-11).
  const [id] = useState(() => uuidv7());
  const [capitalTransactionId] = useState(() => uuidv7());
  const [interestTransactionId] = useState(() => uuidv7());
  const [amount, setAmount] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState('');
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingEarmark, setPendingEarmark] = useState<PendingEarmark | null>(null);

  const symbol = symbolOf(debt.currencyCode);
  const accrued = parseMoney(debt.interestAccrued);
  const outstanding = parseMoney(debt.capitalOutstanding);
  const pending = parseMoney(debt.pending);

  const parsedAmount = parseAmountInput(amount.trim());

  // Interest first (RF-M13-05); once the user edits a part, the other one is the rest.
  const shown = ((): { interest: string; capital: string } => {
    if (edit === null) {
      if (parsedAmount === null) return { interest: '', capital: '' };
      const split = proposeSplit(parsedAmount, accrued, outstanding);
      return { interest: split.interestPart.toFixed(2), capital: split.capitalPart.toFixed(2) };
    }
    const typed = parseAmountInput(edit.value.trim());
    const rest =
      parsedAmount !== null && typed !== null && parsedAmount.greaterThanOrEqualTo(typed)
        ? parsedAmount.minus(typed).toFixed(2)
        : '';
    return edit.field === 'interest'
      ? { interest: edit.value, capital: rest }
      : { interest: rest, capital: edit.value };
  })();

  const account = accounts.data?.items.find((item) => item.id === accountId);
  const declared = useDeclaredRate(debt.currencyCode, account?.currencyCode, date, typedRate);
  const amountText = parsedAmount === null ? null : parsedAmount.toFixed(2);
  const accountAmount =
    account === undefined || !declared.needed
      ? null
      : amountInAccount(
          amountText !== null && Amount.safeParse(amountText).success ? amountText : null,
          declared.rate,
          debt.currencyCode,
        );

  const save = useMutation({
    mutationFn: (input: PaymentInput) => call(paymentEndpoint(debt.id), input),
    onSuccess: async () => {
      setPendingEarmark(null);
      await invalidateAfterDebtChange(queryClient, debt.id);
      onDone();
    },
    onError: (error, input) => {
      // EC-M13-04: ask which goals to take from and resend with the same ids.
      if (error instanceof ApiError && error.code === 'EARMARK_CONFIRMATION_REQUIRED') {
        const shortfall = error.data?.['shortfall'];
        const proposal = EarmarkProposal.safeParse(error.data?.['proposal']);
        if (typeof shortfall === 'string' && proposal.success && input.account !== undefined) {
          setPendingEarmark({
            input,
            accountId: input.account.accountId,
            shortfall,
            proposal: proposal.data,
          });
          return;
        }
      }
      setPendingEarmark(null);
      setFormError(messageForError(error instanceof ApiError ? error : { code: '' }));
    },
  });

  const submit = () => {
    const next: FieldErrors = {};
    const total = amountText !== null && Amount.safeParse(amountText).success ? parsedAmount : null;
    if (total === null) {
      next.amount = t('payment.errors.amount');
    } else if (total.greaterThan(pending)) {
      next.amount = t('payment.errors.exceeds', {
        pending: formatters.money(debt.pending, symbol),
      });
    }
    const interest = parseAmountInput(shown.interest.trim());
    const capital = parseAmountInput(shown.capital.trim());
    if (interest === null) {
      next.interest = t('payment.errors.interestInvalid');
    } else if (interest.greaterThan(accrued)) {
      next.interest = t('payment.errors.interestOver', {
        max: formatters.money(debt.interestAccrued, symbol),
      });
    }
    if (capital === null) {
      next.capital = t('payment.errors.capitalInvalid');
    } else if (capital.greaterThan(outstanding)) {
      next.capital = t('payment.errors.capitalOver', {
        max: formatters.money(debt.capitalOutstanding, symbol),
      });
    }
    if (
      total !== null &&
      interest !== null &&
      capital !== null &&
      next.interest === undefined &&
      next.capital === undefined &&
      !interest.plus(capital).equals(total)
    ) {
      next.capital = t('payment.errors.mismatch', {
        amount: formatters.money(total.toFixed(2), symbol),
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date < debt.startDate) {
      next.date = t('payment.errors.date');
    }
    if (account !== undefined && declared.needed && declared.rate === null) {
      next.rate = t('payment.errors.rate');
    }
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0 || total === null || interest === null || capital === null) {
      return;
    }

    save.mutate({
      id,
      amount: total.toFixed(2),
      interestPart: interest.toFixed(2),
      capitalPart: capital.toFixed(2),
      date,
      ...(account === undefined
        ? {}
        : {
            account: {
              accountId: account.id,
              capitalTransactionId,
              interestTransactionId,
              ...(declared.needed && declared.rate !== null ? { declaredRate: declared.rate } : {}),
            },
          }),
    });
  };

  return (
    <>
      <form
        noValidate
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="payment-amount">{t('payment.amount')}</Label>
          <Input
            id="payment-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 tabular-nums"
            aria-invalid={errors.amount !== undefined || undefined}
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
          {errors.amount !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {errors.amount}
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="payment-interest">{t('payment.interest')}</Label>
            <Input
              id="payment-interest"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              aria-invalid={errors.interest !== undefined || undefined}
              value={shown.interest}
              onChange={(event) => {
                setEdit({ field: 'interest', value: event.target.value });
              }}
            />
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="payment-capital">{t('payment.capital')}</Label>
            <Input
              id="payment-capital"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              aria-invalid={errors.capital !== undefined || undefined}
              value={shown.capital}
              onChange={(event) => {
                setEdit({ field: 'capital', value: event.target.value });
              }}
            />
          </div>
        </div>
        {errors.interest !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {errors.interest}
          </p>
        )}
        {errors.capital !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {errors.capital}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="payment-date">{t('payment.date')}</Label>
          <Input
            id="payment-date"
            type="date"
            className="h-11"
            aria-invalid={errors.date !== undefined || undefined}
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
          {errors.date !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {errors.date}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="payment-account">{t('payment.account')}</Label>
          <FieldSelect
            id="payment-account"
            aria-describedby="payment-account-hint"
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setTypedRate(null);
            }}
          >
            <option value="">{t('payment.noAccount')}</option>
            {(accounts.data?.items ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {`${item.name} · ${item.currencyCode}`}
              </option>
            ))}
          </FieldSelect>
          <p id="payment-account-hint" className="text-sm text-muted-foreground">
            {t('payment.accountHint')}
          </p>
        </div>
        {account !== undefined && declared.needed && (
          <ExchangeField
            id="payment-rate"
            scope="payment"
            shown={declared.shown}
            onChange={setTypedRate}
            error={errors.rate}
            preview={
              accountAmount === null
                ? null
                : formatters.money(accountAmount, symbolOf(account.currencyCode))
            }
          />
        )}
        {formError !== null && pendingEarmark === null && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="submit" className="h-11" disabled={save.isPending}>
            {save.isPending ? t('payment.saving') : t('payment.save')}
          </Button>
        </DialogFooter>
      </form>
      <EarmarkConfirmDialog
        open={pendingEarmark !== null}
        shortfall={pendingEarmark?.shortfall ?? '0.00'}
        accountId={pendingEarmark?.accountId ?? ''}
        proposal={pendingEarmark?.proposal ?? []}
        symbol={symbolOf(
          accounts.data?.items.find((item) => item.id === pendingEarmark?.accountId)
            ?.currencyCode ?? '',
        )}
        pending={save.isPending}
        onConfirm={(earmarkWithdrawals) => {
          if (pendingEarmark !== null) {
            save.mutate({ ...pendingEarmark.input, earmarkWithdrawals });
          }
        }}
        onCancel={() => {
          setPendingEarmark(null);
        }}
      />
    </>
  );
}
