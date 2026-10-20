import {
  AccountDto,
  AccountType,
  CreateAccountInput,
  PALETTE,
  PaletteKey,
  UpdateAccountInput,
  type IconKey,
} from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, parseAmountInput, todayFor } from '@finanzas/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  Briefcase,
  Building2,
  Coins,
  CreditCard,
  HandCoins,
  Landmark,
  PiggyBank,
  Shield,
  Smartphone,
  Star,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/features/auth/hooks/use-me';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { listCurrenciesEndpoint } from '../api';
import { ACCOUNTS_KEY, useCurrencySymbol } from '../hooks/use-accounts';

import { CardFields } from './card-fields';

const createAccountEndpoint: Endpoint<CreateAccountInput, AccountDto> = {
  method: 'POST',
  path: '/api/accounts',
  input: CreateAccountInput,
  output: AccountDto,
};

function updateAccountEndpoint(id: string): Endpoint<UpdateAccountInput, AccountDto> {
  return {
    method: 'PATCH',
    path: `/api/accounts/${encodeURIComponent(id)}`,
    input: UpdateAccountInput,
    output: AccountDto,
  };
}

/** Icons of the catalog that suit an account; the label of each one is in `accounts.json`. */
export const ACCOUNT_ICONS: Partial<Record<IconKey, LucideIcon>> = {
  wallet: Wallet,
  banknote: Banknote,
  landmark: Landmark,
  'piggy-bank': PiggyBank,
  'credit-card': CreditCard,
  smartphone: Smartphone,
  coins: Coins,
  'hand-coins': HandCoins,
  briefcase: Briefcase,
  'building-2': Building2,
  shield: Shield,
  star: Star,
};

/** The icon a new account of each type starts with. */
export const DEFAULT_ICON: Record<AccountType, IconKey> = {
  cash: 'banknote',
  bank: 'landmark',
  ewallet: 'smartphone',
  credit_card: 'credit-card',
  savings: 'piggy-bank',
  other: 'wallet',
};

export const DEFAULT_COLOR: PaletteKey = 'teal';

const SYSTEM_CURRENCIES = ['BOB', 'USD'] as const;

/** Every field as the user types it; amounts are parsed only on submit (ADR-03). */
export const AccountFormValues = z.object({
  type: AccountType,
  name: z.string(),
  currencyCode: z.string(),
  initialBalance: z.string(),
  initialBalanceDate: z.string(),
  color: PaletteKey,
  icon: z.string(),
  cardBalanceKind: z.enum(['debt', 'credit']),
  cutDay: z.string(),
  payDay: z.string(),
  limit: z.string(),
});
export type AccountFormValues = z.infer<typeof AccountFormValues>;

const DraftSchema = AccountFormValues.partial();

const MAX_ABS = parseAmountInput('999999999.99');
const NON_NEGATIVE: readonly AccountType[] = ['cash', 'ewallet'];
const NAME_MAX = 40;
const ZERO = '0.00';

type FieldErrors = Partial<Record<keyof AccountFormValues, string>>;

/**
 * An amount as decimal text, with an optional leading minus (RF-M4-02); `null` when it is not
 * one, or when it goes beyond 999.999.999,99 in absolute value.
 */
export function parseSignedAmount(raw: string): string | null {
  const text = raw.trim().replace('−', '-');
  const negative = text.startsWith('-');
  const amount = parseAmountInput(negative ? text.slice(1).trim() : text);
  if (amount === null || MAX_ABS === null || amount.gt(MAX_ABS)) return null;
  const value = amount.toFixed(2);
  return negative && !amount.isZero() ? `-${value}` : value;
}

/** A day of the month typed by the user, or `null` when it is left empty. */
function parseDay(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === '') return null;
  const day = Number(text);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : undefined;
}

/** The card fields of the form, or the errors that keep them from being sent. */
export function cardOf(
  values: AccountFormValues,
  t: (key: string) => string,
  errors: FieldErrors,
): CreateAccountInput['card'] {
  const cutDay = parseDay(values.cutDay);
  const payDay = parseDay(values.payDay);
  if (cutDay === undefined) errors.cutDay = t('form.errors.day');
  if (payDay === undefined) errors.payDay = t('form.errors.day');
  let limit: string | null = null;
  if (values.limit.trim() !== '') {
    const parsed = parseSignedAmount(values.limit);
    if (parsed === null || parsed.startsWith('-') || parsed === ZERO) {
      errors.limit = t('form.errors.limit');
    } else {
      limit = parsed;
    }
  }
  return { cutDay: cutDay ?? null, payDay: payDay ?? null, limit };
}

/**
 * The initial balance as the API takes it, checked against the type (RF-M4-02): a card gives its
 * current debt or its balance in favor.
 */
