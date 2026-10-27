import { FavoriteKind, type SettingsDto, type UpdateSettingsInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { REGISTER_CONTEXT_KEY } from '@/features/register/hooks/use-register-context';
import { call } from '@/lib/api-client';

import { updateSettingsEndpoint } from '../api';
import { SETTINGS_KEY, useSettings } from '../hooks/use-settings';
import { AUTOSAVE_DELAY_MS } from '../hooks/use-update-settings';

import { FavoritesPicker } from './favorites-picker';
import { ResetSectionButton } from './reset-section-button';
import { ShortcutsManager } from './shortcuts-manager';

/** What the Registrar section changes; favorites travel one kind at a time. */
interface Draft {
  defaultAccountId?: string | null;
  alwaysShowNote?: boolean;
  favorites?: Partial<Record<FavoriteKind, string[]>>;
}

interface SaveVariables {
  draft: Draft;
  previous: SettingsDto | undefined;
}

function applyDraft(settings: SettingsDto, draft: Draft): SettingsDto {
  const next: SettingsDto = { ...settings, favorites: { ...settings.favorites, ...draft.favorites } };
  if (draft.defaultAccountId !== undefined) next.defaultAccountId = draft.defaultAccountId;
  if (draft.alwaysShowNote !== undefined) next.alwaysShowNote = draft.alwaysShowNote;
  return next;
}

function mergeDrafts(base: Draft, patch: Draft): Draft {
  return { ...base, ...patch, favorites: { ...base.favorites, ...patch.favorites } };
}

function toPatches(draft: Draft): UpdateSettingsInput[] {
  const patches: UpdateSettingsInput[] = [];
  const fields: UpdateSettingsInput = {};
  if (draft.defaultAccountId !== undefined) fields.defaultAccountId = draft.defaultAccountId;
  if (draft.alwaysShowNote !== undefined) fields.alwaysShowNote = draft.alwaysShowNote;
  if (Object.keys(fields).length > 0) patches.push(fields);
  for (const kind of FavoriteKind.options) {
    const ids = draft.favorites?.[kind];
    if (ids !== undefined) patches.push({ favoriteCategories: { kind, ids } });
  }
  return patches;
}

/**
 * Autosave of this section (RF-M9-01, plan §4.9.3): each change shows at once, is saved 300 ms after
 * the last one and rolls back if the save fails. Registrar reads its own context, so it is refreshed
 * after saving and when the screen closes (the reset button changes settings on its own).
 */
function useRegisterAutosave() {
  const queryClient = useQueryClient();
  const pending = useRef<Draft>({});
  const hasPending = useRef(false);
  const previous = useRef<SettingsDto | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Shown in the same render as the click, before the cache notifies its observers.
  const [draft, setDraft] = useState<Draft>({});

  const save = useMutation({
    mutationFn: async ({ draft: changes }: SaveVariables) => {
      for (const patch of toPatches(changes)) await call(updateSettingsEndpoint, patch);
    },
    onError: (_error, { previous: before }) => {
      if (before !== undefined) queryClient.setQueryData(SETTINGS_KEY, before);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
        queryClient.invalidateQueries({ queryKey: REGISTER_CONTEXT_KEY }),
      ]),
  });
  const { mutate } = save;

  const flush = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    if (!hasPending.current) return;
    const changes = pending.current;
    const before = previous.current;
    pending.current = {};
    hasPending.current = false;
    previous.current = undefined;
    setDraft({});
    mutate({ draft: changes, previous: before });
  }, [mutate]);

  const change = useCallback(
    (patch: Draft) => {
      void queryClient.cancelQueries({ queryKey: SETTINGS_KEY });
      const current = queryClient.getQueryData<SettingsDto>(SETTINGS_KEY);
      if (current === undefined) return;
      if (!hasPending.current) previous.current = current;
      hasPending.current = true;
      pending.current = mergeDrafts(pending.current, patch);
      setDraft(pending.current);
      queryClient.setQueryData<SettingsDto>(SETTINGS_KEY, applyDraft(current, patch));
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
    },
    [queryClient, flush],
  );

  // A change still waiting when the screen closes is saved right away.
  useEffect(() => flush, [flush]);
  useEffect(
    () => () => {
      void queryClient.invalidateQueries({ queryKey: REGISTER_CONTEXT_KEY });
    },
    [queryClient],
  );

  return { change, draft, isError: save.isError };
}

/**
 * `/ajustes/registrar`: default account, favorite categories, shortcuts and the always-visible note
 * (plan §4.9.4).
 */
export function RegisterSettings() {
  const { t } = useTranslation('settings');
  const settings = useSettings();
  const accounts = useAccounts('active');
  const { change, draft, isError } = useRegisterAutosave();

  if (settings.isError && settings.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('general.loadError')}
      </p>
    );
  }
  if (settings.data === undefined) return null;
  const data = applyDraft(settings.data, draft);
  const activeAccounts = accounts.data?.items ?? [];
  const choices = activeAccounts.map((account) => ({
    id: account.id,
    label: `${account.name} (${account.currencyCode})`,
  }));
  // An archived default account is cleared by the server (EC-M9-02); until then none shows chosen.
  const defaultAccountId = choices.some((choice) => choice.id === data.defaultAccountId)
    ? data.defaultAccountId
    : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('sections.register.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('general.autosave')}</p>
      </div>
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('general.saveError')}
        </p>
      )}

      <fieldset className="flex flex-col gap-2" aria-describedby="settings-default-account-hint">
        <legend className="pb-1 text-base font-medium">{t('register.defaultAccount.label')}</legend>
        <p id="settings-default-account-hint" className="text-sm text-muted-foreground">
          {t('register.defaultAccount.hint')}
        </p>
        {accounts.isError && accounts.data === undefined && (
          <p role="alert" className="text-sm text-destructive">
            {t('register.defaultAccount.loadError')}
          </p>
        )}
        {[{ id: null, label: t('register.defaultAccount.none') }, ...choices].map((choice) => (
          <label key={choice.id ?? 'none'} className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name="settings-default-account"
              checked={defaultAccountId === choice.id}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              onChange={() => {
                change({ defaultAccountId: choice.id });
              }}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </fieldset>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('register.favorites.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('register.favorites.description')}</p>
        </div>
        {FavoriteKind.options.map((kind) => (
          <FavoritesPicker
            key={kind}
            kind={kind}
            ids={data.favorites[kind]}
            onChange={(ids) => {
              change({ favorites: { [kind]: ids } });
            }}
          />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('register.shortcuts.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('register.shortcuts.description')}</p>
        </div>
        <ShortcutsManager />
      </section>

      <section className="flex flex-col gap-1">
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={data.alwaysShowNote}
            aria-describedby="settings-always-note-hint"
            className="h-4 w-4 accent-[hsl(var(--primary))]"
            onChange={(event) => {
              change({ alwaysShowNote: event.target.checked });
            }}
          />
          <span>{t('register.alwaysShowNote.label')}</span>
        </label>
        <p id="settings-always-note-hint" className="text-sm text-muted-foreground">
          {t('register.alwaysShowNote.hint')}
        </p>
      </section>

      <ResetSectionButton section="register" />
    </div>
  );
}
