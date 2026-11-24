import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** The note of the movement, up to 140 characters (RF-M6-03). */
export function NoteField({ value, onChange }: { value: string; onChange: (note: string) => void }) {
  const { t } = useTranslation('register');
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="register-note">{t('second.note')}</Label>
      <Input
        id="register-note"
        className="h-11"
        maxLength={140}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

interface SecondLevelProps {
  /** `null` when the note already shows on the first level (RF-M7-13). */
  note: { value: string; onChange: (note: string) => void } | null;
  /** The fee, for a transfer. */
  fee: ReactNode;
  onSaveAsShortcut: () => void;
}

/**
 * `<SecondLevel>` (plan §4.7.4): what Registrar does not ask on its first level — the optional note,
 * the fee of a transfer and "Guardar como atajo". The account and the date are on the first level.
 */
export function SecondLevel({ note, fee, onSaveAsShortcut }: SecondLevelProps) {
  const { t } = useTranslation('register');
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="ghost"
        className="h-11 self-start"
        aria-expanded={open}
        aria-controls="register-second-level"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {t(open ? 'second.hide' : 'second.show')}
      </Button>
      {open && (
        <div id="register-second-level" className="flex flex-col gap-4">
          {note !== null && <NoteField value={note.value} onChange={note.onChange} />}
          {fee}
          <Button type="button" variant="outline" className="h-11 self-start" onClick={onSaveAsShortcut}>
            {t('second.saveAsShortcut')}
          </Button>
        </div>
      )}
    </div>
  );
}
