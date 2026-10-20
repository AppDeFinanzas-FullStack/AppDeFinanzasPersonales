import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import type { RegisterAccount } from '../api';

const selectClass =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm';

interface TransferFieldsProps {
  accounts: readonly RegisterAccount[];
  fromId: string;
  toId: string;
  onFrom: (id: string) => void;
  onTo: (id: string) => void;
  /** Only when both accounts use different currencies (RF-M3-07). */
  exchange: {
    rate: string;
    amountIn: string;
    onRate: (rate: string) => void;
    /** Editing what arrives recalculates the rate (RF-M3-08). */
    onAmountIn: (amount: string) => void;
  } | null;
}

/**
 * Origin and destination of a transfer (plan §4.7.3). Between two currencies it adds the
 * "Tipo de cambio usado" and the amount that arrives.
 */
export function TransferFields({ accounts, fromId, toId, onFrom, onTo, exchange }: TransferFieldsProps) {
  const { t } = useTranslation('register');
  const same = fromId !== '' && fromId === toId;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="transfer-from">{t('transfer.from')}</Label>
          <select
            id="transfer-from"
            className={selectClass}
            value={fromId}
            onChange={(event) => {
              onFrom(event.target.value);
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currencyCode})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="transfer-to">{t('transfer.to')}</Label>
          <select
            id="transfer-to"
            className={selectClass}
            value={toId}
            aria-invalid={same}
            aria-describedby={same ? 'transfer-same' : undefined}
            onChange={(event) => {
              onTo(event.target.value);
            }}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currencyCode})
              </option>
            ))}
          </select>
        </div>
      </div>
      {same && (
        <p id="transfer-same" className="text-sm text-destructive">
          {t('transfer.sameAccount')}
        </p>
      )}
      {exchange !== null && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="transfer-rate">{t('transfer.rate')}</Label>
            <Input
              id="transfer-rate"
              inputMode="decimal"
              className="h-11 tabular-nums"
              value={exchange.rate}
              onChange={(event) => {
                exchange.onRate(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="transfer-amount-in">{t('transfer.amountIn')}</Label>
            <Input
              id="transfer-amount-in"
              inputMode="decimal"
              className="h-11 tabular-nums"
              value={exchange.amountIn}
              onChange={(event) => {
                exchange.onAmountIn(event.target.value);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
