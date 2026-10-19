import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  clearAllDrafts,
  clearDraft,
  createDrafts,
  loadDraft,
  saveDraft,
  useDraft,
} from '../src/lib/drafts';

// The test environment is node, which has no sessionStorage. `saveDraft`,
// `loadDraft`, `clearDraft` and `clearAllDrafts` work over sessionStorage, so
// an in-memory one is installed before the module under test is evaluated.
const { memoryStorage } = vi.hoisted(() => {
  function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
      get length() {
        return items.size;
      },
      clear() {
        items.clear();
      },
      getItem(key: string) {
        return items.get(key) ?? null;
      },
      key(index: number) {
        return [...items.keys()][index] ?? null;
      },
      removeItem(key: string) {
        items.delete(key);
      },
      setItem(key: string, value: string) {
        items.set(key, value);
      },
    };
  }
  if (!('sessionStorage' in globalThis)) {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  }
  return { memoryStorage };
});

const registerSchema = z
  .object({
    amount: z.string(),
    accountId: z.string(),
    categoryId: z.string(),
    note: z.string(),
  })
  .partial();

const draft = {
  amount: '125.50',
  accountId: 'acc-1',
  categoryId: 'cat-1',
  note: 'Almuerzo',
};

describe('drafts save/load', () => {
  it('RF-M2-10 lo guardado se restaura igual y sin issues', () => {
    const drafts = createDrafts({ storage: memoryStorage() });
    drafts.save('u1', 'register', draft);

    const result = drafts.load('u1', 'register', { schema: registerSchema });

    expect(result).not.toBeNull();
    expect(result?.value).toEqual(draft);
    expect(result?.issues).toEqual({});
  });

  it('RF-M2-10 el borrador se guarda en la clave draft:{userId}:{formKey}', () => {
    const storage = memoryStorage();
    const drafts = createDrafts({ storage });
    drafts.save('u1', 'register', draft);

    expect(storage.getItem('draft:u1:register')).not.toBeNull();
    expect(storage.length).toBe(1);
  });

  it('RF-M2-10 sin borrador guardado load devuelve null', () => {
    const drafts = createDrafts({ storage: memoryStorage() });

    expect(drafts.load('u1', 'register', { schema: registerSchema })).toBeNull();
  });

  it('RF-M2-10 un borrador que no cumple el schema se descarta y se borra del storage', () => {
    const storage = memoryStorage();
    const drafts = createDrafts({ storage });
    drafts.save('u1', 'register', { amount: 125, accountId: ['acc-1'] });

    expect(drafts.load('u1', 'register', { schema: registerSchema })).toBeNull();
    expect(storage.getItem('draft:u1:register')).toBeNull();
    expect(drafts.load('u1', 'register', { schema: registerSchema })).toBeNull();
  });

  it('RF-M2-10 un borrador nuevo reemplaza al anterior del mismo formulario', () => {
    const drafts = createDrafts({ storage: memoryStorage() });
    drafts.save('u1', 'register', draft);
    drafts.save('u1', 'register', { amount: '10.00' });

    expect(drafts.load('u1', 'register', { schema: registerSchema })?.value).toEqual({ amount: '10.00' });
  });

  it('RF-M2-10 los borradores de distintos formularios y usuarios no se mezclan', () => {
    const drafts = createDrafts({ storage: memoryStorage() });
    drafts.save('u1', 'register', draft);
    drafts.save('u1', 'transfer', { amount: '1.00' });
    drafts.save('u2', 'register', { amount: '2.00' });

    expect(drafts.load('u1', 'register', { schema: registerSchema })?.value).toEqual(draft);
    expect(drafts.load('u1', 'transfer', { schema: registerSchema })?.value).toEqual({ amount: '1.00' });
    expect(drafts.load('u2', 'register', { schema: registerSchema })?.value).toEqual({ amount: '2.00' });
  });

  it('RF-M2-10 clear descarta solo el borrador de ese formulario (Limpiar o Cancelar)', () => {
    const storage = memoryStorage();
    const drafts = createDrafts({ storage });
    drafts.save('u1', 'register', draft);
    drafts.save('u1', 'transfer', { amount: '1.00' });

    drafts.clear('u1', 'register');

    expect(storage.getItem('draft:u1:register')).toBeNull();
    expect(drafts.load('u1', 'register', { schema: registerSchema })).toBeNull();
    expect(drafts.load('u1', 'transfer', { schema: registerSchema })?.value).toEqual({ amount: '1.00' });
  });
});

