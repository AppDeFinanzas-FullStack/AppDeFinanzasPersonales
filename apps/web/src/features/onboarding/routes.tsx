import type {
  MeDto,
  OnboardingDto,
  SkipInput,
  Step1Input,
  Step2Input,
  Step3Input,
} from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { ME_QUERY_KEY, useMe } from '@/features/auth/hooks/use-me';
import { ApiError, call } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { uiStore } from '@/lib/ui-store';
import accounts from '@/locales/es-BO/accounts.json';
import onboarding from '@/locales/es-BO/onboarding.json';

import {
  getOnboardingEndpoint,
  skipAllEndpoint,
  skipEndpoint,
  step1Endpoint,
  step2Endpoint,
  step3Endpoint,
  type OnboardingProgress,
} from './api';
import { AccountsStep } from './components/accounts-step';
import { BaseCurrencyStep } from './components/base-currency-step';
import { CategoriesStep } from './components/categories-step';
import { OnboardingStepper } from './components/onboarding-stepper';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'onboarding', onboarding, true, true);
// The step of the accounts reuses the form of `accounts`.
i18n.addResourceBundle(LANGUAGE, 'accounts', accounts, true, true);

const ONBOARDING_KEY = ['onboarding'] as const;

/** What a button of the Onboarding sends (plan §4.10.2). */
type OnboardingAction =
  | { kind: 'step1'; input: Step1Input }
  | { kind: 'step2'; input: Step2Input }
  | { kind: 'step3'; input: Step3Input }
  | { kind: 'skip'; input: SkipInput }
  | { kind: 'skipAll' };

function send(action: OnboardingAction): Promise<OnboardingProgress> {
  switch (action.kind) {
    case 'step1':
      return call(step1Endpoint, action.input);
    case 'step2':
      return call(step2Endpoint, action.input);
    case 'step3':
      return call(step3Endpoint, action.input);
    case 'skip':
      return call(skipEndpoint, action.input);
    case 'skipAll':
      return call(skipAllEndpoint, undefined);
  }
}

function isApiError(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}

/**
 * Saves a step. The progress lives in the account, so the answer moves this screen on and a
 * reload resumes in the pending step (RF-M10-01). Finishing updates the profile, so the page
 * leaves for the Inicio.
 */
function useOnboardingAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (progress) => {
      // The answer proves the session is alive: a "session expired" left by a request made before
      // there was one (on /confirmar) must not cover the Inicio (RF-M2-08).
      uiStore.closeSessionExpired();
      queryClient.setQueryData<MeDto>(ME_QUERY_KEY, (me) =>
        me === undefined ? me : { ...me, onboarding: progress },
      );
      if (progress.completed) return;
      queryClient.setQueryData<OnboardingDto>(ONBOARDING_KEY, (state) =>
        state === undefined ? state : { ...state, step: progress.step },
      );
    },
    onError: async (error) => {
      // Another device moved it on (plan §4.10.3): this one shows where it is now.
      if (isApiError(error, 'STEP_MISMATCH')) {
        await queryClient.invalidateQueries({ queryKey: ONBOARDING_KEY });
      }
      if (isApiError(error, 'ONBOARDING_DONE')) {
        await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    },
  });
}

function OnboardingFlow() {
  const { t } = useTranslation('onboarding');
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ONBOARDING_KEY,
    queryFn: ({ signal }) => call(getOnboardingEndpoint, undefined, { signal }),
  });
  const action = useOnboardingAction();
  const finishedElsewhere = isApiError(state.error, 'ONBOARDING_DONE');

  useEffect(() => {
    // It was finished on another device: the profile says so and the page leaves (plan §4.10.3).
    if (finishedElsewhere) void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }, [finishedElsewhere, queryClient]);

  if (state.data === undefined) {
    if (!state.isError || finishedElsewhere) return null;
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }

  const { step, rate, presets } = state.data;
  const busy = action.isPending;
  const error =
    action.error === null
      ? null
      : messageForError(action.error instanceof ApiError ? action.error : { code: '' });

  return (
    <OnboardingStepper
      step={step}
      busy={busy}
      error={error}
      onSkipStep={() => {
        action.mutate({ kind: 'skip', input: { step } });
      }}
      onSkipAll={() => {
        action.mutate({ kind: 'skipAll' });
      }}
    >
      {step === 1 && (
        <BaseCurrencyStep
          rate={rate}
          busy={busy}
          onContinue={(baseCurrency) => {
            action.mutate({ kind: 'step1', input: { baseCurrency } });
          }}
        />
      )}
      {step === 2 && (
        <AccountsStep
          presets={presets.accounts}
          busy={busy}
          onContinue={(accounts, onSaved) => {
            action.mutate({ kind: 'step2', input: { accounts } }, { onSuccess: onSaved });
          }}
        />
      )}
      {step === 3 && (
        <CategoriesStep
          categories={presets.categories}
          busy={busy}
          onContinue={(input, onSaved) => {
            action.mutate({ kind: 'step3', input }, { onSuccess: onSaved });
          }}
        />
      )}
    </OnboardingStepper>
  );
}

/**
 * `/bienvenida` (plan §4.10.4). Once the Onboarding is finished it is never shown again: the
 * user goes to the Inicio, which opens in the current month (plan §4.10.3).
 */
export function OnboardingPage() {
  const me = useMe();
  if (!me.data) return null;
  if (me.data.onboarding.completed) return <Navigate to="/" replace />;
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-8">
      <OnboardingFlow />
    </main>
  );
}
