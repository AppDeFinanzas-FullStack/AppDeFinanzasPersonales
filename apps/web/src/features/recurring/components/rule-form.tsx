import {
  RuleKind,
  RuleMode,
  type CategoryNode,
  type CreateRuleInput,
  type RuleEnd,
  type RuleFrequency,
} from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, parseAmountInput, todayFor } from '@finanzas/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
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
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { RECURRING_KEY } from '../hooks/use-recurring';

const SELECT_CLASS = 'flex h-11 w-full rounded-md border border-input bg-background px-3 text-base';
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 40;
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
type FrequencyType = (typeof FREQUENCIES)[number];
const END_TYPES = ['none', 'until', 'count'] as const;
type EndType = RuleEnd['type'];

const RuleFormValues = z.object({
  kind: RuleKind,
  name: z.string(),
  amount: z.string(),
  accountId: z.string(),
  destAccountId: z.string(),
  categoryId: z.string(),
  note: z.string(),
  frequency: z.enum(FREQUENCIES),
  weekday: z.number(),
  month: z.number(),
  day: z.string(),
  start: z.string(),
  endType: z.enum(END_TYPES),
  endDate: z.string(),
  endCount: z.string(),
  mode: RuleMode,
});
type RuleFormValues = z.infer<typeof RuleFormValues>;

const DraftSchema = RuleFormValues.partial();

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

  const form = useForm<RuleFormValues>({
    defaultValues: {
      kind: 'expense',
      name: '',
      amount: '',
      accountId: '',
      destAccountId: '',
      categoryId: '',
      note: '',
      frequency: 'monthly',
      weekday: initial.weekday,
      month: initial.month,
      day: String(initial.day),
      start: today,
      endType: 'none',
      endDate: '',
      endCount: '',
      mode: 'confirm',
    },
  });
  const draft = useDraft('recurring-rule', form, {
    userId: me.data?.id ?? '',
    schema: DraftSchema,
  });
  const values = useWatch({ control: form.control }) as RuleFormValues;
  const {
    kind,
    name,
    amount,
    accountId,
    destAccountId,
    categoryId,
    note,
    frequency,
    weekday,
    month,
    day,
    start,
    endType,
    endDate,
    endCount,
    mode,
  } = values;
  const set = <K extends keyof RuleFormValues>(field: K, value: RuleFormValues[K]) => {
    form.setValue(field, value as never, { shouldDirty: true });
  };
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
  // A restored draft may point to an account or category that is no longer active.
  const effectiveAccount = activeAccounts.some((account) => account.id === accountId)
    ? accountId
    : (activeAccounts[0]?.id ?? '');
  const effectiveCategory = activeCategories.some((category) => category.id === categoryId)
    ? categoryId
    : (activeCategories[0]?.id ?? '');
  const effectiveDest = activeAccounts.some((account) => account.id === destAccountId)
    ? destAccountId
    : '';
  const ready =
    accounts.data !== undefined && (kind === 'transfer' || categories.data !== undefined);

  const create = useMutation({
    mutationFn: (input: CreateRuleInput) => call(createRuleEndpoint, input),
    onSuccess: async () => {
      draft.clear();
      await queryClient.invalidateQueries({ queryKey: RECURRING_KEY });
      onClose();
    },
  });

  const submit = () => {
    const next: Partial<Record<Field, string>> = {};
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > NAME_MAX) next.name = t('form.nameError');

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
      if (effectiveDest === '' || effectiveDest === effectiveAccount) {
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
    if (kind === 'transfer') input.destAccountId = effectiveDest;
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
        {draft.restoredWithIssues && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('form.draftIssues')}
          </p>
        )}
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
                set('kind', event.target.value as RuleKind);
                set('categoryId', '');
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
              maxLength={NAME_MAX}
              value={name}
              aria-invalid={errors.name !== undefined}
              onChange={(event) => {
                set('name', event.target.value);
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
                set('amount', event.target.value);
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
                set('accountId', event.target.value);
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
                value={effectiveDest}
                onChange={(event) => {
                  set('destAccountId', event.target.value);
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
                  set('categoryId', event.target.value);
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
                set('note', event.target.value);
              }}
            />
            {error('note')}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-frequency">{t('form.frequency')}</Label>
            <Select
              value={frequency}
              onValueChange={(value) => {
                set('frequency', value as FrequencyType);
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
                  set('weekday', Number(event.target.value));
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
                  set('month', Number(event.target.value));
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
                  set('day', event.target.value);
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
                set('start', event.target.value);
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
                set('endType', event.target.value as EndType);
              }}
            >
              {END_TYPES.map((value) => (
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
                  set('endDate', event.target.value);
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
                  set('endCount', event.target.value);
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
                    set('mode', value);
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
