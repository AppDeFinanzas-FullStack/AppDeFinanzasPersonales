import type { DecisionInput } from '@finanzas/contracts';
import { moneyEquals, parseMoney, toMoneyString } from '@finanzas/domain';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseSignedAmount } from '@/features/accounts/components/account-form';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useGoals } from '@/features/goals/hooks/use-goals';
import { useFormatters } from '@/features/settings/hooks/use-settings';

const SELECT =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 text-base disabled:cursor-not-allowed disabled:opacity-50';

type SurplusDecision = Extract<DecisionInput, { result: 'surplus' }>;

/** A typed amount: empty counts as 0, `null` when it is not a valid non-negative amount. */
function amountOf(raw: string): string | null {
  if (raw.trim() === '') return '0.00';
  const amount = parseSignedAmount(raw);
  return amount === null || amount.startsWith('-') ? null : amount;
}

/**
 * Splits the surplus of a closed period between Arrastrar, Enviar a meta and Descartar with an
 * exact sum, shown live (RF-M11-08). Enviar a meta asks for the goal and the account of the earmark,
 * or a real transfer when the goal has a dedicated account (RF-M11-09); archived goals are not
 * offered (EC-M11-03).
 */
export function SurplusSplitForm({
  result,
  symbol,
  canCarry,
  canSendToGoal,
  defaultAction,
  pending,
  onSubmit,
}: {
  result: string;
  symbol: string;
  canCarry: boolean;
  canSendToGoal: boolean;
  defaultAction: 'discard' | 'carry';
  pending: boolean;
  onSubmit: (input: SurplusDecision) => void;
}) {
  const { t } = useTranslation('budgets');
  const formatters = useFormatters();
  const fieldId = useId();
  const goals = useGoals();
  const accounts = useAccounts('active');
  const carryFirst = canCarry && defaultAction === 'carry';
  const [carry, setCarry] = useState(carryFirst ? result : '');
  const [toGoal, setToGoal] = useState('');
  const [discard, setDiscard] = useState(carryFirst ? '' : result);
  const [goalId, setGoalId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [transfer, setTransfer] = useState(false);

  const goalOptions = (goals.data?.items ?? []).filter((goal) => goal.status !== 'archived');
  const accountOptions = accounts.data?.items ?? [];
  const goal = goalOptions.find((option) => option.id === goalId);
  const canTransfer =
    goal?.dedicatedAccount !== undefined && goal.dedicatedAccount.id !== accountId;

  const carryAmount = canCarry ? amountOf(carry) : '0.00';
  const goalAmount = canSendToGoal ? amountOf(toGoal) : '0.00';
  const discardAmount = amountOf(discard);
  const valid = carryAmount !== null && goalAmount !== null && discardAmount !== null;
  const remaining = valid
    ? parseMoney(result)
        .minus(parseMoney(carryAmount))
        .minus(parseMoney(goalAmount))
        .minus(parseMoney(discardAmount))
    : null;
  const exact = remaining !== null && moneyEquals(remaining, parseMoney('0'));
  const sendsToGoal = goalAmount !== null && !moneyEquals(parseMoney(goalAmount), parseMoney('0'));
  const goalReady = !sendsToGoal || (goal !== undefined && accountId !== '');
  const ready = valid && exact && goalReady && !pending;

  const submit = () => {
    if (!ready || carryAmount === null || goalAmount === null || discardAmount === null) return;
    onSubmit({
      result: 'surplus',
      carry: carryAmount,
      discard: discardAmount,
      ...(sendsToGoal
        ? {
            toGoal: {
              goalId,
              accountId,
              amount: goalAmount,
              mode: transfer && canTransfer ? 'transfer' : 'earmark',
            },
          }
        : {}),
    });
  };

  const amountField = (
    key: 'carry' | 'toGoal' | 'discard',
    value: string,
    onChange: (value: string) => void,
  ) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${fieldId}-${key}`}>{t(`close.${key}`)}</Label>
      <Input
        id={`${fieldId}-${key}`}
        inputMode="decimal"
        autoComplete="off"
        className="h-11 text-right tabular-nums"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {canCarry && amountField('carry', carry, setCarry)}
      {canSendToGoal && (
        <>
          {amountField('toGoal', toGoal, setToGoal)}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${fieldId}-goal`}>{t('close.goal')}</Label>
            <select
              id={`${fieldId}-goal`}
              className={SELECT}
              value={goalId}
              onChange={(event) => {
                setGoalId(event.target.value);
              }}
            >
              <option value="">{t('close.chooseGoal')}</option>
              {goalOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${fieldId}-account`}>{t('close.account')}</Label>
            <select
              id={`${fieldId}-account`}
              className={SELECT}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              <option value="">{t('close.chooseAccount')}</option>
              {accountOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          {canTransfer && goal.dedicatedAccount !== undefined && (
            <label className="flex min-h-11 items-center gap-2 text-base">
              <input
                type="checkbox"
                className="size-4"
                checked={transfer}
                onChange={(event) => {
                  setTransfer(event.target.checked);
                }}
              />
              {t('close.transfer', { name: goal.dedicatedAccount.name })}
            </label>
          )}
        </>
      )}
      {amountField('discard', discard, setDiscard)}
      <p role="status" className="text-sm text-muted-foreground tabular-nums">
        {remaining === null
          ? t('close.invalid')
          : exact
            ? t('close.exact')
            : remaining.isNegative()
              ? t('close.over', {
                  amount: formatters.money(toMoneyString(remaining.abs()), symbol),
                })
              : t('close.remaining', {
                  amount: formatters.money(toMoneyString(remaining), symbol),
                })}
      </p>
      {exact && !goalReady && (
        <p className="text-sm text-muted-foreground">{t('close.goalMissing')}</p>
      )}
      <Button type="submit" className="h-11" disabled={!ready}>
        {t('close.submit')}
      </Button>
    </form>
  );
}
