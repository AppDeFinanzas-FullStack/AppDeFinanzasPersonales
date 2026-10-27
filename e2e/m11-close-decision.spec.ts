import { randomUUID } from 'node:crypto';

import type { Locator, Page, Request } from '@playwright/test';

import { expect, test, type TestUser } from './fixtures/auth.js';

const API_URL = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;
const ZONE = 'America/La_Paz';

type Json = Record<string, unknown>;

/** Today in the zone of the test user (`YYYY-MM-DD`), never the UTC day. */
function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
}

/** A local date `days` after today in the zone of the test user. */
function localDaysAhead(days: number): string {
  const [year, month, day] = localToday().split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

interface CategoryNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  isSystem?: boolean;
  children: CategoryNode[];
}

/** The preset root category "Comida" of the user. */
async function comidaCategoryId(page: Page): Promise<string> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const roots = (await res.json()) as CategoryNode[];
  const node = roots.find((n) => n.name === 'Comida');
  expect(node).toBeDefined();
  return node?.id ?? '';
}

async function createAccount(page: Page, name: string, initialBalance: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'bank',
      name,
      currencyCode: 'BOB',
      initialBalance,
      initialBalanceDate: localToday(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function createGoal(page: Page, name: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/goals', {
    data: { id, name, target: '3000.00', currencyCode: 'BOB', icon: 'plane', color: 'blue' },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function archiveGoal(page: Page, goalId: string): Promise<void> {
  const res = await page.request.post(`/api/goals/${goalId}/archive`);
  expect(res.ok()).toBe(true);
}

async function createBudget(page: Page, data: Json): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/budgets', {
    data: { id, currencyCode: 'BOB', ...data },
  });
  expect(res.status()).toBe(201);
  return id;
}

/** The budget "Comida" of Bs 800,00 (scenario "Repartir un sobrante"). */
async function createComidaBudget(page: Page): Promise<string> {
  return createBudget(page, {
    scope: 'category',
    categoryId: await comidaCategoryId(page),
    amount: '800.00',
  });
}

interface CloseState {
  budgetId: string;
  periodId: string;
  /** The result of the closed period: positive is a surplus, negative an excess. */
  result: string;
  status?: string;
  pending: boolean;
  /** The period in course after the decision is applied. */
  afterDecision?: Json;
  decisions: Json[];
}

/**
 * A closed period only exists after the close job runs on a past period, so the reads of the budget
 * are served with a pending close decision (`pendingClose`, plan §4.11.2), and the decision endpoint
 * is answered with its 204 while recording the body the interface sent.
 */
async function serveClose(page: Page, input: Omit<CloseState, 'pending' | 'decisions'>): Promise<CloseState> {
  const state: CloseState = { ...input, pending: true, decisions: [] };
  await page.route(
    new RegExp(`/api/budgets/${state.budgetId}/periods/${state.periodId}/decision$`),
    async (route) => {
      state.decisions.push(route.request().postDataJSON() as Json);
      state.pending = false;
      await route.fulfill({ status: 204, body: '' });
    },
  );
  await page.route(/\/api\/budgets(\/[^/?]+)?(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as Json & { items?: Json[] };
    const patch = (budget: Json): Json => {
      if (budget['id'] !== state.budgetId) {
        return budget;
      }
      const next: Json = { ...budget };
      if (state.status !== undefined) {
        next['status'] = state.status;
      }
      if (state.pending) {
        next['pendingClose'] = {
          periodId: state.periodId,
          label: 'octubre',
          result: state.result,
          deadline: localDaysAhead(7),
        };
      } else {
        delete next['pendingClose'];
        if (state.afterDecision !== undefined) {
          next['current'] = { ...(budget['current'] as Json), ...state.afterDecision };
        }
      }
      return next;
    };
    const json = Array.isArray(body.items) ? { ...body, items: body.items.map(patch) } : patch(body);
    await route.fulfill({ response, json });
  });
  return state;
}

function isDecision(state: CloseState): (req: Request) => boolean {
  return (req) =>
    req.method() === 'POST' &&
    req.url().endsWith(`/api/budgets/${state.budgetId}/periods/${state.periodId}/decision`);
}

function applyButton(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /aplicar|confirmar decisión/i });
}

/** A choice of the excess (Arrastrar or Absorber), as a button or a radio. */
function deficitChoice(scope: Page | Locator, name: RegExp): Locator {
  return scope.getByRole('button', { name }).or(scope.getByRole('radio', { name }));
}

/** Picks an option of a selector, native or listbox. */
async function pick(page: Page, field: Locator, option: string): Promise<void> {
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    await field.selectOption({ label: option });
    return;
  }
  await field.click();
  await page.getByRole('option', { name: option }).click();
}

/** The visible texts of the options of a selector, native or listbox. */
async function optionsOf(page: Page, field: Locator): Promise<string[]> {
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    return (await field.locator('option').allInnerTexts()).map((t) => t.trim());
  }
  await field.click();
  const texts = (await page.getByRole('option').allInnerTexts()).map((t) => t.trim());
  await page.keyboard.press('Escape');
  return texts;
}

function goalSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Meta', exact: true });
}

function accountSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Cuenta', exact: true });
}

/** Chooses the excess option and, when the form asks for it, confirms the decision. */
async function chooseDeficit(page: Page, scope: Page | Locator, name: RegExp): Promise<void> {
  await deficitChoice(scope, name).first().click();
  const confirm = applyButton(scope);
  if ((await confirm.count()) > 0 && (await confirm.first().isEnabled())) {
    await confirm.first().click();
  }
}

test.describe('TASK-207 decisión de cierre del presupuesto', () => {
  test('RF-M11-08 Repartir un sobrante: después de aplicar, noviembre muestra Bs 850,00 disponible', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '1000.00');
    const goal = await createGoal(authedPage, 'Viaje');
    const budgetId = await createComidaBudget(authedPage);
    const state = await serveClose(authedPage, {
      budgetId,
      periodId: randomUUID(),
      result: '150.00',
      afterDecision: {
        spent: '0.00',
        carryover: '50.00',
        available: '850.00',
        lateAdjustments: [],
      },
    });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/comida cerró octubre/i).first()).toBeVisible();
    await expect(authedPage.getByText(/sobraron.*150,00/i).first()).toBeVisible();

    await authedPage.getByLabel('Arrastrar', { exact: true }).fill('50.00');
    await authedPage.getByLabel('Enviar a meta', { exact: true }).fill('100.00');
    await authedPage.getByLabel('Descartar', { exact: true }).fill('0.00');
    await pick(authedPage, goalSelect(authedPage), 'Viaje');
    await pick(authedPage, accountSelect(authedPage), 'Banco');

    const decision = authedPage.waitForRequest(isDecision(state));
    await applyButton(authedPage).click();
    const body = (await decision).postDataJSON() as Json;
    expect(body['result']).toBe('surplus');
    expect(Number(body['carry'])).toBe(50);
    expect(Number(body['discard'])).toBe(0);
    const toGoal = body['toGoal'] as Json;
    expect(toGoal['goalId']).toBe(goal);
    expect(toGoal['accountId']).toBe(bank);
    expect(Number(toGoal['amount'])).toBe(100);
    expect(toGoal['mode']).toBe('earmark');

    await expect(authedPage.getByText(/850,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/sobraron/i)).toHaveCount(0);
  });

  test('RF-M11-08 "Aplicar" está deshabilitado mientras la suma no es exacta', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Banco', '1000.00');
    await createGoal(authedPage, 'Viaje');
    const budgetId = await createComidaBudget(authedPage);
    const state = await serveClose(authedPage, {
      budgetId,
      periodId: randomUUID(),
      result: '150.00',
    });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/sobraron.*150,00/i).first()).toBeVisible();

    await authedPage.getByLabel('Arrastrar', { exact: true }).fill('50.00');
    await authedPage.getByLabel('Enviar a meta', { exact: true }).fill('0.00');
    await authedPage.getByLabel('Descartar', { exact: true }).fill('50.00');
    await expect(applyButton(authedPage)).toBeDisabled();

    await authedPage.getByLabel('Descartar', { exact: true }).fill('150.00');
    await expect(applyButton(authedPage)).toBeDisabled();

    await authedPage.getByLabel('Descartar', { exact: true }).fill('100.00');
    await expect(applyButton(authedPage)).toBeEnabled();
    expect(state.decisions).toHaveLength(0);
  });

  test('EC-M11-03 una meta archivada desaparece de las opciones', async ({ authedPage }) => {
    await createAccount(authedPage, 'Banco', '1000.00');
    await createGoal(authedPage, 'Viaje');
    const auto = await createGoal(authedPage, 'Auto');
    const budgetId = await createComidaBudget(authedPage);
    await serveClose(authedPage, { budgetId, periodId: randomUUID(), result: '150.00' });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/sobraron.*150,00/i).first()).toBeVisible();
    const before = await optionsOf(authedPage, goalSelect(authedPage));
    expect(before).toContain('Viaje');
    expect(before).toContain('Auto');

    await archiveGoal(authedPage, auto);
    await authedPage.reload();
    await expect(authedPage.getByText(/sobraron.*150,00/i).first()).toBeVisible();
    const after = await optionsOf(authedPage, goalSelect(authedPage));
    expect(after).toContain('Viaje');
    expect(after).not.toContain('Auto');
  });

  test('RF-M11-09 con un presupuesto general, el de una categoría no ofrece enviar a meta', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Banco', '1000.00');
    await createGoal(authedPage, 'Viaje');
    await createBudget(authedPage, { scope: 'general', amount: '3000.00' });
    const budgetId = await createComidaBudget(authedPage);
    await serveClose(authedPage, { budgetId, periodId: randomUUID(), result: '150.00' });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/sobraron.*150,00/i).first()).toBeVisible();
    await expect(authedPage.getByLabel('Arrastrar', { exact: true })).toBeVisible();
    await expect(authedPage.getByLabel('Descartar', { exact: true })).toBeVisible();
    await expect(authedPage.getByLabel('Enviar a meta', { exact: true })).toHaveCount(0);
    await expect(goalSelect(authedPage)).toHaveCount(0);
  });

  test('RF-M11-08 ante un exceso, "te pasaste por" y Absorber envía la decisión', async ({
    authedPage,
  }) => {
    const budgetId = await createComidaBudget(authedPage);
    const state = await serveClose(authedPage, {
      budgetId,
      periodId: randomUUID(),
      result: '-120.00',
    });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/te pasaste por.*120,00/i).first()).toBeVisible();
    await expect(deficitChoice(authedPage, /arrastrar/i).first()).toBeVisible();
    await expect(deficitChoice(authedPage, /absorber/i).first()).toBeVisible();

    const decision = authedPage.waitForRequest(isDecision(state));
    await chooseDeficit(authedPage, authedPage, /absorber/i);
    expect((await decision).postDataJSON()).toEqual({ result: 'deficit', mode: 'absorb' });
    await expect(authedPage.getByText(/te pasaste por/i)).toHaveCount(0);
  });

  test('EC-M11-09 un presupuesto finalizado con sobrante no ofrece arrastrar', async ({
    authedPage,
  }) => {
    const budgetId = await createComidaBudget(authedPage);
    await serveClose(authedPage, {
      budgetId,
      periodId: randomUUID(),
      result: '150.00',
      status: 'finalized',
    });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/sobraron.*150,00/i).first()).toBeVisible();
    await expect(authedPage.getByLabel('Descartar', { exact: true })).toBeVisible();
    await expect(authedPage.getByLabel('Arrastrar', { exact: true })).toHaveCount(0);
  });

  test('EC-M11-09 un presupuesto finalizado con exceso ofrece absorber pero no arrastrar', async ({
    authedPage,
  }) => {
    const budgetId = await createComidaBudget(authedPage);
    await serveClose(authedPage, {
      budgetId,
      periodId: randomUUID(),
      result: '-120.00',
      status: 'finalized',
    });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/te pasaste por.*120,00/i).first()).toBeVisible();
    await expect(deficitChoice(authedPage, /absorber/i).first()).toBeVisible();
    await expect(deficitChoice(authedPage, /arrastrar/i)).toHaveCount(0);
  });
});

