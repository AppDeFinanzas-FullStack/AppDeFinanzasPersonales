import { Amount, type CategoryChip } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, parseAmountInput, todayFor } from '@finanzas/domain';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { useMe } from '@/features/auth/hooks/use-me';
import { useSettings } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { useCreateTransaction, useRegisterContext } from '../hooks/use-register-context';

import { AccountChip } from './account-chip';
import { AllCategoriesSheet } from './all-categories-sheet';
import { AmountInput } from './amount-input';
import { CategoryGrid } from './category-grid';
import { DateChips } from './date-chips';
import { KindToggle, type RegisterKind } from './kind-toggle';

interface RegisterValues {
  /** The UUID v7 of the movement, kept in the draft so a retry is idempotent (ADR-11). */
  id: string;
  kind: RegisterKind;
  amount: string;
  categoryId: string;
  date: string;
}

const RegisterDraft = z
  .object({
    id: z.string(),
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: z.string(),
    categoryId: z.string(),
    date: z.string(),
  })
  .partial();

/** The kinds of this form: an expense or an income. */
const KINDS: readonly RegisterKind[] = ['expense', 'income'];

/** After this long the context is refreshed in the background once the user starts typing. */
const CONTEXT_FRESH_MS = 60_000;

/**
 * The form of `/registrar` (plan §4.7.3, §4.7.4): it opens as an expense with the focus on the
 * amount, or restores the `register` draft with its kind (RF-M7-02, RF-M7-08). "Guardar" is
 * enabled with an amount over 0 and a category (RF-M7-06), and Enter in the amount saves.
 */
export function RegisterForm() {
  const { t } = useTranslation('register');
  const me = useMe();
  const settings = useSettings();
  const context = useRegisterContext();
  const create = useCreateTransaction();
  const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());
  const amountRef = useRef<HTMLInputElement>(null);
  const refreshed = useRef(false);
  const [firstId] = useState(() => uuidv7());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [picked, setPicked] = useState<CategoryChip | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<RegisterValues>({
    defaultValues: { id: firstId, kind: 'expense', amount: '', categoryId: '', date: today },
  });
  const draft = useDraft('register', form, { userId: me.data?.id ?? '', schema: RegisterDraft });
  const [kind, amount, categoryId, date] = useWatch({
    control: form.control,
    name: ['kind', 'amount', 'categoryId', 'date'],
  });

  // RF-M7-02: the focus starts on the amount.
  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  const chipKind = kind === 'income' ? 'income' : 'expense';
  const data = context.data;
  // RF-M7-03: the default account of the settings, else the last one used for the kind (the API
  // already falls back to the first active one).
  const accountId = data === undefined ? null : (data.defaultAccountId ?? data.lastUsed[chipKind]);
  const account = data?.accounts.find((item) => item.id === accountId);
  const parsed = parseAmountInput(amount);
  const amountText = parsed === null ? null : parsed.toFixed(2);
  const ready =
    amountText !== null &&
    Amount.safeParse(amountText).success &&
    categoryId !== '' &&
    account !== undefined;

  const onAmount = (next: string) => {
    form.setValue('amount', next, { shouldDirty: true });
    // The screen makes no request before the user types (plan §4.7.4); an old context is
    // refreshed once, in the background, with the first keystroke.
    if (!refreshed.current && Date.now() - context.dataUpdatedAt > CONTEXT_FRESH_MS) {
      refreshed.current = true;
      void context.refetch();
    }
  };

  const onKind = (next: RegisterKind) => {
    if (next === kind) return;
    form.setValue('kind', next, { shouldDirty: true });
    // A category belongs to one kind.
    form.setValue('categoryId', '', { shouldDirty: true });
    setPicked(undefined);
  };

  const onCategory = (category: CategoryChip) => {
    form.setValue('categoryId', category.id, { shouldDirty: true });
    setPicked(category);
  };

  const save = (values: RegisterValues) => {
    if (!ready || account === undefined || amountText === null) return;
    setFormError(null);
    create.mutate(
      {
        kind: chipKind,
        id: values.id,
        accountId: account.id,
        categoryId: values.categoryId,
        amount: amountText,
        date: values.date,
      },
      {
        onSuccess: () => {
          // A new movement starts with a new id (plan §4.7.3).
          form.reset({ id: uuidv7(), kind: values.kind, amount: '', categoryId: '', date: today });
          draft.clear();
          setPicked(undefined);
          amountRef.current?.focus();
        },
        onError: (error) => {
          // The form keeps what the user wrote (EC-M7-02).
          setFormError(messageForError(error instanceof ApiError ? error : { code: '' }));
        },
      },
    );
  };

  return (
    <>
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          void form.handleSubmit(save)(event);
        }}
      >
        <KindToggle value={kind} kinds={KINDS} onChange={onKind} />
        <AmountInput id="register-amount" value={amount} onChange={onAmount} inputRef={amountRef} />
        <AccountChip account={account} kind={kind} loading={context.isPending} />
        {context.isError && data === undefined && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t('loadError')}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => {
                void context.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </div>
        )}
        <CategoryGrid
          chips={data?.grid[chipKind] ?? []}
          extra={picked}
          selectedId={categoryId}
          loading={context.isPending}
          onSelect={onCategory}
          onShowAll={() => {
            setSheetOpen(true);
          }}
        />
        <DateChips
          value={date}
          today={today}
          weekStart={settings.data?.weekStart ?? 'monday'}
          onChange={(next) => {
            form.setValue('date', next, { shouldDirty: true });
          }}
        />
        {formError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={!ready || create.isPending}>
          {create.isPending ? t('saving') : t('save')}
        </Button>
      </form>
      <AllCategoriesSheet
        open={sheetOpen}
        kind={chipKind}
        selectedId={categoryId}
        onOpenChange={setSheetOpen}
        onSelect={onCategory}
      />
    </>
  );
}
