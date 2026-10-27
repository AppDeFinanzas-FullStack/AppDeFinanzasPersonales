import type { OnboardingStep } from '@finanzas/contracts';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** The three steps of the Onboarding, in order (spec §2.10.1). */
const STEPS: readonly OnboardingStep[] = [1, 2, 3];

export interface OnboardingStepperProps {
  step: OnboardingStep;
  /** A step is being saved: nothing else is sent until it answers. */
  busy: boolean;
  /** The error of the last request, already translated. */
  error: string | null;
  onSkipStep: () => void;
  onSkipAll: () => void;
  /** The pending step, with its own "Continuar". */
  children?: ReactNode;
}

/** The frame of every step: "Paso N de 3", "Saltar paso" and "Saltar todo" (spec §2.10.1). */
export function OnboardingStepper({
  step,
  busy,
  error,
  onSkipStep,
  onSkipAll,
  children,
}: OnboardingStepperProps) {
  const { t } = useTranslation('onboarding');
  return (
    <section aria-labelledby="onboarding-title" className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {t('stepper.progress', { step, total: STEPS.length })}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            disabled={busy}
            onClick={onSkipAll}
          >
            {t('stepper.skipAll')}
          </Button>
        </div>
        <div aria-hidden className="flex gap-1">
          {STEPS.map((each) => (
            <span
              key={each}
              className={cn(
                'h-1 flex-1 rounded-full',
                each <= step ? 'bg-primary' : 'bg-secondary',
              )}
            />
          ))}
        </div>
        <h1 id="onboarding-title" className="text-2xl font-semibold">
          {t(`steps.${String(step)}.title`)}
        </h1>
      </header>
      {children}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={onSkipStep}>
        {t('stepper.skipStep')}
      </Button>
    </section>
  );
}
