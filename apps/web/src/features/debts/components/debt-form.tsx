import {
  Amount,
  InterestRate,
  Rate,
  type CreateDebtInput,
  type DebtDirection,
  type InterestPeriod,
} from '@finanzas/contracts';
import {
  amountInFrom,
  BOLIVIA_TIME_ZONE,
  parseAmountInput,
  parseMoney,
  todayFor,
  transferPrefill,
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
import { FieldSelect, useCurrencyCodes } from '@/features/accounts/components/account-form';
import { useAccounts, useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { DEBTS_KEY, useDebts } from '../hooks/use-debts';

const PERSON_MAX = 40;
const NOTE_MAX = 140;
const SUGGESTIONS_MAX = 5;

const createDebtEndpoint: Endpoint<CreateDebtInput, unknown> = {
  method: 'POST',
  path: '/api/debts',
  input: z.custom<CreateDebtInput>(),
  output: z.unknown(),
};

/** What a change in a debt refreshes besides the debts: movements, accounts and Inicio. */
export async function invalidateAfterDebtChange(
  queryClient: ReturnType<typeof useQueryClient>,
  debtId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: DEBTS_KEY }),
    queryClient.invalidateQueries({ queryKey: ['debt', debtId] }),
    queryClient.invalidateQueries({ queryKey: ['transactions'] }),
    queryClient.invalidateQueries({ queryKey: ['accounts'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['goals'] }),
  ]);
}

/**
 * The rate between the currency of the debt and the one of the account (RF-M13-09): prefilled as
 * in RF-M3-07 and editable. `rate` is the valid text the API takes, or `null`.
 */
export function useDeclaredRate(
  from: string,
  to: string | undefined,
  date: string,
  typed: string | null,
): { needed: boolean; shown: string; rate: string | null } {
  const rates = useCurrentRate();
  const needed = to !== undefined && to !== from;
  let prefill = '';
  const current = rates.data;
  if (needed && current !== undefined) {
    const bid = current.references.parallel_bid?.value;
    const ask = current.references.parallel_ask?.value;
    const manual =
      current.inUse.kind === 'manual' && current.inUse.value !== null ? current.inUse.value : null;
    const value = transferPrefill({
      from,
      to,
      date,
      manual: manual === null ? null : parseMoney(manual),
      parallel:
        bid === undefined || ask === undefined
          ? null
          : { bid: parseMoney(bid), ask: parseMoney(ask) },
      customRates: {},
    });
    prefill = value === null ? '' : value.toFixed(2);
  }
  const shown = typed ?? prefill;
  const parsed = parseAmountInput(shown.trim());
  const text = parsed === null ? null : parsed.toFixed(2);
  const valid = text !== null && Rate.safeParse(text).success;
  return { needed, shown, rate: valid ? text : null };
}

/** The amount of the account for an amount of the debt and the declared rate (RF-M13-09). */
export function amountInAccount(
  amount: string | null,
  rate: string | null,
  debtCurrency: string,
): string | null {
  if (amount === null || rate === null) return null;
  return amountInFrom(parseMoney(amount), parseMoney(rate), debtCurrency).toFixed(2);
}

