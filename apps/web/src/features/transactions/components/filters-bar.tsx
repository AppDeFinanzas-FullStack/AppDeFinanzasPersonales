import { TransactionKind } from '@finanzas/contracts';
import { SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldSelect } from '@/features/accounts/components/account-form';

/** The filters of the list besides the month (RF-M6-02 flow, plan §4.6.4). */
export interface ListFiltersValue {
  from?: string | undefined;
  to?: string | undefined;
  accountId?: string | undefined;
  categoryId?: string | undefined;
  kind?: TransactionKind | undefined;
  q?: string | undefined;
}

interface FiltersBarProps {
  value: ListFiltersValue;
  accounts: readonly { id: string; name: string }[];
  /** The name of the filtered category, when a loaded movement tells it. */
  categoryName?: string | undefined;
  /** Movements are dated today or before (RF-M6-02). */
  today: string;
  onChange: (next: ListFiltersValue) => void;
}

const SEARCH_DELAY_MS = 300;

/** Search by note or amount, written to the URL once the user stops typing. */
function SearchField({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const { t } = useTranslation('transactions');
  const id = useId();
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  const [sent, setSent] = useState(value);

  // The URL changed from outside (cleared, Back): the field shows it, unless it is the echo of
  // what the field itself sent, so the letters typed meanwhile are kept.
  if (value !== synced) {
    setSynced(value);
    if (value !== sent) setText(value);
  }

  useEffect(() => {
    if (text === value) return undefined;
    const timer = setTimeout(() => {
      setSent(text);
      onSearch(text);
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, value, onSearch]);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{t('filters.search')}</Label>
      <Input
        id={id}
        type="search"
        inputMode="search"
        autoComplete="off"
        maxLength={60}
        placeholder={t('filters.searchPlaceholder')}
        className="h-11"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
    </div>
  );
}

/** Date or range, account, category and kind, plus the search (plan §4.6.4). */
export function FiltersBar({ value, accounts, categoryName, today, onChange }: FiltersBarProps) {
  const { t } = useTranslation('transactions');
  const ids = { account: useId(), kind: useId(), from: useId(), to: useId() };
  const detailed =
    value.accountId !== undefined ||
    value.kind !== undefined ||
    value.from !== undefined ||
    value.to !== undefined;
  const [open, setOpen] = useState(detailed);
  const active = detailed || value.categoryId !== undefined || (value.q ?? '') !== '';
  const ranged = value.from !== undefined || value.to !== undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <SearchField
            value={value.q ?? ''}
            onSearch={(q) => {
              onChange({ q: q.trim() === '' ? undefined : q });
            }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          aria-expanded={open}
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          <SlidersHorizontal aria-hidden="true" />
          {t('filters.more')}
        </Button>
      </div>

      {open && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.account}>{t('filters.account')}</Label>
            <FieldSelect
              id={ids.account}
              value={value.accountId ?? ''}
              onChange={(event) => {
                onChange({ accountId: event.target.value === '' ? undefined : event.target.value });
              }}
            >
              <option value="">{t('filters.allAccounts')}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </FieldSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.kind}>{t('filters.kind')}</Label>
            <FieldSelect
              id={ids.kind}
              value={value.kind ?? ''}
              onChange={(event) => {
                const kind = TransactionKind.safeParse(event.target.value);
                onChange({ kind: kind.success ? kind.data : undefined });
              }}
            >
              <option value="">{t('filters.allKinds')}</option>
              {TransactionKind.options.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </FieldSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.from}>{t('filters.from')}</Label>
            <Input
              id={ids.from}
              type="date"
              className="h-11"
              max={value.to ?? today}
              value={value.from ?? ''}
              onChange={(event) => {
                onChange({ from: event.target.value === '' ? undefined : event.target.value });
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.to}>{t('filters.to')}</Label>
            <Input
              id={ids.to}
              type="date"
              className="h-11"
              min={value.from}
              max={today}
              value={value.to ?? ''}
              onChange={(event) => {
                onChange({ to: event.target.value === '' ? undefined : event.target.value });
              }}
            />
          </div>
        </div>
      )}

      {(value.categoryId !== undefined || ranged || active) && (
        <div className="flex flex-wrap items-center gap-2">
          {value.categoryId !== undefined && (
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              aria-label={t('filters.clearCategory')}
              onClick={() => {
                onChange({ categoryId: undefined });
              }}
            >
              {categoryName ?? t('filters.category')}
              <X aria-hidden="true" />
            </Button>
          )}
          {ranged && (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => {
                onChange({ from: undefined, to: undefined });
              }}
            >
              {t('filters.clearRange')}
            </Button>
          )}
          {active && (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => {
                onChange({
                  from: undefined,
                  to: undefined,
                  accountId: undefined,
                  categoryId: undefined,
                  kind: undefined,
                  q: undefined,
                });
              }}
            >
              {t('filters.clear')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
