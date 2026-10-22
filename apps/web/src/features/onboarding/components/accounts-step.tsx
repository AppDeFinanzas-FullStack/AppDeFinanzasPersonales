import { AccountType, type AccountPreset, type Step2Input } from '@finanzas/contracts';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldSelect, parseSignedAmount } from '@/features/accounts/components/account-form';
import { useMe } from '@/features/auth/hooks/use-me';
import { useDraft } from '@/lib/drafts';

/** Most accounts step 2 creates at once, the same bound as the API (plan §4.10.2). */
const MAX_ACCOUNTS = 20;
const NAME_MAX = 40;
const DEFAULT_BALANCE = '0';
const NON_NEGATIVE: readonly AccountType[] = ['cash', 'ewallet'];
/** A card has its own balance rules, so "Otra cuenta" does not offer it (RF-M4-02). */
const OTHER_TYPES = AccountType.options.filter((type) => type !== 'credit_card');
const OTHER_CURRENCIES = ['BOB', 'USD'] as const;

/** A card of the step as the user left it; amounts stay text until they are sent (ADR-03). */
const CardValues = z.object({
  accountId: z.string(),
  suggested: z.boolean(),
  checked: z.boolean(),
  name: z.string(),
  type: AccountType,
  currencyCode: z.string(),
  balance: z.string(),
});
type CardValues = z.infer<typeof CardValues>;

const AccountsFormValues = z.object({ cards: z.array(CardValues) });
type AccountsFormValues = z.infer<typeof AccountsFormValues>;

const DraftSchema = AccountsFormValues.partial();

type CardErrors = Partial<Record<'name' | 'balance', string>>;

export interface AccountsStepProps {
  /** The suggested accounts, checked or not by default (spec §2.10.1). */
  presets: AccountPreset[];
  busy: boolean;
  /** Sends the accounts; `onSaved` runs once they are created, so the draft can go. */
  onContinue: (accounts: Step2Input['accounts'], onSaved: () => void) => void;
}

function initialCards(presets: AccountPreset[]): CardValues[] {
  return presets.map((preset) => ({
    accountId: uuidv7(),
    suggested: true,
    checked: preset.checked,
    name: preset.name,
    type: preset.type,
    currencyCode: preset.currencyCode,
    balance: DEFAULT_BALANCE,
  }));
}

function newCard(): CardValues {
  return {
    accountId: uuidv7(),
    suggested: false,
    checked: true,
    name: '',
    type: 'cash',
    currencyCode: 'BOB',
    balance: DEFAULT_BALANCE,
  };
}

interface Checked {
  accounts: Step2Input['accounts'];
  errors: Record<string, CardErrors>;
}

/**
 * The checked cards as the API takes them, or the errors that keep them from being sent: the name
 * rules (RF-M4-01) and the initial balance rules (RF-M4-02, RF-M10-04).
 */
function checkCards(cards: CardValues[], t: (key: string) => string): Checked {
  const accounts: Step2Input['accounts'] = [];
  const errors: Record<string, CardErrors> = {};
  const taken = new Set<string>();
  for (const card of cards) {
    if (!card.checked) continue;
    const found: CardErrors = {};
    const name = card.name.trim();
    if (name.length === 0 || name.length > NAME_MAX) {
      found.name = t('accounts.errors.name');
    } else if (taken.has(name.toLowerCase())) {
      found.name = t('accounts.errors.nameTaken');
    }
    taken.add(name.toLowerCase());
    const balance = parseSignedAmount(card.balance.trim() === '' ? DEFAULT_BALANCE : card.balance);
    if (balance === null) {
      found.balance = t('accounts.errors.amount');
    } else if (NON_NEGATIVE.includes(card.type) && balance.startsWith('-')) {
      found.balance = t('accounts.errors.negative');
    }
    if (found.name !== undefined || found.balance !== undefined || balance === null) {
      errors[card.accountId] = found;
      continue;
    }
    accounts.push({
      id: card.accountId,
      name,
      type: card.type,
      currencyCode: card.currencyCode,
      balance,
    });
  }
  return { accounts, errors };
}

/**
 * Step 2: the suggested accounts as cards to check, each with an editable name and its balance of
 * today (0 by default), and "+ Otra cuenta". The cards are kept in the `onboarding-step2` draft
 * (spec §2.10.1, plan §4.10.4).
 */
