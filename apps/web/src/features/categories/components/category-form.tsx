import {
  CreateCategoryInput,
  IconKey,
  PaletteKey,
  UpdateCategoryInput,
  type CategoryNode,
} from '@finanzas/contracts';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/features/auth/hooks/use-me';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { useDraft } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

import { useCategories } from '../hooks/use-categories';

import { ColorPalette } from './color-palette';
import { IconGallery } from './icon-gallery';

const createEndpoint: Endpoint<CreateCategoryInput, unknown> = {
  method: 'POST',
  path: '/api/categories',
  input: CreateCategoryInput,
  output: z.unknown(),
};

const updateEndpoint = (id: string): Endpoint<UpdateCategoryInput, unknown> => ({
  method: 'PATCH',
  path: `/api/categories/${encodeURIComponent(id)}`,
  input: UpdateCategoryInput,
  output: z.unknown(),
});

/** What a change of categories can alter on other screens (plan §4.5.4). */
export async function invalidateAfterCategoryChange(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    ['categories', 'transactions', 'dashboard', 'budgets'].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}

const FormValues = z.object({
  name: z.string(),
  parentId: z.string(),
  color: PaletteKey.nullable(),
  icon: IconKey,
});
type FormValues = z.infer<typeof FormValues>;

const NAME_MAX = 30;

/**
 * Creates or edits a category, with a draft (plan §4.5.4): name, parent of the same kind (or none
 * for a main one), color and icon. A subcategory without a color takes its parent's (RF-M5-04).
 */
export function CategoryForm({
  kind,
  category,
  onDone,
}: {
  kind: 'expense' | 'income';
  category?: CategoryNode & { parentId: string | null };
  onDone: () => void;
}) {
  const { t } = useTranslation('categories');
  const me = useMe();
  const queryClient = useQueryClient();
  const roots = useCategories({ kind, status: 'active' });
  const [formError, setFormError] = useState<string | null>(null);
  const editing = category !== undefined;

  const form = useForm<FormValues>({
    defaultValues: {
      name: category?.name ?? '',
      parentId: category?.parentId ?? '',
      color: category?.color ?? null,
      icon: category?.icon ?? 'tag',
    },
  });
  const draft = useDraft(editing ? `category:${category.id}` : `category:new:${kind}`, form, {
    userId: me.data?.id ?? '',
    schema: FormValues.partial(),
  });
  const color = useWatch({ control: form.control, name: 'color' });
  const icon = useWatch({ control: form.control, name: 'icon' });

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      const parentId = values.parentId === '' ? null : values.parentId;
      if (editing) {
        await call(updateEndpoint(category.id), {
          name: values.name.trim(),
          parentId,
          icon: values.icon,
          ...(values.color === null ? {} : { color: values.color }),
        });
        return;
      }
      await call(createEndpoint, {
        id: uuidv7(),
        kind,
        parentId,
        name: values.name.trim(),
        icon: values.icon,
        ...(values.color === null ? {} : { color: values.color }),
      });
    },
    onSuccess: async () => {
      draft.clear();
      await invalidateAfterCategoryChange(queryClient);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'NAME_TAKEN') {
        form.setError('name', { message: t('form.errors.nameTaken') });
        return;
      }
      setFormError(messageForError(error instanceof ApiError ? error : { code: '' }));
    },
  });

  const submit = form.handleSubmit((values) => {
    const name = values.name.trim();
    if (name.length === 0 || name.length > NAME_MAX) {
      form.setError('name', { message: t('form.errors.name') });
      return;
    }
    setFormError(null);
    save.mutate(values);
  });

  const parents = (roots.data ?? []).filter((root) => root.id !== category?.id);
  const nameError = form.formState.errors.name?.message;

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="category-name">{t('form.name')}</Label>
        <Input
          id="category-name"
          className="h-11"
          aria-invalid={nameError !== undefined}
          aria-describedby={nameError === undefined ? undefined : 'category-name-error'}
          {...form.register('name')}
        />
        {nameError !== undefined && (
          <p id="category-name-error" className="text-sm text-destructive">
            {nameError}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="category-parent">{t('form.parent')}</Label>
        <select
          id="category-parent"
          className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          {...form.register('parentId')}
        >
          <option value="">{t('form.noParent')}</option>
          {parents.map((root) => (
            <option key={root.id} value={root.id}>
              {root.name}
            </option>
          ))}
        </select>
      </div>
      <ColorPalette
        value={color}
        onChange={(next) => {
          form.setValue('color', next, { shouldDirty: true });
        }}
      />
      <IconGallery
        value={icon}
        onChange={(next) => {
          form.setValue('icon', next, { shouldDirty: true });
        }}
      />
      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <Button type="submit" className="h-11" disabled={save.isPending}>
        {t('form.save')}
      </Button>
    </form>
  );
}