describe('drafts validateRefs', () => {
  it('RF-M2-11 una cuenta que ya no está activa se vacía y se marca para elegir otra', () => {
    const drafts = createDrafts({ storage: memoryStorage() });
    drafts.save('u1', 'register', draft);

    const result = drafts.load('u1', 'register', {
      schema: registerSchema,
      validateRefs: (v: z.infer<typeof registerSchema>) => (v.accountId === 'acc-1' ? { accountId: 'reselect' } : {}),
    });

    expect(result).not.toBeNull();
    expect(result?.value).toEqual({ amount: '125.50', categoryId: 'cat-1', note: 'Almuerzo' });
    expect(result?.value).not.toHaveProperty('accountId');
    expect(result?.issues).toEqual({ accountId: 'reselect' });
  });

  it('RF-M2-11 una cuenta y una categoría no activas se vacían ambas y quedan en issues', () => {
    const drafts = createDrafts({ storage: memoryStorage() });
    drafts.save('u1', 'register', draft);

    const result = drafts.load('u1', 'register', {
      schema: registerSchema,
      validateRefs: () => ({ accountId: 'reselect', categoryId: 'reselect' }),
    });

    expect(result?.value).toEqual({ amount: '125.50', note: 'Almuerzo' });
    expect(result?.issues).toEqual({ accountId: 'reselect', categoryId: 'reselect' });
  });

  it('RF-M2-11 validateRefs recibe el valor restaurado y sin referencias inactivas no hay issues', () => {
    const drafts = createDrafts({ storage: memoryStorage() });
    drafts.save('u1', 'register', draft);
    const validateRefs = vi.fn(() => ({}));

    const result = drafts.load('u1', 'register', { schema: registerSchema, validateRefs });

    expect(validateRefs).toHaveBeenCalledWith(draft);
    expect(result?.value).toEqual(draft);
    expect(result?.issues).toEqual({});
  });
});

describe('drafts clearAll', () => {
  it('EC-M2-01 clearAll borra todos los borradores del usuario anterior', () => {
    const storage = memoryStorage();
    const drafts = createDrafts({ storage });
    drafts.save('u1', 'register', draft);
    drafts.save('u1', 'transfer', { amount: '1.00' });

    drafts.clearAll('u1');

    expect(storage.getItem('draft:u1:register')).toBeNull();
    expect(storage.getItem('draft:u1:transfer')).toBeNull();
    expect(drafts.load('u1', 'register', { schema: registerSchema })).toBeNull();
    expect(drafts.load('u1', 'transfer', { schema: registerSchema })).toBeNull();
  });

  it('EC-M2-01 clearAll no toca los borradores de otro usuario ni otras claves', () => {
    const storage = memoryStorage();
    storage.setItem('ui-store', '{"tabMemory":{}}');
    const drafts = createDrafts({ storage });
    drafts.save('u1', 'register', draft);
    drafts.save('u2', 'register', { amount: '2.00' });

    drafts.clearAll('u1');

    expect(drafts.load('u2', 'register', { schema: registerSchema })?.value).toEqual({ amount: '2.00' });
    expect(storage.getItem('ui-store')).toBe('{"tabMemory":{}}');
  });

  it('EC-M2-01 clearAllDrafts borra de sessionStorage los borradores del usuario anterior', () => {
    sessionStorage.clear();
    saveDraft('prev', 'register', draft);
    saveDraft('prev', 'transfer', { amount: '1.00' });
    saveDraft('next', 'register', { amount: '3.00' });

    clearAllDrafts('prev');

    expect(sessionStorage.getItem('draft:prev:register')).toBeNull();
    expect(sessionStorage.getItem('draft:prev:transfer')).toBeNull();
    expect(loadDraft('prev', 'register', { schema: registerSchema })).toBeNull();
    expect(loadDraft('next', 'register', { schema: registerSchema })?.value).toEqual({ amount: '3.00' });
  });
});

describe('drafts nuevo inicio de sesión', () => {
  it('RF-M7-08 el borrador sobrevive a un nuevo inicio de sesión del mismo usuario', () => {
    const storage = memoryStorage();
    createDrafts({ storage }).save('u1', 'register', draft);

    // A new sign-in of the same user recreates the app state over the same storage.
    const afterSignIn = createDrafts({ storage });

    expect(afterSignIn.load('u1', 'register', { schema: registerSchema })?.value).toEqual(draft);
  });

  it('RF-M7-08 limpiar los borradores de otro usuario conserva los del usuario que vuelve', () => {
    const storage = memoryStorage();
    const drafts = createDrafts({ storage });
    drafts.save('u1', 'register', draft);
    drafts.save('u2', 'register', { amount: '2.00' });

    drafts.clearAll('u2');

    expect(createDrafts({ storage }).load('u1', 'register', { schema: registerSchema })?.value).toEqual(draft);
  });
});

describe('drafts sobre sessionStorage', () => {
  it('TASK-043 saveDraft, loadDraft y clearDraft trabajan sobre sessionStorage', () => {
    sessionStorage.clear();
    saveDraft('u1', 'register', draft);

    expect(sessionStorage.getItem('draft:u1:register')).not.toBeNull();
    expect(loadDraft('u1', 'register', { schema: registerSchema })?.value).toEqual(draft);

    clearDraft('u1', 'register');

    expect(sessionStorage.getItem('draft:u1:register')).toBeNull();
    expect(loadDraft('u1', 'register', { schema: registerSchema })).toBeNull();
  });

  it('TASK-043 useDraft se exporta como hook', () => {
    expect(typeof useDraft).toBe('function');
  });
});