export function AccountsStep({ presets, busy, onContinue }: AccountsStepProps) {
  const { t } = useTranslation('onboarding');
  const me = useMe();
  const [errors, setErrors] = useState<Record<string, CardErrors>>({});
  const [initial] = useState(() => initialCards(presets));
  const form = useForm<AccountsFormValues>({ defaultValues: { cards: initial } });
  const draft = useDraft('onboarding-step2', form, {
    userId: me.data?.id ?? '',
    schema: DraftSchema,
  });
  const cards = useWatch({ control: form.control, name: 'cards' });

  function change(index: number, patch: Partial<CardValues>) {
    form.setValue(
      'cards',
      form.getValues('cards').map((card, at) => (at === index ? { ...card, ...patch } : card)),
      { shouldDirty: true },
    );
  }

  function add() {
    form.setValue('cards', [...cards, newCard()], { shouldDirty: true });
  }

  function remove(accountId: string) {
    form.setValue(
      'cards',
      cards.filter((card) => card.accountId !== accountId),
      { shouldDirty: true },
    );
  }

  function submit() {
    const checked = checkCards(cards, t);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length > 0) return;
    onContinue(checked.accounts, draft.clear);
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p>{t('accounts.intro')}</p>
      <ul className="flex flex-col gap-4">
        {cards.map((card, index) => {
          const id = `onboarding-account-${card.accountId}`;
          const cardErrors = errors[card.accountId] ?? {};
          return (
            <li
              key={card.accountId}
              className="flex flex-col gap-4 rounded-md border border-border p-4"
            >
              {card.suggested ? (
                <label className="flex min-h-11 items-center gap-3 font-medium">
                  <input
                    type="checkbox"
                    checked={card.checked}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    onChange={(event) => {
                      change(index, { checked: event.target.checked });
                    }}
                  />
                  {presets[index]?.name ?? card.name}
                </label>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 self-end"
                  aria-label={t('accounts.removeLabel')}
                  onClick={() => {
                    remove(card.accountId);
                  }}
                >
                  {t('accounts.remove')}
                </Button>
              )}
              {card.checked && (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-name`}>{t('accounts.name')}</Label>
                    <Input
                      id={`${id}-name`}
                      autoComplete="off"
                      maxLength={NAME_MAX}
                      className="h-11"
                      value={card.name}
                      aria-invalid={cardErrors.name !== undefined}
                      aria-describedby={cardErrors.name === undefined ? undefined : `${id}-name-error`}
                      onChange={(event) => {
                        change(index, { name: event.target.value });
                      }}
                    />
                    {cardErrors.name !== undefined && (
                      <p id={`${id}-name-error`} className="text-sm text-destructive">
                        {cardErrors.name}
                      </p>
                    )}
                  </div>
                  {!card.suggested && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor={`${id}-type`}>{t('accounts.type')}</Label>
                        <FieldSelect
                          id={`${id}-type`}
                          value={card.type}
                          onChange={(event) => {
                            const type = AccountType.safeParse(event.target.value);
                            if (type.success) change(index, { type: type.data });
                          }}
                        >
                          {OTHER_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {t(`accounts.types.${type}`)}
                            </option>
                          ))}
                        </FieldSelect>
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor={`${id}-currency`}>{t('accounts.currency')}</Label>
                        <FieldSelect
                          id={`${id}-currency`}
                          value={card.currencyCode}
                          onChange={(event) => {
                            change(index, { currencyCode: event.target.value });
                          }}
                        >
                          {OTHER_CURRENCIES.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </FieldSelect>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${id}-balance`}>{t('accounts.balance')}</Label>
                    <Input
                      id={`${id}-balance`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0,00"
                      className="h-11 tabular-nums"
                      value={card.balance}
                      aria-invalid={cardErrors.balance !== undefined}
                      aria-describedby={`${id}-balance-hint`}
                      onChange={(event) => {
                        change(index, { balance: event.target.value });
                      }}
                    />
                    <p id={`${id}-balance-hint`} className="text-sm text-muted-foreground">
                      {NON_NEGATIVE.includes(card.type)
                        ? t('accounts.balanceHint.nonNegative')
                        : t('accounts.balanceHint.any')}
                    </p>
                    {cardErrors.balance !== undefined && (
                      <p className="text-sm text-destructive">{cardErrors.balance}</p>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        variant="ghost"
        className="h-11 self-start"
        disabled={cards.length >= MAX_ACCOUNTS}
        onClick={add}
      >
        {t('accounts.addOther')}
      </Button>
      <Button type="submit" className="h-11" disabled={busy || me.data === undefined}>
        {t('accounts.continue')}
      </Button>
    </form>
  );
}
