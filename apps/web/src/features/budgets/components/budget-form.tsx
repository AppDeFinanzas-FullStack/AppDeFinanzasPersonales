import type { BudgetDto, CategoryNode } from '@finanzas/contracts';
import { periodFor } from '@finanzas/domain';
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
import { parseSignedAmount, useCurrencyCodes } from '@/features/accounts/components/account-form';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCategories } from '@/features/categories/hooks/use-categories';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { useCreateBudget, useFetchBudget, useUpdateBudget } from '../hooks/use-budgets';

const GENERAL = 'general';
const START_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);
const THRESHOLD_MIN = 1;
const THRESHOLD_MAX = 150;
const SELECT =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 text-base disabled:cursor-not-allowed disabled:opacity-50';

const BudgetFormValues = z.object({
  scope: z.string(),
  amount: z.string(),
  currencyCode: z.string(),
  startDay: z.string(),
  defaultAction: z.enum(['discard', 'carry']),
  threshold1: z.string(),
  threshold2: z.string(),
  threshold3: z.string(),
});
type BudgetFormValues = z.infer<typeof BudgetFormValues>;

const DraftSchema = BudgetFormValues.partial();

type FieldErrors = Partial<Record<'scope' | 'amount' | 'thresholds', string>>;

const thresholdValues = (thresholds: readonly number[]) => {
  const [first, second, third] = thresholds.map(String);
  return { threshold1: first ?? '', threshold2: second ?? '', threshold3: third ?? '' };
};

const defaultsOf = (budget: BudgetDto | undefined): BudgetFormValues =>
  budget === undefined
    ? {
        scope: GENERAL,
        amount: '',
        currencyCode: 'BOB',
        startDay: '1',
        defaultAction: 'discard',
        ...thresholdValues([80, 100]),
      }
    : {
        scope: budget.category?.id ?? GENERAL,
        amount: budget.amount,
        currencyCode: budget.currencyCode,
        startDay: String(budget.nextStartDay ?? budget.startDay),
        defaultAction: budget.defaultAction,
        ...thresholdValues(budget.thresholds),
      };

/** Up to 3 distinct whole percentages between 1 and 150, or `null` when one is not valid. */
function parseThresholds(values: BudgetFormValues): number[] | null {
  const raw = [values.threshold1, values.threshold2, values.threshold3]
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const parsed: number[] = [];
  for (const value of raw) {
    if (!/^\d+$/.test(value)) return null;
    const threshold = Number.parseInt(value, 10);
    if (threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX) return null;
    parsed.push(threshold);
  }
  if (new Set(parsed).size !== parsed.length) return null;
  return parsed.sort((a, b) => a - b);
}

/**
 * Expense categories and subcategories that admit a budget (RF-M11-01): the system root
 * "Deudas y préstamos" is excluded, but its subcategory "Intereses" is allowed.
 */
function budgetableOptions(roots: readonly CategoryNode[]): { id: string; name: string }[] {
  return roots.flatMap((root) => [
    ...(root.isSystem ? [] : [{ id: root.id, name: root.name }]),
    ...root.children.map((child) => ({ id: child.id, name: `${root.name} › ${child.name}` })),
  ]);
}

/** End of the period in course once it is stretched to the new start day (RF-M11-07). */
function stretchedEnd(budget: BudgetDto, startDay: number): string | null {
  const { current } = budget;
  if (current === undefined || startDay === budget.startDay) return null;
  const regularEnd = periodFor(budget.startDay, null, current.start).end;
  return periodFor(startDay, null, regularEnd).end;
}

