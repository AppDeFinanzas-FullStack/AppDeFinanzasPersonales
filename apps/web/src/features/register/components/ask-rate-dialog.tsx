import { Rate } from '@finanzas/contracts';
import { parseAmountInput } from '@finanzas/domain';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

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

/** What the user typed as a rate, as decimal text; `null` when it is not one over 0. */
function rateText(raw: string): string | null {
  const value = parseAmountInput(raw.trim());
  if (value === null || value.isZero()) return null;
  const text = value.toFixed(2);
  return Rate.safeParse(text).success ? text : null;
}

interface AskRateDialogProps {
  open: boolean;
  pending: boolean;
  /** Resends the movement with this rate as `manualUsdRate` (EC-M7-04). */
  onConfirm: (rate: string) => void;
  onCancel: () => void;
}

/**
 * `<AskRateDialog>`: without any rate, a movement in another currency asks for the dollar; the
 * value becomes the rate of the movement and the active manual value (EC-M3-02, EC-M7-04).
 */
export function AskRateDialog({ open, pending, onConfirm, onCancel }: AskRateDialogProps) {
  const { t } = useTranslation('register');
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const rate = rateText(value);
            setInvalid(rate === null);
            if (rate !== null) onConfirm(rate);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('askRate.title')}</DialogTitle>
            <DialogDescription>{t('askRate.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ask-rate">{t('askRate.label')}</Label>
            <Input
              id="ask-rate"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              aria-invalid={invalid}
              aria-describedby={invalid ? 'ask-rate-error' : undefined}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
            {invalid && (
              <p id="ask-rate-error" role="alert" className="text-sm text-destructive">
                {t('askRate.invalid')}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
              {t('askRate.cancel')}
            </Button>
            <Button type="submit" className="h-11" disabled={pending}>
              {t('askRate.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
