import type { ShortcutDto } from '@finanzas/contracts';

/**
 * `<ShortcutChips>` (plan §4.7.4): the visible shortcuts of the current kind. Tapping one fills the
 * form without saving it (RF-M7-09).
 */
export function ShortcutChips({
  shortcuts,
  onPick,
}: {
  shortcuts: readonly ShortcutDto[];
  onPick: (shortcut: ShortcutDto) => void;
}) {
  if (shortcuts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {shortcuts.map((shortcut) => (
        <button
          key={shortcut.id}
          type="button"
          className="h-11 rounded-full border border-border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            onPick(shortcut);
          }}
        >
          {shortcut.name}
        </button>
      ))}
    </div>
  );
}