function BudgetFormBody({
  budget,
  onDone,
  onEditExisting,
}: {
  budget: BudgetDto | undefined;
  onDone: () => void;
  onEditExisting: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation('budgets');
  const me = useMe();
  const formatters = useFormatters();
  const currencies = useCurrencyCodes();
  const categories = useCategories({ kind: 'expense', status: 'active' });
  const create = useCreateBudget();
  const update = useUpdateBudget(budget?.id ?? '');
  const [id, setId] = useState(() => uuidv7());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const editing = budget !== undefined;

  const form = useForm<BudgetFormValues>({ defaultValues: defaultsOf(budget) });
  const draft = useDraft(editing ? `budget:${budget.id}` : 'budget:new', form, {
    userId: me.data?.id ?? '',
    schema: DraftSchema,
  });
  const { register, control } = form;
  const startDay = useWatch({ control, name: 'startDay' });
  const options = budgetableOptions(categories.data ?? []);
  const newEnd = editing ? stretchedEnd(budget, Number.parseInt(startDay, 10)) : null;
  const pending = create.isPending || update.isPending;

  const onSaved = () => {
    draft.clear();
    form.reset();
    setId(uuidv7());
    onDone();
  };
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'BUDGET_EXISTS') {
      const existing = error.data?.['budgetId'];
      if (typeof existing === 'string') setExistingId(existing);
    }
    setFormError(messageForError(error instanceof ApiError ? error : { code: '' }));
  };

  const submit = form.handleSubmit((values) => {
    const next: FieldErrors = {};
    const amount = parseSignedAmount(values.amount);
    if (amount === null || amount.startsWith('-') || amount === '0.00') {
      next.amount = t('form.errors.amount');
    }
    const thresholds = parseThresholds(values);
    if (thresholds === null) next.thresholds = t('form.errors.thresholds');
    if (!editing && values.scope !== GENERAL && !options.some((o) => o.id === values.scope)) {
      next.scope = t('form.errors.scope');
    }
    setErrors(next);
    setFormError(null);
    setExistingId(null);
    if (Object.keys(next).length > 0 || amount === null || thresholds === null) return;
    const common = {
      amount,
      startDay: Number.parseInt(values.startDay, 10),
      defaultAction: values.defaultAction,
      thresholds,
    };
    if (editing) {
      update.mutate(common, { onSuccess: onSaved, onError });
      return;
    }
    create.mutate(
      {
        id,
        ...(values.scope === GENERAL
          ? { scope: 'general' }
          : { scope: 'category', categoryId: values.scope }),
        currencyCode: values.currencyCode,
        ...common,
      },
      { onSuccess: onSaved, onError },
    );
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? t('form.editTitle') : t('form.title')}</DialogTitle>
        <DialogDescription>{t('form.description')}</DialogDescription>
      </DialogHeader>
      <form
        noValidate
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="budget-scope">{t('form.scope')}</Label>
          <select
            id="budget-scope"
            className={SELECT}
            disabled={editing}
            aria-invalid={errors.scope !== undefined}
            {...register('scope')}
          >
            <option value={GENERAL}>{t('general')}</option>
            {editing && budget.category !== undefined && (
              <option value={budget.category.id}>{budget.category.name}</option>
            )}
            {!editing &&
              options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
          </select>
          {errors.scope !== undefined && <p className="text-sm text-destructive">{errors.scope}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="budget-amount">{t('form.amount')}</Label>
          <Input
            id="budget-amount"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 tabular-nums"
            aria-invalid={errors.amount !== undefined}
            {...register('amount')}
          />
          {errors.amount !== undefined && (
            <p className="text-sm text-destructive">{errors.amount}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="budget-currency">{t('form.currency')}</Label>
          <select
            id="budget-currency"
            className={SELECT}
            disabled={editing}
            {...register('currencyCode')}
          >
            {(editing ? [budget.currencyCode] : currencies).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          {editing && <p className="text-sm text-muted-foreground">{t('form.currencyFixed')}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="budget-start-day">{t('form.startDay')}</Label>
          <select id="budget-start-day" className={SELECT} {...register('startDay')}>
            {START_DAYS.map((day) => (
              <option key={day} value={String(day)}>
                {day}
              </option>
            ))}
          </select>
          {newEnd !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('form.stretchedEnd', { date: formatters.date(newEnd) })}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="budget-action">{t('form.defaultAction')}</Label>
          <select id="budget-action" className={SELECT} {...register('defaultAction')}>
            <option value="discard">{t('form.actions.discard')}</option>
            <option value="carry">{t('form.actions.carry')}</option>
          </select>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('form.thresholds')}</legend>
          <div className="grid grid-cols-3 gap-2">
            {(['threshold1', 'threshold2', 'threshold3'] as const).map((name, index) => (
              <Input
                key={name}
                inputMode="numeric"
                autoComplete="off"
                className="h-11 tabular-nums"
                aria-label={t('form.threshold', { n: index + 1 })}
                aria-invalid={errors.thresholds !== undefined}
                {...register(name)}
              />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{t('form.thresholdsHint')}</p>
          {errors.thresholds !== undefined && (
            <p className="text-sm text-destructive">{errors.thresholds}</p>
          )}
        </fieldset>
        {formError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
        {existingId !== null && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => {
              void onEditExisting(existingId);
            }}
          >
            {t('form.editExisting')}
          </Button>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={onDone}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" className="h-11" disabled={pending}>
            {pending ? t('form.saving') : t('form.submit')}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/**
 * Creates or edits a budget, with a draft (plan §4.11.4). A second budget for the same scope is
 * rejected and the existing one is offered for editing in the same dialog (EC-M11-06).
 */
export function BudgetForm({
  open,
  onOpenChange,
  budget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: BudgetDto;
}) {
  const { t } = useTranslation('budgets');
  const fetchBudget = useFetchBudget();
  const [existing, setExisting] = useState<BudgetDto | undefined>(undefined);
  const target = existing ?? budget;
  const changeOpen = (next: boolean) => {
    if (!next) setExisting(undefined);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent closeLabel={t('form.close')}>
        <BudgetFormBody
          key={target?.id ?? 'new'}
          budget={target}
          onDone={() => {
            changeOpen(false);
          }}
          onEditExisting={async (id) => {
            setExisting(await fetchBudget(id));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