/** The "Tipo de cambio" field with what the account gets (RF-M13-09). */
export function ExchangeField({
  id,
  shown,
  onChange,
  error,
  preview,
  scope,
}: {
  id: string;
  shown: string;
  onChange: (next: string) => void;
  error: string | undefined;
  /** What the account gets, already formatted; `null` while it cannot be computed. */
  preview: string | null;
  scope: 'form' | 'payment';
}) {
  const { t } = useTranslation('debts');
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{t(`${scope}.rate`)}</Label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="h-11 tabular-nums"
        aria-describedby={`${id}-hint`}
        aria-invalid={error !== undefined || undefined}
        value={shown}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {t(`${scope}.rateHint`)}
      </p>
      {preview !== null && (
        <p className="text-sm tabular-nums">{t(`${scope}.inAccount`, { amount: preview })}</p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The "Persona" field: it suggests the people already used in other debts (RF-M13-01). */
function PersonField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  error: string | undefined;
}) {
  const { t } = useTranslation('debts');
  const debts = useDebts('debt');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);

  const people = new Map<string, string>();
  for (const debt of debts.data?.debts ?? []) {
    const key = debt.person.trim().toLowerCase();
    if (!people.has(key)) people.set(key, debt.person.trim());
  }
  const query = value.trim().toLowerCase();
  const suggestions =
    query === ''
      ? []
      : [...people.entries()]
          .filter(([key, name]) => key.includes(query) && name !== value)
          .map(([, name]) => name)
          .slice(0, SUGGESTIONS_MAX);
  const open = focused && suggestions.length > 0;

  const pick = (name: string) => {
    onChange(name);
    setActive(-1);
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="debt-person">{t('form.person')}</Label>
      <Input
        id="debt-person"
        role="combobox"
        aria-expanded={open}
        aria-controls="debt-person-options"
        aria-autocomplete="list"
        autoComplete="off"
        className="h-11"
        aria-invalid={error !== undefined || undefined}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setActive(-1);
        }}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => (index + 1) % suggestions.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
          } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            pick(suggestions[active] ?? value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setFocused(false);
          }
        }}
      />
      {open && (
        <ul
          id="debt-person-options"
          role="listbox"
          className="flex flex-col rounded-md border border-border"
          onMouseDown={(event) => {
            // The input keeps the focus, so the click on an option is not lost.
            event.preventDefault();
          }}
        >
          {suggestions.map((name, index) => (
            <li
              key={name}
              role="option"
              aria-selected={index === active}
              className="flex min-h-11 cursor-pointer items-center px-3 aria-selected:bg-muted"
              onClick={() => {
                pick(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

type FieldName = 'person' | 'amount' | 'startDate' | 'interest' | 'rate';
type FieldErrors = Partial<Record<FieldName, string>>;

/** Creates a debt, with an optional interest and an optional initial movement (RF-M13-01). */
export function DebtForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('debts');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('actions.close')}>
        <DialogHeader>
          <DialogTitle>{t('form.title')}</DialogTitle>
          <DialogDescription>{t('form.description')}</DialogDescription>
        </DialogHeader>
        <DebtFormFields
          onDone={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function DebtFormFields({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('debts');
  const me = useMe();
  const rates = useCurrentRate();
  const accounts = useAccounts('active');
  const currencies = useCurrencyCodes();
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const queryClient = useQueryClient();
  const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());

  // The ids are kept while the form is open, so a retry never duplicates the debt (ADR-11).
  const [id] = useState(() => uuidv7());
  const [transactionId] = useState(() => uuidv7());
  const [direction, setDirection] = useState<DebtDirection>('i_owe');
  const [person, setPerson] = useState('');
  const [amount, setAmount] = useState('');
  const [chosenCurrency, setChosenCurrency] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [interest, setInterest] = useState('');
  const [period, setPeriod] = useState<InterestPeriod>('monthly');
  const [accountId, setAccountId] = useState('');
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const currency = chosenCurrency !== '' ? chosenCurrency : (rates.data?.base ?? 'BOB');
  const account = accounts.data?.items.find((item) => item.id === accountId);
  const declared = useDeclaredRate(currency, account?.currencyCode, startDate, typedRate);
  const parsedAmount = parseAmountInput(amount.trim());
  const amountText = parsedAmount === null ? null : parsedAmount.toFixed(2);
  const accountAmount =
    account === undefined || !declared.needed
      ? null
      : amountInAccount(
          amountText !== null && Amount.safeParse(amountText).success ? amountText : null,
          declared.rate,
          currency,
        );

  const save = useMutation({
    mutationFn: (input: CreateDebtInput) => call(createDebtEndpoint, input),
    onSuccess: async () => {
      await invalidateAfterDebtChange(queryClient, id);
      onDone();
    },
    onError: (error) => {
      setFormError(messageForError(error instanceof ApiError ? error : { code: '' }));
    },
  });

  const submit = () => {
    const next: FieldErrors = {};
    const name = person.trim();
    if (name.length === 0 || name.length > PERSON_MAX) next.person = t('form.errors.person');
    if (amountText === null || !Amount.safeParse(amountText).success) {
      next.amount = t('form.errors.amount');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || startDate > today) {
      next.startDate = t('form.errors.startDate');
    }
    const rateText = interest.trim().replace(',', '.');
    if (rateText !== '' && !InterestRate.safeParse(rateText).success) {
      next.interest = t('form.errors.interest');
    }
    if (account !== undefined && declared.needed && declared.rate === null) {
      next.rate = t('form.errors.rate');
    }
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0 || amountText === null) return;

    const trimmedNote = note.trim();
    save.mutate({
      id,
      direction,
      person: name,
      principal: amountText,
      currencyCode: currency,
      startDate,
      ...(dueDate === '' ? {} : { dueDate }),
      ...(trimmedNote === '' ? {} : { note: trimmedNote }),
      ...(rateText === '' ? {} : { interest: { rate: rateText, period } }),
      ...(account === undefined
        ? {}
        : {
            initialMovement: {
              transactionId,
              accountId: account.id,
              ...(declared.needed && declared.rate !== null ? { declaredRate: declared.rate } : {}),
            },
          }),
    });
  };

  return (
    <form
      noValidate
      className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div role="radiogroup" aria-label={t('form.direction.label')} className="flex gap-6">
        {(['i_owe', 'owed_to_me'] as const).map((option) => (
          <label key={option} className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name="debt-direction"
              value={option}
              checked={direction === option}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              onChange={() => {
                setDirection(option);
              }}
            />
            {t(`form.direction.${option}`)}
          </label>
        ))}
      </div>
      <PersonField value={person} onChange={setPerson} error={errors.person} />
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="debt-amount">{t('form.amount')}</Label>
          <Input
            id="debt-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 tabular-nums"
            aria-invalid={errors.amount !== undefined || undefined}
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </div>
        <div className="flex w-28 flex-col gap-2">
          <Label htmlFor="debt-currency">{t('form.currency')}</Label>
          <FieldSelect
            id="debt-currency"
            value={currency}
            onChange={(event) => {
              setChosenCurrency(event.target.value);
              setTypedRate(null);
            }}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </FieldSelect>
        </div>
      </div>
      {errors.amount !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {errors.amount}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="debt-start-date">{t('form.startDate')}</Label>
        <Input
          id="debt-start-date"
          type="date"
          className="h-11"
          aria-invalid={errors.startDate !== undefined || undefined}
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
          }}
        />
        {errors.startDate !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {errors.startDate}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="debt-due-date">{t('form.dueDate')}</Label>
        <Input
          id="debt-due-date"
          type="date"
          className="h-11"
          value={dueDate}
          onChange={(event) => {
            setDueDate(event.target.value);
          }}
        />
      </div>
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="debt-interest">{t('form.interest')}</Label>
          <Input
            id="debt-interest"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 tabular-nums"
            aria-invalid={errors.interest !== undefined || undefined}
            value={interest}
            onChange={(event) => {
              setInterest(event.target.value);
            }}
          />
        </div>
        <div className="flex w-36 flex-col gap-2">
          <Label htmlFor="debt-period">{t('form.period')}</Label>
          <FieldSelect
            id="debt-period"
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value === 'yearly' ? 'yearly' : 'monthly');
            }}
          >
            <option value="monthly">{t('form.periods.monthly')}</option>
            <option value="yearly">{t('form.periods.yearly')}</option>
          </FieldSelect>
        </div>
      </div>
      {errors.interest !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {errors.interest}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="debt-note">{t('form.note')}</Label>
        <Input
          id="debt-note"
          autoComplete="off"
          maxLength={NOTE_MAX}
          className="h-11"
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="debt-account">{t('form.account')}</Label>
        <FieldSelect
          id="debt-account"
          aria-describedby="debt-account-hint"
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
            setTypedRate(null);
          }}
        >
          <option value="">{t('form.noAccount')}</option>
          {(accounts.data?.items ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {`${item.name} · ${item.currencyCode}`}
            </option>
          ))}
        </FieldSelect>
        <p id="debt-account-hint" className="text-sm text-muted-foreground">
          {t('form.accountHint')}
        </p>
      </div>
      {account !== undefined && declared.needed && (
        <ExchangeField
          id="debt-rate"
          scope="form"
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
      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <DialogFooter className="gap-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {save.isPending ? t('form.saving') : t('form.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