export function initialBalanceOf(
  values: AccountFormValues,
  t: (key: string) => string,
  errors: FieldErrors,
): CreateAccountInput['initialBalance'] | null {
  const raw = values.initialBalance.trim() === '' ? '0' : values.initialBalance;
  const amount = parseSignedAmount(raw);
  if (amount === null) {
    errors.initialBalance = t('form.errors.amount');
    return null;
  }
  if (values.type === 'credit_card') {
    if (amount.startsWith('-')) {
      errors.initialBalance = t('form.errors.cardAmount');
      return null;
    }
    return { kind: values.cardBalanceKind, amount };
  }
  if (NON_NEGATIVE.includes(values.type) && amount.startsWith('-')) {
    errors.initialBalance = t('form.errors.negative');
    return null;
  }
  return amount;
}

export function checkName(
  values: AccountFormValues,
  t: (key: string) => string,
  errors: FieldErrors,
) {
  const name = values.name.trim();
  if (name.length === 0 || name.length > NAME_MAX) errors.name = t('form.errors.name');
  return name;
}

/** Codes the user can pick: BOB, USD and the added currencies (RF-M3-02). */
export function useCurrencyCodes(): string[] {
  const { data } = useQuery({
    queryKey: ['currencies'],
    queryFn: ({ signal }) => call(listCurrenciesEndpoint, undefined, { signal }),
  });
  return [...SYSTEM_CURRENCIES, ...(data?.items.map((currency) => currency.code) ?? [])];
}

/** Puts the API error on the field it belongs to; anything else goes to the form. */
export function applyApiError(
  error: unknown,
  t: (key: string) => string,
): { field?: keyof AccountFormValues; message: string } {
  if (error instanceof ApiError && error.code === 'NAME_TAKEN') {
    return { field: 'name', message: t('form.errors.nameTaken') };
  }
  return { message: messageForError(error instanceof ApiError ? error : { code: '' }) };
}

const selectClass =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 md:text-sm';

/** A native select with the look of the inputs. */
export function FieldSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={selectClass} />;
}

