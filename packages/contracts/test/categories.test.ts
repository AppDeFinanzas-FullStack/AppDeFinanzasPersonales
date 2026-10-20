import { describe, expect, it } from 'vitest';

import {
  ArchiveImpactDto,
  CategoryNode,
  CreateCategoryInput,
  MergeInput,
  MergePreviewDto,
  ReorderCategoriesInput,
  RestoreCategoryInput,
  UpdateCategoryInput,
} from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const id2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const validCreate = {
  id,
  kind: 'expense',
  parentId: null,
  name: 'Comida',
  color: 'blue',
  icon: 'wallet',
};

describe('CreateCategoryInput', () => {
  it('RF-M5-02 un nombre de 30 caracteres es válido y uno de 31 es inválido', () => {
    expect(ok(CreateCategoryInput, { ...validCreate, name: 'a'.repeat(30) })).toBe(true);
    expect(ok(CreateCategoryInput, { ...validCreate, name: 'a'.repeat(31) })).toBe(false);
  });

  it('RF-M5-02 un nombre vacío o de solo espacios es inválido', () => {
    expect(ok(CreateCategoryInput, { ...validCreate, name: '' })).toBe(false);
    expect(ok(CreateCategoryInput, { ...validCreate, name: '   ' })).toBe(false);
  });

  it('RF-M5-01 acepta gasto e ingreso y rechaza otros tipos', () => {
    expect(ok(CreateCategoryInput, { ...validCreate, kind: 'income' })).toBe(true);
    expect(ok(CreateCategoryInput, { ...validCreate, kind: 'transfer' })).toBe(false);
  });

  it('RF-M5-04 el color es opcional al crear', () => {
    expect(ok(CreateCategoryInput, { ...validCreate, color: undefined })).toBe(true);
  });

  it('RF-M5-04 el ícono es obligatorio y debe ser de la galería', () => {
    expect(ok(CreateCategoryInput, { ...validCreate, icon: undefined })).toBe(false);
    expect(ok(CreateCategoryInput, { ...validCreate, icon: 'no-existe' })).toBe(false);
  });

  it('RF-M5-04 el color debe ser de la paleta', () => {
    expect(ok(CreateCategoryInput, { ...validCreate, color: '#ff0000' })).toBe(false);
  });

  it('TASK-109 id UUID y parentId UUID o null', () => {
    expect(ok(CreateCategoryInput, { ...validCreate, id: 'x' })).toBe(false);
    expect(ok(CreateCategoryInput, { ...validCreate, parentId: id2 })).toBe(true);
    expect(ok(CreateCategoryInput, { ...validCreate, parentId: 'x' })).toBe(false);
  });
});

describe('UpdateCategoryInput', () => {
  it('RF-M5-01 rechaza kind', () => {
    expect(ok(UpdateCategoryInput, { kind: 'income' })).toBe(false);
    expect(ok(UpdateCategoryInput, { name: 'Comida', kind: 'income' })).toBe(false);
  });

  it('RF-M5-02 valida el largo del nombre al editar', () => {
    expect(ok(UpdateCategoryInput, { name: 'a'.repeat(30) })).toBe(true);
    expect(ok(UpdateCategoryInput, { name: 'a'.repeat(31) })).toBe(false);
  });

  it('TASK-109 es parcial y estricto', () => {
    expect(ok(UpdateCategoryInput, {})).toBe(true);
    expect(ok(UpdateCategoryInput, { color: 'red', icon: 'wallet', parentId: null })).toBe(true);
    expect(ok(UpdateCategoryInput, { otro: 1 })).toBe(false);
  });
});

describe('ReorderCategoriesInput', () => {
  it('TASK-109 acepta kind, parentId e ids UUID', () => {
    expect(ok(ReorderCategoriesInput, { kind: 'expense', parentId: null, ids: [id, id2] })).toBe(
      true,
    );
    expect(ok(ReorderCategoriesInput, { kind: 'expense', parentId: null, ids: ['x'] })).toBe(
      false,
    );
    expect(ok(ReorderCategoriesInput, { kind: 'otro', parentId: null, ids: [] })).toBe(false);
  });
});

describe('RestoreCategoryInput', () => {
  it('TASK-109 childIds por defecto es un arreglo vacío', () => {
    const r = RestoreCategoryInput.parse({}) as { childIds: string[] };
    expect(r.childIds).toEqual([]);
  });

  it('RF-M5-02 newName respeta el máximo de 30', () => {
    expect(ok(RestoreCategoryInput, { newName: 'a'.repeat(30) })).toBe(true);
    expect(ok(RestoreCategoryInput, { newName: 'a'.repeat(31) })).toBe(false);
  });
});

describe('MergeInput', () => {
  it('TASK-109 exige fromId y toId UUID', () => {
    expect(ok(MergeInput, { fromId: id, toId: id2 })).toBe(true);
    expect(ok(MergeInput, { fromId: id })).toBe(false);
    expect(ok(MergeInput, { fromId: id, toId: 'x' })).toBe(false);
  });
});

describe('DTOs', () => {
  const node = {
    id,
    kind: 'expense',
    name: 'Comida',
    color: 'blue',
    icon: 'wallet',
    isSystem: false,
    status: 'active',
    children: [],
  };

  it('TASK-109 CategoryNode acepta hijos anidados', () => {
    expect(ok(CategoryNode, node)).toBe(true);
    expect(ok(CategoryNode, { ...node, children: [{ ...node, id: id2 }] })).toBe(true);
    expect(ok(CategoryNode, { ...node, children: [{ id: id2 }] })).toBe(false);
  });

  it('TASK-109 ArchiveImpactDto describe hijos, presupuestos, recurrentes y atajos', () => {
    const dto = {
      children: [{ id, name: 'a' }],
      budgets: [{ id }],
      recurring: [{ id, name: 'r' }],
      shortcuts: [{ id, name: 's' }],
    };
    expect(ok(ArchiveImpactDto, dto)).toBe(true);
    expect(ok(ArchiveImpactDto, { ...dto, budgets: undefined })).toBe(false);
  });

  it('TASK-109 MergePreviewDto restringe budgetEffect', () => {
    expect(ok(MergePreviewDto, { movements: 3, budgetEffect: 'moved' })).toBe(true);
    expect(ok(MergePreviewDto, { movements: 0, budgetEffect: 'kept_target' })).toBe(true);
    expect(ok(MergePreviewDto, { movements: 0, budgetEffect: 'none' })).toBe(true);
    expect(ok(MergePreviewDto, { movements: 0, budgetEffect: 'otro' })).toBe(false);
  });
});
