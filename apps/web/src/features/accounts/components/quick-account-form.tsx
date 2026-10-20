import { AccountDto, AccountType, CreateAccountInput } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, todayFor } from '@finanzas/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/features/auth/hooks/use-me';
import { call, type Endpoint } from '@/lib/api-client';

import {
  applyApiError,
  checkName,
  DEFAULT_COLOR,
  DEFAULT_ICON,
  FieldSelect,
  initialBalanceOf,
  useCurrencyCodes,
  type AccountFormValues,
} from './account-form';
import { CardFields } from './card-fields';

const createAccountEndpoint: Endpoint<CreateAccountInput, AccountDto> = {
  method: 'POST',
  path: '/api/accounts',
  input: CreateAccountInput,
  output: AccountDto,
};

type FieldErrors = Partial<Record<keyof AccountFormValues, string>>;

/**
 * The minimal account form: name, type, currency and balance (EC-M7-01, EC-M4-05). It is reused
 * where there is no active account, like Registrar and the Inicio; the rest takes its defaults.
 */
export function QuickAccountForm({ onCreated }: { onCreated?: (account: AccountDto) => void }) {
  const { t } = useTranslation('accounts');
  const me = useMe();
  const queryClient = useQueryClient();
  const currencies = useCurrencyCodes();
  const [id, setId] = useState(() => uuidv7());
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<AccountFormValues>({
    defaultValues: {
      type: 'cash',
      name: '',
      currencyCode: 'BOB',
      initialBalance: '',
      initialBalanceDate: '',
      color: DEFAULT_COLOR,
      icon: DEFAULT_ICON.cash,
      cardBalanceKind: 'debt',
      cutDay: '',
      payDay: '',
      limit: '',
    },
  });
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = form;
  const type = useWatch({ control: form.control, name: 'type' });

  const create = useMutation({
    mutationFn: (input: CreateAccountInput) => call(createAccountEndpoint, input),
    onSuccess: async (account) => {
      reset();
      setId(uuidv7());
      // Every list of accounts, Registrar and the Inicio included, sees the new one.
      await queryClient.invalidateQueries();
      onCreated?.(account);
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
    const initialBalance = initialBalanceOf(values, t, fieldErrors);
    for (const [field, message] of Object.entries(fieldErrors)) {
      setError(field as keyof AccountFormValues, { message });
    }
    if (initialBalance === null || Object.keys(fieldErrors).length > 0) return;
    create.mutate({
      id,
      type: values.type,
      name,
      currencyCode: values.currencyCode,
      initialBalance,
      initialBalanceDate: todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date()),
      color: DEFAULT_COLOR,
      icon: DEFAULT_ICON[values.type],
      ...(values.type === 'credit_card'
        ? { card: { cutDay: null, payDay: null, limit: null } }
        : {}),
    });
  });

  return (
    <form
      noValidate
      aria-labelledby="quick-account-title"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      <h2 id="quick-account-title" className="text-lg font-semibold">
        {t('quick.title')}
      </h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="quick-account-name">{t('form.name')}</Label>
        <Input
          id="quick-account-name"
          autoComplete="off"
          maxLength={40}
          className="h-11"
          aria-invalid={errors.name !== undefined}
          {...register('name')}
        />
        {errors.name?.message !== undefined && (
          <p className="text-sm text-destructive">{errors.name.message}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="quick-account-type">{t('form.type')}</Label>
          <FieldSelect id="quick-account-type" {...register('type')}>
            {AccountType.options.map((option) => (
              <option key={option} value={option}>
                {t(`typeNames.${option}`)}
              </option>
            ))}
          </FieldSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="quick-account-currency">{t('form.currency')}</Label>
          <FieldSelect id="quick-account-currency" {...register('currencyCode')}>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </FieldSelect>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="quick-account-balance">
          {type === 'credit_card' ? t('form.cardAmount') : t('quick.balance')}
        </Label>
        <Input
          id="quick-account-balance"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          className="h-11 tabular-nums"
          aria-invalid={errors.initialBalance !== undefined}
          {...register('initialBalance')}
        />
        {errors.initialBalance?.message !== undefined && (
          <p className="text-sm text-destructive">{errors.initialBalance.message}</p>
        )}
      </div>
      {type === 'credit_card' && <CardFields form={form} showBalanceKind showDetails={false} />}
      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <Button type="submit" className="h-11" disabled={create.isPending || me.data === undefined}>
        {create.isPending ? t('form.saving') : t('quick.submit')}
      </Button>
    </form>
  );
}
