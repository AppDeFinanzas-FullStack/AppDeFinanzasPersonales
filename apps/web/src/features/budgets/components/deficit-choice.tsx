import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

export type DeficitMode = 'carry' | 'absorb';

/**
 * The excess of a closed period is carried or absorbed (RF-M11-08). A finalized budget has no next
 * period, so it only offers Absorber (EC-M11-09).
 */
export function DeficitChoice({
  canCarry,
  pending,
  onChoose,
}: {
  canCarry: boolean;
  pending: boolean;
  onChoose: (mode: DeficitMode) => void;
}) {
  const { t } = useTranslation('budgets');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {canCarry ? t('close.deficitHint') : t('close.deficitHintFinal')}
      </p>
      <div className="flex flex-wrap gap-2">
        {canCarry && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={pending}
            onClick={() => {
              onChoose('carry');
            }}
          >
            {t('close.carry')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={pending}
          onClick={() => {
            onChoose('absorb');
          }}
        >
          {t('close.absorb')}
        </Button>
      </div>
    </div>
  );
}
