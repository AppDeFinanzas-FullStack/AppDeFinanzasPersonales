import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * What the amount may hold while typing (RF-M7-02): digits and one final "." or "," with up to 2
 * digits, whatever the number format. No thousands separators nor operations.
 */
const TYPING = /^\d{0,12}([.,]\d{0,2})?$/;

interface AmountInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  inputRef: Ref<HTMLInputElement>;
}

/**
 * `<AmountInput inputMode="decimal">` (plan §4.7.4): the main figure of Registrar. Enter inside it
 * submits the form, which saves only when it is ready (RF-M7-12).
 */
export function AmountInput({ id, value, onChange, inputRef }: AmountInputProps) {
  const { t } = useTranslation('register');
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {t('amount.label')}
      </label>
      <input
        ref={inputRef}
        id={id}
        name="amount"
        inputMode="decimal"
        autoComplete="off"
        enterKeyHint="done"
        placeholder="0"
        className="h-14 w-full rounded-md border border-input bg-background px-3 text-[2rem] font-semibold tabular-nums ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        value={value}
        onChange={(event) => {
          if (TYPING.test(event.target.value)) onChange(event.target.value);
        }}
      />
    </div>
  );
}
