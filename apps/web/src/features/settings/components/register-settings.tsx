import type { FavoriteKind } from '@finanzas/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { REGISTER_CONTEXT_KEY } from '@/features/register/hooks/use-register-context';

import { useSettings, useUpdateSettings } from '../hooks/use-settings';

import { FavoritesPicker } from './favorites-picker';
import { ResetSectionButton } from './reset-section-button';
import { ShortcutsManager } from './shortcuts-manager';

const FAVORITE_KINDS: readonly FavoriteKind[] = ['expense', 'income'];

/**
 * `/ajustes/registrar`: default account, favorite categories, shortcuts and "Mostrar la nota
 * siempre" (plan §4.9.4). Each change is saved at once (RF-M9-01).
 */
export function RegisterSettings() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const settings = useSettings();
  const accounts = useAccounts('active');
  const update = useUpdateSettings();

  // Registrar keeps its context until told otherwise, so leaving here refreshes it (RF-M7-04).
  useEffect(
    () => () => {
      void queryClient.invalidateQueries({ queryKey: REGISTER_CONTEXT_KEY });
    },
    [queryClient],
  );

  if (settings.isError && settings.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('general.loadError')}
      </p>
    );
  }
  if (settings.data === undefined) return null;
  const data = settings.data;

  const activeAccounts = accounts.data?.items ?? [];
  // An archived default account no longer applies, so Registrar chooses by RF-M7-03 (EC-M9-02).
  const defaultId = activeAccounts.some((account) => account.id === data.defaultAccountId)
    ? data.defaultAccountId
    : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('sections.register.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('general.autosave')}</p>
      </div>

      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('general.saveError')}
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-base font-medium">{t('register.defaultAccount.label')}</legend>
        <p className="text-sm text-muted-foreground">{t('register.defaultAccount.hint')}</p>
        {accounts.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('register.defaultAccount.loadError')}
          </p>
        )}
        {accounts.data !== undefined && (
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name="settings-default-account"
              checked={defaultId === null}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              onChange={() => {
                update.mutate({ defaultAccountId: null });
              }}
            />
            <span>{t('register.defaultAccount.none')}</span>
          </label>
        )}
        {activeAccounts.map((account) => (
          <label key={account.id} className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name="settings-default-account"
              checked={defaultId === account.id}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              onChange={() => {
                update.mutate({ defaultAccountId: account.id });
              }}
            />
            <span className="flex flex-col">
              <span>{account.name}</span>
              {account.dedicatedGoal !== undefined && (
                <span className="text-sm text-muted-foreground">
                  {t('register.defaultAccount.goal', { name: account.dedicatedGoal.name })}
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-6">
        {FAVORITE_KINDS.map((kind) => (
          <FavoritesPicker
            key={kind}
            kind={kind}
            selected={data.favorites[kind]}
            onChange={(ids) => {
              update.mutate({ favoriteCategories: { kind, ids } });
            }}
          />
        ))}
      </div>

      <ShortcutsManager />

      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="settings-always-show-note" className="text-base font-medium">
            {t('register.alwaysShowNote.label')}
          </Label>
          <p className="text-sm text-muted-foreground">{t('register.alwaysShowNote.hint')}</p>
        </div>
        <Switch
          id="settings-always-show-note"
          checked={data.alwaysShowNote}
          onCheckedChange={(checked) => {
            update.mutate({ alwaysShowNote: checked });
          }}
        />
      </div>

      <ResetSectionButton section="register" />
    </div>
  );
}
