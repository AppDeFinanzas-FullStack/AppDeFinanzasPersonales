import type {
  CategoryNode,
  CreateRuleInput,
  RuleEnd,
  RuleFrequency,
  RuleKind,
  RuleMode,
} from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, parseAmountInput, todayFor } from '@finanzas/domain';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCategories } from '@/features/categories/hooks/use-categories';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { RECURRING_KEY } from '../hooks/use-recurring';

const SELECT_CLASS = 'flex h-11 w-full rounded-md border border-input bg-background px-3 text-base';
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
type FrequencyType = (typeof FREQUENCIES)[number];
type EndType = RuleEnd['type'];
type Field =
  | 'name'
  | 'amount'
  | 'account'
  | 'destAccount'
  | 'category'
  | 'note'
  | 'day'
  | 'start'
  | 'endDate'
  | 'endCount';

const createRuleEndpoint: Endpoint<CreateRuleInput, unknown> = {
  method: 'POST',
  path: '/api/recurring',
  input: z.custom<CreateRuleInput>((value) => typeof value === 'object' && value !== null),
  output: z.unknown(),
};

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function positiveDecimal(raw: string): string | null {
  const value = parseAmountInput(raw.trim());
  return value === null || value.lte(0) ? null : value.toFixed(2);
}

function parts(date: string): { weekday: number; month: number; day: number } {
  const at = new Date(`${date}T00:00:00Z`);
  return { weekday: at.getUTCDay(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/**
 * Creates a recurring rule (RF-M14-01): the start is today or later (RF-M14-03) and the amount is
 * required only in automatic mode (RF-M14-14).
 */
export function RuleForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('recurring');
  const me = useMe();
  const queryClient = useQueryClient();
  const [today] = useState(() => todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date()));
  const [ruleId] = useState(() => uuidv7());
  const initial = parts(today);

  const [kind, setKind] = useState<RuleKind>('expense');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [destAccountId, setDestAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [note, setNote] = useState('');
  const [frequency, setFrequency] = useState<FrequencyType>('monthly');
  const [weekday, setWeekday] = useState(initial.weekday);
  const [month, setMonth] = useState(initial.month);
  const [day, setDay] = useState(String(initial.day));
  const [start, setStart] = useState(today);
  const [endType, setEndType] = useState<EndType>('none');
  const [endDate, setEndDate] = useState('');
  const [endCount, setEndCount] = useState('');
  const [mode, setMode] = useState<RuleMode>('confirm');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  const accounts = useAccounts('active');
  const categories = useCategories({
    kind: kind === 'income' ? 'income' : 'expense',
    status: 'active',
  });
  const activeAccounts = accounts.data?.items ?? [];
  const activeCategories = flatten(categories.data ?? []).filter(
    (category) => category.status === 'active',
  );
  const effectiveAccount = accountId || activeAccounts[0]?.id || '';
  const effectiveCategory = categoryId || activeCategories[0]?.id || '';
  const ready =
    accounts.data !== undefined && (kind === 'transfer' || categories.data !== undefined);

  const create = useMutation({
    mutationFn: (input: CreateRuleInput) => call(createRuleEndpoint, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: RECURRING_KEY });
      onClose();
    },
  });

  const submit = () => {
    const next: Partial<Record<Field, string>> = {};
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 40) next.name = t('form.nameError');

    let parsedAmount: string | undefined;
    if (amount.trim() === '') {
      if (mode === 'auto') next.amount = t('form.amountRequired');
    } else {
      const value = positiveDecimal(amount);
      if (value === null) next.amount = t('form.amountError');
      else parsedAmount = value;
    }

    if (effectiveAccount === '') next.account = t('form.accountError');
    if (kind === 'transfer') {
      if (destAccountId === '' || destAccountId === effectiveAccount) {
        next.destAccount = t('form.destAccountError');
      }
    } else if (effectiveCategory === '') {
      next.category = t('form.categoryError');
    }
    if (note.length > 200) next.note = t('form.noteError');
    if (!LOCAL_DATE.test(start) || start < today) next.start = t('form.startError');

    const dayNumber = Number(day);
    const needsDay = frequency === 'monthly' || frequency === 'yearly';
    if (needsDay && !(Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 31)) {
      next.day = t('form.dayError');
    }

    let end: RuleEnd = { type: 'none' };
    if (endType === 'until') {
      if (!LOCAL_DATE.test(endDate) || endDate < start) next.endDate = t('form.endDateError');
      else end = { type: 'until', date: endDate };
    } else if (endType === 'count') {
      const count = Number(endCount);
      if (!/^\d+$/.test(endCount) || count < 1 || count > 999) {
        next.endCount = t('form.endCountError');
      } else {
        end = { type: 'count', count };
      }
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    let rule: RuleFrequency;
    if (frequency === 'weekly') rule = { type: 'weekly', weekday };
    else if (frequency === 'monthly') rule = { type: 'monthly', day: dayNumber };
    else if (frequency === 'yearly') rule = { type: 'yearly', month, day: dayNumber };
    else rule = { type: 'daily' };

    const input: CreateRuleInput = {
      id: ruleId,
      name: trimmedName,
      kind,
      accountId: effectiveAccount,
      frequency: rule,
      startDate: start,
      end,
      mode,
    };
    if (parsedAmount !== undefined) input.amount = parsedAmount;
    if (kind === 'transfer') input.destAccountId = destAccountId;
    else input.categoryId = effectiveCategory;
    if (note.trim() !== '') input.note = note.trim();
    create.mutate(input);
  };

  const error = (field: Field) =>
    errors[field] === undefined ? null : (
      <p className="text-sm text-destructive">{errors[field]}</p>
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={t('form.close')} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('form.title')}</DialogTitle>
          <DialogDescription>{t('form.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-kind">{t('form.kind')}</Label>
            <select
              id="rule-kind"
              className={SELECT_CLASS}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as RuleKind);
                setCategoryId('');
              }}
            >
              {(['expense', 'income', 'transfer'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`form.kinds.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-name">{t('form.name')}</Label>
            <Input
              id="rule-name"
              className="h-11"
              maxLength={60}
              value={name}
              aria-invalid={errors.name !== undefined}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            {error('name')}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-amount">{t('form.amount')}</Label>
            <Input
              id="rule-amount"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              value={amount}
              aria-invalid={errors.amount !== undefined}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
            {mode === 'confirm' && (
              <p className="text-sm text-muted-foreground">{t('form.amountHint')}</p>
            )}
            {error('amount')}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-account">{t('form.account')}</Label>
            <select
              id="rule-account"
              className={SELECT_CLASS}
              value={effectiveAccount}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              {activeAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
            {error('account')}
          </div>
          {kind === 'transfer' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-dest-account">{t('form.destAccount')}</Label>
              <select
                id="rule-dest-account"
                className={SELECT_CLASS}
                value={destAccountId}
                onChange={(event) => {
                  setDestAccountId(event.target.value);
                }}
              >
                <option value="">{t('form.choose')}</option>
                {activeAccounts
                  .filter((account) => account.id !== effectiveAccount)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
              </select>
              {error('destAccount')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-category">{t('form.category')}</Label>
              <select
                id="rule-category"
                className={SELECT_CLASS}
                value={effectiveCategory}
                onChange={(event) => {
                  setCategoryId(event.target.value);
                }}
              >
                {activeCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              {error('category')}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-note">{t('form.note')}</Label>
            <Input
              id="rule-note"
              className="h-11"
              value={note}
              aria-invalid={errors.note !== undefined}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
            {error('note')}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-frequency">{t('form.frequency')}</Label>
            <Select
              value={frequency}
              onValueChange={(value) => {
                setFrequency(value as FrequencyType);
              }}
            >
              <SelectTrigger id="rule-frequency" className="h-11 text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`form.frequencies.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {frequency === 'weekly' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-weekday">{t('form.weekday')}</Label>
              <select
                id="rule-weekday"
                className={SELECT_CLASS}
                value={weekday}
                onChange={(event) => {
                  setWeekday(Number(event.target.value));
                }}
              >
                {(t('form.weekdays', { returnObjects: true }) as string[]).map((label, index) => (
                  <option key={label} value={index}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {frequency === 'yearly' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-month">{t('form.month')}</Label>
              <select
                id="rule-month"
                className={SELECT_CLASS}
                value={month}
                onChange={(event) => {
                  setMonth(Number(event.target.value));
                }}
              >
                {(t('form.months', { returnObjects: true }) as string[]).map((label, index) => (
                  <option key={label} value={index + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {(frequency === 'monthly' || frequency === 'yearly') && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-day">{t('form.day')}</Label>
              <Input
                id="rule-day"
                inputMode="numeric"
                className="h-11 tabular-nums"
                value={day}
                aria-invalid={errors.day !== undefined}
                onChange={(event) => {
                  setDay(event.target.value);
                }}
              />
              {error('day')}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-start">{t('form.start')}</Label>
            <Input
              id="rule-start"
              type="date"
              min={today}
              className="h-11 tabular-nums"
              value={start}
              aria-invalid={errors.start !== undefined}
              onChange={(event) => {
                setStart(event.target.value);
              }}
            />
            {error('start')}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-end">{t('form.end')}</Label>
            <select
              id="rule-end"
              className={SELECT_CLASS}
              value={endType}
              onChange={(event) => {
                setEndType(event.target.value as EndType);
              }}
            >
              {(['none', 'until', 'count'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`form.ends.${value}`)}
                </option>
              ))}
            </select>
          </div>
          {endType === 'until' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-end-date">{t('form.endDate')}</Label>
              <Input
                id="rule-end-date"
                type="date"
                min={start}
                className="h-11 tabular-nums"
                value={endDate}
                aria-invalid={errors.endDate !== undefined}
                onChange={(event) => {
                  setEndDate(event.target.value);
                }}
              />
              {error('endDate')}
            </div>
          )}
          {endType === 'count' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule-end-count">{t('form.endCount')}</Label>
              <Input
                id="rule-end-count"
                inputMode="numeric"
                className="h-11 tabular-nums"
                value={endCount}
                aria-invalid={errors.endCount !== undefined}
                onChange={(event) => {
                  setEndCount(event.target.value);
                }}
              />
              {error('endCount')}
            </div>
          )}
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{t('form.mode')}</legend>
            {(['confirm', 'auto'] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="rule-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => {
                    setMode(value);
                  }}
                />
                {t(`rules.mode.${value}`)}
              </label>
            ))}
          </fieldset>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {messageForError(create.error instanceof ApiError ? create.error : { code: '' })}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={onClose}>
              {t('form.cancel')}
            </Button>
            <Button type="submit" className="h-11" disabled={!ready || create.isPending}>
              {t('form.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
