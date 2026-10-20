import { useTranslation } from 'react-i18next';

export type RegisterKind = 'expense' | 'income' | 'transfer';

interface KindToggleProps {
  value: RegisterKind;
  /** The kinds the form offers, in their order. */
  kinds: readonly RegisterKind[];
  onChange: (kind: RegisterKind) => void;
}

/**
 * `<KindToggle>` (Gasto · Ingreso · Transferencia, plan §4.7.4). Toggle buttons, so the kind is
 * changed with Tab and Enter alone (RF-M7-12).
 */
export function KindToggle({ value, kinds, onChange }: KindToggleProps) {
  const { t } = useTranslation('register');
  return (
    <div
      role="group"
      aria-label={t('kind.label')}
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-md border border-border p-1"
    >
      {kinds.map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={value === kind}
          className="h-11 rounded-[calc(var(--radius)-2px)] text-sm font-medium text-muted-foreground aria-pressed:bg-secondary aria-pressed:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            onChange(kind);
          }}
        >
          {t(`kind.${kind}`)}
        </button>
      ))}
    </div>
  );
}
