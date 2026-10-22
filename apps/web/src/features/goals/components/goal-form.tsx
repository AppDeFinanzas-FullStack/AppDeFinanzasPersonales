import { IconKey, PALETTE, PaletteKey, type CreateGoalInput } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, todayFor } from '@finanzas/domain';
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
import { parseSignedAmount, useCurrencyCodes } from '@/features/accounts/components/account-form';
import { useMe } from '@/features/auth/hooks/use-me';
import { IconGallery } from '@/features/categories/components/icon-gallery';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

const NAME_MAX = 40;

const GoalFormValues = z.object({
  name: z.string(),
  target: z.string(),
  currencyCode: z.string(),
  targetDate: z.string(),
  icon: IconKey,
  color: PaletteKey,
});
type GoalFormValues = z.infer<typeof GoalFormValues>;

const DraftSchema = GoalFormValues.partial();

const createGoalEndpoint: Endpoint<CreateGoalInput, unknown> = {
  method: 'POST',
  path: '/api/goals',
  input: z.custom<CreateGoalInput>(),
  output: z.unknown(),
};

/** Every goal mutation changes the goals and the free balance of the accounts (plan §4.12.4). */
export function useInvalidateGoals(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['goals'] }),
      queryClient.invalidateQueries({ queryKey: ['goal'] }),
      queryClient.invalidateQueries({ queryKey: ['accounts'] }),
    ]);
  };
}

type FieldErrors = Partial<Record<'name' | 'target' | 'targetDate', string>>;

/** Creates a goal, with a draft (RF-M12-01). */
export function GoalForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('goals');
  const me = useMe();
  const currencies = useCurrencyCodes();
  const invalidate = useInvalidateGoals();
  const [id, setId] = useState(() => uuidv7());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<GoalFormValues>({
    defaultValues: {
      name: '',
      target: '',
      currencyCode: 'BOB',
      targetDate: '',
      icon: 'piggy-bank',
      color: 'teal',
    },
  });
  const draft = useDraft('goal:new', form, { userId: me.data?.id ?? '', schema: DraftSchema });
  const { register, control, setValue } = form;
  const icon = useWatch({ control, name: 'icon' });
  const color = useWatch({ control, name: 'color' });

  const save = useMutation({
    mutationFn: (input: CreateGoalInput) => call(createGoalEndpoint, input),
    onSuccess: async () => {
      draft.clear();
      form.reset();
      setId(uuidv7());
      await invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      setFormError(messageForError(error instanceof ApiError ? error : { code: '' }));
    },
  });

  const submit = form.handleSubmit((values) => {
    const next: FieldErrors = {};
    const name = values.name.trim();
    if (name.length === 0 || name.length > NAME_MAX) next.name = t('form.errors.name');
    const target = parseSignedAmount(values.target);
    if (target === null || target.startsWith('-') || target === '0.00') {
      next.target = t('form.errors.target');
    }
    const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());
    if (values.targetDate !== '' && values.targetDate < today) {
      next.targetDate = t('form.errors.targetDate');
    }
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0 || target === null) return;
    save.mutate({
      id,
      name,
      target,
      currencyCode: values.currencyCode,
      ...(values.targetDate === '' ? {} : { targetDate: values.targetDate }),
      icon: values.icon,
      color: values.color,
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('actions.close')}>
        <DialogHeader>
          <DialogTitle>{t('form.title')}</DialogTitle>
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
            <Label htmlFor="goal-name">{t('form.name')}</Label>
            <Input
              id="goal-name"
              autoComplete="off"
              className="h-11"
              aria-invalid={errors.name !== undefined}
              {...register('name')}
            />
            {errors.name !== undefined && <p className="text-sm text-destructive">{errors.name}</p>}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="goal-target">{t('form.target')}</Label>
            <Input
              id="goal-target"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              aria-invalid={errors.target !== undefined}
              {...register('target')}
            />
            {errors.target !== undefined && (
              <p className="text-sm text-destructive">{errors.target}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="goal-currency">{t('form.currency')}</Label>
            <select
              id="goal-currency"
              className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-base"
              {...register('currencyCode')}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="goal-date">{t('form.targetDate')}</Label>
            <Input
              id="goal-date"
              type="date"
              className="h-11"
              aria-invalid={errors.targetDate !== undefined}
              {...register('targetDate')}
            />
            {errors.targetDate !== undefined && (
              <p className="text-sm text-destructive">{errors.targetDate}</p>
            )}
          </div>
          <IconGallery
            value={icon}
            onChange={(next) => {
              setValue('icon', next, { shouldDirty: true });
            }}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('form.color')}</legend>
            <div className="flex flex-wrap gap-2">
              {PaletteKey.options.map((key) => (
                <label
                  key={key}
                  className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border border-border has-[:checked]:ring-2 has-[:checked]:ring-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                >
                  <input
                    type="radio"
                    name="goal-color"
                    value={key}
                    aria-label={key}
                    className="sr-only"
                    checked={color === key}
                    onChange={() => {
                      setValue('color', key, { shouldDirty: true });
                    }}
                  />
                  <span
                    aria-hidden
                    style={{ backgroundColor: PALETTE[key].light }}
                    className="h-6 w-6 rounded-full"
                  />
                </label>
              ))}
            </div>
          </fieldset>
          {formError !== null && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" className="h-11" disabled={save.isPending}>
              {save.isPending ? t('form.saving') : t('form.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
