import { CategoryKind, type CategoryNode, type Step3Input } from '@finanzas/contracts';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldSelect } from '@/features/accounts/components/account-form';
import { useMe } from '@/features/auth/hooks/use-me';
import { useDraft } from '@/lib/drafts';

const NAME_MAX = 30;
/** The icon a category created here starts with; it can be changed later in Categorías. */
const NEW_CATEGORY_ICON = 'tag';
const KINDS = CategoryKind.options;

/** A category added in this step; it is created when the step is sent. */
const AddedCategory = z.object({
  id: z.string(),
  kind: CategoryKind,
  name: z.string(),
});
type AddedCategory = z.infer<typeof AddedCategory>;

/** What the user changed in the tree: the unchecked ids and the categories added. */
const CategoriesFormValues = z.object({
  unchecked: z.array(z.string()),
  added: z.array(AddedCategory),
});
type CategoriesFormValues = z.infer<typeof CategoriesFormValues>;

const DraftSchema = CategoriesFormValues.partial();

export interface CategoriesStepProps {
  /** The categories of the user, expense and income, as two-level trees. */
  categories: CategoryNode[];
  busy: boolean;
  /** Sends the step; `onSaved` runs once it is saved, so the draft can go. */
  onContinue: (input: Step3Input, onSaved: () => void) => void;
}

