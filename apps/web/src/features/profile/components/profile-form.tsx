import { zodResolver } from '@hookform/resolvers/zod';
import { UpdateMeInput, type MeDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ME_QUERY_KEY } from '@/features/auth/hooks/use-me';
import { ApiError, call } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { updateMeEndpoint } from '../api';

const PROFILE_DRAFT_KEY = 'profile';

const ProfileFields = UpdateMeInput.required();
type ProfileFields = z.infer<typeof ProfileFields>;

const ProfileDraft = z.object({ name: z.string().optional(), timezone: z.string().optional() });

/** Every IANA zone the browser knows, always including the one the profile already has. */
function timezoneOptions(current: string): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes(current) ? zones : [current, ...zones].sort();
}

function zoneLabel(zone: string): string {
  return zone.replaceAll('_', ' ');
}

/** Name, time zone, fixed language and read-only email of the profile (RF-M1-11, RF-M1-13). */
export function ProfileForm({ me }: { me: MeDto }) {
  const { t } = useTranslation('profile');
  const queryClient = useQueryClient();
  const form = useForm<ProfileFields>({
    resolver: zodResolver(ProfileFields),
    defaultValues: { name: me.name, timezone: me.timezone },
  });
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = form;
  const draft = useDraft(PROFILE_DRAFT_KEY, form, { userId: me.id, schema: ProfileDraft });
  const zones = useMemo(() => timezoneOptions(me.timezone), [me.timezone]);

  const update = useMutation({
    mutationFn: (input: UpdateMeInput) => call(updateMeEndpoint, input),
    onSuccess: (profile) => {
      queryClient.setQueryData(ME_QUERY_KEY, profile);
      reset({ name: profile.name, timezone: profile.timezone });
      draft.clear();
    },
  });

  const onSubmit = handleSubmit((values) => {
    update.mutate({ name: values.name, timezone: values.timezone });
  });

  return (
    <section aria-labelledby="profile-details" className="flex flex-col gap-4">
      <h2 id="profile-details" className="text-lg font-semibold">
        {t('details.title')}
      </h2>
      {draft.restoredWithIssues && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('details.draftIssues')}
        </p>
      )}
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-name">{t('details.name')}</Label>
          <Input
            id="profile-name"
            autoComplete="name"
            className="h-11"
            aria-invalid={errors.name !== undefined}
            {...register('name')}
          />
          {errors.name !== undefined && (
            <p className="text-sm text-destructive">{t('details.errors.name')}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-timezone">{t('details.timezone')}</Label>
          <select
            id="profile-timezone"
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm"
            {...register('timezone')}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zoneLabel(zone)}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground">{t('details.timezoneHint')}</p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('details.language')}</span>
          <p>{t('details.languageValue')}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-email">{t('details.email')}</Label>
          <Input
            id="profile-email"
            type="email"
            className="h-11"
            value={me.email}
            readOnly
            aria-describedby="profile-email-hint"
          />
          <p id="profile-email-hint" className="text-sm text-muted-foreground">
            {t('details.emailHint')}
          </p>
        </div>
        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(update.error instanceof ApiError ? update.error : { code: '' })}
          </p>
        )}
        {update.isSuccess && !form.formState.isDirty && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('details.saved')}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={update.isPending}>
          {update.isPending ? t('details.submitting') : t('details.submit')}
        </Button>
      </form>
    </section>
  );
}