function ColorPicker({ form }: { form: UseFormReturn<AccountFormValues> }) {
  const { t } = useTranslation('accounts');
  const selected = useWatch({ control: form.control, name: 'color' });
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{t('form.color')}</legend>
      <div className="flex flex-wrap gap-2">
        {PaletteKey.options.map((key) => {
          const swatch = {
            '--swatch-light': PALETTE[key].light,
            '--swatch-dark': PALETTE[key].dark,
          } as CSSProperties;
          return (
            <label
              key={key}
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border border-border has-[:checked]:ring-2 has-[:checked]:ring-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            >
              <input
                type="radio"
                value={key}
                className="sr-only"
                checked={selected === key}
                onChange={() => {
                  form.setValue('color', key, { shouldDirty: true });
                }}
              />
              <span
                aria-hidden
                style={swatch}
                className="h-6 w-6 rounded-full bg-[var(--swatch-light)] dark:bg-[var(--swatch-dark)]"
              />
              <span className="sr-only">{t(`colors.${key}`)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function IconPicker({ form }: { form: UseFormReturn<AccountFormValues> }) {
  const { t } = useTranslation('accounts');
  const selected = useWatch({ control: form.control, name: 'icon' });
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{t('form.icon')}</legend>
      <div className="flex flex-wrap gap-2">
        {Object.entries(ACCOUNT_ICONS).map(([key, Icon]) => (
          <label
            key={key}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border border-border has-[:checked]:ring-2 has-[:checked]:ring-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              type="radio"
              value={key}
              className="sr-only"
              checked={selected === key}
              onChange={() => {
                form.setValue('icon', key, { shouldDirty: true });
              }}
            />
            <Icon aria-hidden className="h-5 w-5" />
            <span className="sr-only">{t(`icons.${key}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Creates or edits an account, with a draft (plan §4.4.4). The initial balance and its date are
 * fixed once created: a difference is corrected with "Ajustar saldo" (RF-M4-07, EC-M4-02).
 */
export function AccountForm({
  account,
  onDone,
}: {
  account?: AccountDto;
  onDone: (account: AccountDto) => void;
}) {
  const { t } = useTranslation('accounts');
  const me = useMe();
  const queryClient = useQueryClient();
  const currencies = useCurrencyCodes();
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const [id] = useState(() => account?.id ?? uuidv7());
  const [formError, setFormError] = useState<string | null>(null);
  const editing = account !== undefined;

  const form = useForm<AccountFormValues>({
    defaultValues: {
      type: account?.type ?? 'cash',
      name: account?.name ?? '',
      currencyCode: account?.currencyCode ?? 'BOB',
      initialBalance: account?.initialBalance ?? '',
      initialBalanceDate: account?.initialBalanceDate ?? '',
      color: account?.color ?? DEFAULT_COLOR,
      icon: account?.icon ?? DEFAULT_ICON.cash,
      cardBalanceKind: 'debt',
      cutDay: account?.card?.cutDay?.toString() ?? '',
      payDay: account?.card?.payDay?.toString() ?? '',
      limit: account?.card?.limit ?? '',
    },
  });
  const draft = useDraft(editing ? `account:${id}` : 'account:new', form, {
    userId: me.data?.id ?? '',
    schema: DraftSchema,
  });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = form;
  const type = useWatch({ control: form.control, name: 'type' });

  const save = useMutation({
    mutationFn: (input: CreateAccountInput | UpdateAccountInput) =>
      editing
        ? call(updateAccountEndpoint(id), input)
        : call(createAccountEndpoint, input as CreateAccountInput),
    onSuccess: async (saved) => {
      draft.clear();
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      onDone(saved);
    },
    onError: (error) => {
      const applied = applyApiError(error, t);
      if (applied.field === undefined) setFormError(applied.message);
      else setError(applied.field, { message: applied.message });
    },
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    const fieldErrors: FieldErrors = {};
    const name = checkName(values, t, fieldErrors);
    const card = values.type === 'credit_card' ? cardOf(values, t, fieldErrors) : undefined;
    const common = {
      name,
      type: values.type,
      currencyCode: values.currencyCode,
      color: values.color,
      icon: values.icon as IconKey,
      ...(card === undefined ? {} : { card }),
    };
    if (editing) {
      for (const [field, message] of Object.entries(fieldErrors)) {
        setError(field as keyof AccountFormValues, { message });
      }
      if (Object.keys(fieldErrors).length === 0) save.mutate(common);
      return;
    }
    const initialBalance = initialBalanceOf(values, t, fieldErrors);
    const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());
    for (const [field, message] of Object.entries(fieldErrors)) {
      setError(field as keyof AccountFormValues, { message });
    }
    if (initialBalance === null || Object.keys(fieldErrors).length > 0) return;
    save.mutate({
      ...common,
      id,
      initialBalance,
      initialBalanceDate: values.initialBalanceDate === '' ? today : values.initialBalanceDate,
    });
  });

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
          {t('form.draftIssues')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="account-type">{t('form.type')}</Label>
        <FieldSelect
          id="account-type"
          {...register('type', {
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              if (!editing && !form.getFieldState('icon').isDirty) {
                const next = AccountType.safeParse(event.target.value);
                if (next.success) form.setValue('icon', DEFAULT_ICON[next.data]);
              }
            },
          })}
        >
          {AccountType.options.map((option) => (
            <option key={option} value={option}>
              {t(`typeNames.${option}`)}
            </option>
          ))}
        </FieldSelect>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="account-name">{t('form.name')}</Label>
        <Input
          id="account-name"
          autoComplete="off"
          maxLength={NAME_MAX}
          className="h-11"
          aria-invalid={errors.name !== undefined}
          {...register('name')}
        />
        {errors.name?.message !== undefined && (
          <p className="text-sm text-destructive">{errors.name.message}</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="account-currency">{t('form.currency')}</Label>
        <FieldSelect id="account-currency" {...register('currencyCode')}>
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </FieldSelect>
        {editing && <p className="text-sm text-muted-foreground">{t('form.currencyHint')}</p>}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('form.initialBalance')}</span>
          <p className="tabular-nums">
            {formatters.money(account.initialBalance, symbolOf(account.currencyCode))}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('form.initialBalanceFixed')}{' '}
            <Link to={`/cuentas/${account.id}?ajustar=1`} className="text-primary underline">
              {t('form.adjust')}
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-initial">
              {type === 'credit_card' ? t('form.cardAmount') : t('form.initialBalance')}
            </Label>
            <Input
              id="account-initial"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              className="h-11 tabular-nums"
              aria-invalid={errors.initialBalance !== undefined}
              aria-describedby="account-initial-hint"
              {...register('initialBalance')}
            />
            <p id="account-initial-hint" className="text-sm text-muted-foreground">
              {t(`form.initialHint.${type}`)}
            </p>
            {errors.initialBalance?.message !== undefined && (
              <p className="text-sm text-destructive">{errors.initialBalance.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-initial-date">{t('form.initialBalanceDate')}</Label>
            <Input
              id="account-initial-date"
              type="date"
              className="h-11"
              aria-describedby="account-initial-date-hint"
              {...register('initialBalanceDate')}
            />
            <p id="account-initial-date-hint" className="text-sm text-muted-foreground">
              {t('form.initialBalanceDateHint')}
            </p>
          </div>
        </>
      )}
      {type === 'credit_card' && <CardFields form={form} showBalanceKind={!editing} />}
      <ColorPicker form={form} />
      <IconPicker form={form} />
      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <Button type="submit" className="h-11" disabled={save.isPending || me.data === undefined}>
        {save.isPending ? t('form.saving') : editing ? t('form.saveChanges') : t('form.create')}
      </Button>
    </form>
  );
}