/** Step 3: the tree of categories with a checkbox each (spec §2.10.1, plan §4.10.4). */
export function CategoriesStep({ categories, busy, onContinue }: CategoriesStepProps) {
  const { t } = useTranslation('onboarding');
  const me = useMe();
  const form = useForm<CategoriesFormValues>({ defaultValues: { unchecked: [], added: [] } });
  const draft = useDraft('onboarding-step3', form, {
    userId: me.data?.id ?? '',
    schema: DraftSchema,
  });
  const unchecked = useWatch({ control: form.control, name: 'unchecked' });
  const added = useWatch({ control: form.control, name: 'added' });
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<CategoryKind>('expense');
  const [nameError, setNameError] = useState<string | null>(null);

  function setUnchecked(next: string[]) {
    form.setValue('unchecked', next, { shouldDirty: true });
  }

  function setAdded(next: AddedCategory[]) {
    form.setValue('added', next, { shouldDirty: true });
  }

  /** Unchecking a parent unchecks its subcategories; checking a subcategory checks its parent. */
  function toggle(node: CategoryNode, parent: CategoryNode | null, checked: boolean) {
    if (node.isSystem) return;
    const current = form.getValues('unchecked');
    if (parent === null) {
      const family = [node, ...node.children].filter((each) => !each.isSystem).map((each) => each.id);
      setUnchecked(
        checked
          ? current.filter((id) => !family.includes(id))
          : [...new Set([...current, ...family])],
      );
      return;
    }
    setUnchecked(
      checked
        ? current.filter((id) => id !== node.id && id !== parent.id)
        : [...new Set([...current, node.id])],
    );
  }

  function nameTaken(name: string, kind: CategoryKind): boolean {
    const wanted = name.toLowerCase();
    return (
      categories.some((node) => node.kind === kind && node.name.toLowerCase() === wanted) ||
      added.some((each) => each.kind === kind && each.name.toLowerCase() === wanted)
    );
  }

  function closeAdding() {
    setAdding(false);
    setNewName('');
    setNameError(null);
  }

  function addCategory() {
    const name = newName.trim();
    if (name.length === 0 || name.length > NAME_MAX) {
      setNameError(t('categories.errors.name'));
      return;
    }
    if (nameTaken(name, newKind)) {
      setNameError(t('categories.errors.nameTaken'));
      return;
    }
    setAdded([...added, { id: uuidv7(), kind: newKind, name }]);
    closeAdding();
  }

  function submit() {
    const known = new Set(categories.flatMap((node) => [node, ...node.children]));
    const removable = new Set(
      [...known].filter((node) => !node.isSystem).map((node) => node.id),
    );
    onContinue(
      {
        removeCategoryIds: unchecked.filter((id) => removable.has(id)),
        newCategories: added.map((each) => ({
          id: each.id,
          kind: each.kind,
          parentId: null,
          name: each.name,
          icon: NEW_CATEGORY_ICON,
        })),
      },
      draft.clear,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p>{t('categories.intro')}</p>
      {KINDS.map((kind) => {
        const roots = categories.filter((node) => node.kind === kind);
        const extra = added.filter((each) => each.kind === kind);
        const headingId = `onboarding-categories-${kind}`;
        return (
          <section key={kind} aria-labelledby={headingId} className="flex flex-col gap-2">
            <h2 id={headingId} className="text-base font-semibold">
              {t(`categories.kinds.${kind}`)}
            </h2>
            <ul className="flex flex-col">
              {roots.map((node) => (
                <li key={node.id}>
                  <CategoryCheckbox
                    node={node}
                    checked={node.isSystem || !unchecked.includes(node.id)}
                    onToggle={(checked) => {
                      toggle(node, null, checked);
                    }}
                  />
                  {node.children.length > 0 && (
                    <ul className="ml-8 flex flex-col">
                      {node.children.map((child) => (
                        <li key={child.id}>
                          <CategoryCheckbox
                            node={child}
                            checked={child.isSystem || !unchecked.includes(child.id)}
                            onToggle={(checked) => {
                              toggle(child, node, checked);
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {extra.map((each) => (
                <li key={each.id} className="flex min-h-11 items-center justify-between gap-3">
                  <span>{each.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11"
                    aria-label={t('categories.removeLabel', { name: each.name })}
                    onClick={() => {
                      setAdded(added.filter((other) => other.id !== each.id));
                    }}
                  >
                    {t('categories.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {adding ? (
        <form
          noValidate
          className="flex flex-col gap-4 rounded-md border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            addCategory();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="onboarding-new-category-name">{t('categories.name')}</Label>
            <Input
              id="onboarding-new-category-name"
              autoComplete="off"
              maxLength={NAME_MAX}
              className="h-11"
              value={newName}
              aria-invalid={nameError !== null}
              aria-describedby={nameError === null ? undefined : 'onboarding-new-category-error'}
              onChange={(event) => {
                setNewName(event.target.value);
              }}
            />
            {nameError !== null && (
              <p id="onboarding-new-category-error" className="text-sm text-destructive">
                {nameError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="onboarding-new-category-kind">{t('categories.kind')}</Label>
            <FieldSelect
              id="onboarding-new-category-kind"
              value={newKind}
              onChange={(event) => {
                const kind = CategoryKind.safeParse(event.target.value);
                if (kind.success) setNewKind(kind.data);
              }}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`categories.kindOptions.${kind}`)}
                </option>
              ))}
            </FieldSelect>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" className="h-11">
              {t('categories.confirmAdd')}
            </Button>
            <Button type="button" variant="ghost" className="h-11" onClick={closeAdding}>
              {t('categories.cancelAdd')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="h-11 self-start"
          onClick={() => {
            setAdding(true);
          }}
        >
          {t('categories.add')}
        </Button>
      )}
      <Button
        type="button"
        className="h-11"
        disabled={busy || me.data === undefined}
        onClick={submit}
      >
        {t('categories.continue')}
      </Button>
    </div>
  );
}

function CategoryCheckbox({
  node,
  checked,
  onToggle,
}: {
  node: CategoryNode;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const { t } = useTranslation('onboarding');
  return (
    <div className="flex min-h-11 flex-col justify-center">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={node.isSystem}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
          onChange={(event) => {
            onToggle(event.target.checked);
          }}
        />
        {node.name}
      </label>
      {node.isSystem && (
        <p className="ml-7 text-sm text-muted-foreground">{t('categories.systemHint')}</p>
      )}
    </div>
  );
}