/** Creates the close notification of the period, as the close job does (plan §4.11.3). */
async function createCloseNotification(
  page: Page,
  user: TestUser,
  budgetId: string,
  periodId: string,
): Promise<void> {
  const res = await page.request.post(`${API_URL}/internal/test/notifications`, {
    data: {
      email: user.email,
      type: 'period_close',
      eventKey: `period_close:${periodId}`,
      params: { budgetId, periodId, categoryName: 'Comida' },
      targetRoute: `/presupuestos/${budgetId}`,
      decision: { kind: 'budget_period', ref: periodId },
    },
  });
  expect(res.status()).toBe(201);
}

test.describe('TASK-207 decisión de cierre en la bandeja', () => {
  test('RF-M15-03 la decisión se toma desde la bandeja y queda resuelta en el presupuesto', async ({
    authedPage,
    testUser,
  }) => {
    const budgetId = await createComidaBudget(authedPage);
    const periodId = randomUUID();
    const state = await serveClose(authedPage, { budgetId, periodId, result: '-120.00' });
    await createCloseNotification(authedPage, testUser, budgetId, periodId);

    await authedPage.goto('/');
    const bell = authedPage.getByRole('banner').getByRole('button', { name: /avisos/i });
    await expect(bell).toBeVisible();
    await bell.click();
    const panel = authedPage.getByRole('dialog');
    await expect(panel).toBeVisible();
    const item = panel.getByRole('listitem').first();
    await expect(deficitChoice(item, /absorber/i).first()).toBeVisible();

    const decision = authedPage.waitForRequest(isDecision(state));
    await chooseDeficit(authedPage, item, /absorber/i);
    expect((await decision).postDataJSON()).toEqual({ result: 'deficit', mode: 'absorb' });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByRole('progressbar').first()).toBeVisible();
    await expect(authedPage.getByText(/te pasaste por/i)).toHaveCount(0);
    await expect(deficitChoice(authedPage, /absorber/i)).toHaveCount(0);
  });

  test('RF-M15-03 sin abrir la bandeja, la tarjeta de cierre está en el presupuesto', async ({
    authedPage,
  }) => {
    const budgetId = await createComidaBudget(authedPage);
    await serveClose(authedPage, { budgetId, periodId: randomUUID(), result: '150.00' });

    await authedPage.goto(`/presupuestos/${budgetId}`);
    await expect(authedPage.getByText(/comida cerró octubre/i).first()).toBeVisible();
    await expect(applyButton(authedPage)).toBeVisible();
  });
});
