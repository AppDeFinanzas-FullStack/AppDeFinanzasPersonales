import { ResetSettingsInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { call, type Endpoint } from '@/lib/api-client';

import { SETTINGS_KEY } from '../hooks/use-settings';

const resetSettingsEndpoint: Endpoint<ResetSettingsInput, void> = {
  method: 'POST',
  path: '/api/settings/reset',
  input: ResetSettingsInput,
  output: z.void(),
};

export type SettingsSection = ResetSettingsInput['section'];

/** "Restablecer valores por defecto" of one section, with confirmation (RF-M9-05, plan §4.9.4). */
export function ResetSectionButton({ section }: { section: SettingsSection }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const reset = useMutation({
    mutationFn: () => call(resetSettingsEndpoint, { section }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      setOpen(false);
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 self-start"
        onClick={() => {
          reset.reset();
          setOpen(true);
        }}
      >
        {t('reset.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('reset.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('reset.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          {reset.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('reset.error')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('reset.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              disabled={reset.isPending}
              onClick={(event) => {
                event.preventDefault();
                reset.mutate();
              }}
            >
              {t('reset.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
