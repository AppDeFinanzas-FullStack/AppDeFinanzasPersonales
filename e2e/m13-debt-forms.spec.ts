import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/*
 * TASK-218: the debt form ("Nueva deuda" in /deudas) and the payment form ("Registrar pago" in
 * /deudas/:id). Contract the screens must follow, from spec §2.13.1 and plan §4.13.4:
 *  - Debt form: "Debo" / "Me deben" (radio, tab or button), "Persona" (with suggestions as
 *    `role=option`), "Monto", "Moneda" (optional), "Fecha de inicio", "Interés (%)" and "Período"
 *    ("Mensual" / "Anual"), "Cuenta" (optional, empty = no initial movement), "Tipo de cambio"
 *    (only when the account has another currency) and the "Guardar" button.
 *  - Payment form: "Monto", "Interés", "Capital", "Cuenta" (optional), "Fecha", "Tipo de cambio"
 *    (only when the account has another currency) and the "Guardar" button.
 * Errors show as `role=alert` or mark the field with `aria-invalid`.
 */

interface Payment {
  id: string;
  amount: string;
  interestPart: string;
  capitalPart: string;
}

interface Debt {
  id: string;
  direction: string;
  person: string;
  principal: string;
  status: string;
  capitalOutstanding: string;
  interestAccrued: string;
  pending: string;
  interest?: { rate: string; period: string };
  payments: Payment[];
}

interface DebtList {
  debts: Debt[];
}

interface TransactionItem {
  id: string;
  kind: string;
  origin: string;
  category?: { name: string } | null;
  entries: { accountId: string; amount: string; currencyCode: string }[];
}

interface AccountItem {
  id: string;
  balance: string;
}

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

/** The Bolivian date `n` days from today (negative: before), as `YYYY-MM-DD`. */
function boliviaDay(n = 0): string {
  const d = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createAccount(
  page: Page,
  name: string,
  initialBalance: string,
  options: { type?: 'cash' | 'bank'; currencyCode?: 'BOB' | 'USD' } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: options.type ?? 'cash',
      name,
      currencyCode: options.currencyCode ?? 'BOB',
      initialBalance,
      initialBalanceDate: boliviaDay(-20),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function createDebt(
  page: Page,
  direction: 'i_owe' | 'owed_to_me',
  person: string,
  principal: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/debts', {
    data: {
      id,
      direction,
      person,
      principal,
      currencyCode: 'BOB',
      startDate: boliviaDay(-10),
      ...extra,
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

/** Bs 2.000,00 at 4,23 % monthly for 15 days: Bs 42,30 of interest accrued. */
async function createInterestDebt(page: Page): Promise<string> {
  return createDebt(page, 'i_owe', 'Banco Sol', '2000.00', {
    startDate: boliviaDay(-15),
    interest: { rate: '4.23', period: 'monthly' },
  });
}

async function createGoal(page: Page, name: string, target: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/goals', {
    data: { id, name, target, currencyCode: 'BOB', icon: 'plane', color: 'blue' },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function earmark(
  page: Page,
  goalId: string,
  accountId: string,
  amount: string,
): Promise<void> {
  const res = await page.request.post(`/api/goals/${goalId}/earmarks`, {
    data: { id: randomUUID(), accountId, amount },
  });
  expect(res.ok()).toBe(true);
}

async function progressOf(page: Page, goalId: string): Promise<number> {
  const res = await page.request.get(`/api/goals/${goalId}`);
  expect(res.ok()).toBe(true);
  return Number(((await res.json()) as { progress: string }).progress);
}

async function setManualRate(page: Page, value: string): Promise<void> {
  const res = await page.request.put('/api/fx/manual', { data: { value } });
  expect(res.status()).toBe(204);
}

async function listDebts(page: Page): Promise<Debt[]> {
  const res = await page.request.get('/api/debts?view=debt');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as DebtList).debts;
}

async function findDebt(page: Page, id: string): Promise<Debt | undefined> {
  return (await listDebts(page)).find((d) => d.id === id);
}

async function debtOf(page: Page, person: string): Promise<Debt | undefined> {
  return (await listDebts(page)).find((d) => d.person === person);
}

async function listTransactions(page: Page): Promise<TransactionItem[]> {
  const res = await page.request.get('/api/transactions');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: TransactionItem[] }).items;
}

async function balanceOf(page: Page, accountId: string): Promise<number> {
  const res = await page.request.get('/api/accounts?status=active');
  expect(res.ok()).toBe(true);
  const items = ((await res.json()) as { items: AccountItem[] }).items;
  const found = items.find((a) => a.id === accountId);
  expect(found).toBeDefined();
  return Number(found?.balance);
}

/** Chooses an option by its text in a native select or in a custom list. */
async function choose(
  page: Page,
  label: string,
  option: string,
  scope: Page | Locator = page,
): Promise<void> {
  const field = scope.getByLabel(label, { exact: true });
  const isSelect = await field.evaluate((el) => el.tagName === 'SELECT');
  const pattern = new RegExp(escapeRegExp(option), 'i');
  if (isSelect) {
    const value = await field
      .locator('option')
      .filter({ hasText: pattern })
      .first()
      .getAttribute('value');
    expect(value, `option "${option}" in "${label}"`).not.toBeNull();
    await field.selectOption(value ?? '');
  } else {
    await field.click();
    await page.getByRole('option', { name: pattern }).first().click();
  }
}

function directionControl(page: Page, name: RegExp): Locator {
  return page
    .getByRole('radio', { name })
    .or(page.getByRole('tab', { name }))
    .or(page.getByRole('button', { name }))
    .first();
}

const rateField = (page: Page): Locator => page.getByLabel(/^tipo de cambio/i);
const submitButton = (page: Page): Locator => page.getByRole('button', { name: /^guardar$/i });
const formFeedback = (page: Page): Locator =>
  page.getByRole('alert').or(page.locator('[aria-invalid="true"]')).first();

async function openNewDebt(page: Page): Promise<void> {
  await page.goto('/deudas');
  await page
    .getByRole('button', { name: /nueva deuda/i })
    .or(page.getByRole('link', { name: /nueva deuda/i }))
    .first()
    .click();
  await expect(page.getByLabel('Persona', { exact: true })).toBeVisible();
}

interface DebtFormValues {
  direction?: 'Debo' | 'Me deben';
  person?: string;
  amount?: string;
  startDate?: string;
  rate?: string;
  period?: 'Mensual' | 'Anual';
  account?: string;
}

async function fillDebtForm(page: Page, values: DebtFormValues): Promise<void> {
  if (values.direction !== undefined) {
    await directionControl(page, new RegExp(`^${values.direction}$`, 'i')).click();
  }
  if (values.person !== undefined)
    await page.getByLabel('Persona', { exact: true }).fill(values.person);
  if (values.amount !== undefined)
    await page.getByLabel('Monto', { exact: true }).fill(values.amount);
  const currency = page.getByLabel('Moneda', { exact: true });
  if ((await currency.count()) > 0) await choose(page, 'Moneda', 'BOB');
  if (values.startDate !== undefined) {
    await page.getByLabel('Fecha de inicio', { exact: true }).fill(values.startDate);
  }
  if (values.rate !== undefined) await page.getByLabel(/^inter[eé]s/i).fill(values.rate);
  if (values.period !== undefined) await choose(page, 'Período', values.period);
  if (values.account !== undefined) await choose(page, 'Cuenta', values.account, formDialog(page));
}

async function openPayment(page: Page, debtId: string): Promise<void> {
  await page.goto(`/deudas/${debtId}`);
  await page
    .getByRole('button', { name: /registrar pago/i })
    .first()
    .click();
  await expect(page.getByLabel('Monto', { exact: true })).toBeVisible();
}

/** The form dialog: scopes the labels that also exist in the sidebar ("Cuenta" group). */
const formDialog = (page: Page): Locator => page.getByRole('dialog');

const valueOf = (page: Page, label: string): Locator => page.getByLabel(label, { exact: true });

test.describe('TASK-218 formulario de deuda', () => {
  test('RF-M13-01 "Me deben" con persona y monto crea la deuda y aparece en la lista', async ({
    authedPage,
  }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, { direction: 'Me deben', person: 'Ana', amount: '300' });
    await submitButton(authedPage).click();
    await expect.poll(async () => (await debtOf(authedPage, 'Ana'))?.principal).toBe('300.00');
    const debt = await debtOf(authedPage, 'Ana');
    expect(debt?.direction).toBe('owed_to_me');
    expect(debt?.status).toBe('active');
    await expect(authedPage.getByRole('link', { name: /Ana/ }).first()).toBeVisible();
    await expect(authedPage.getByRole('link', { name: /Ana/ }).first()).toContainText('300,00');
  });

  test('RF-M13-01 "Debo" crea una deuda de dirección i_owe con su nota y fecha límite', async ({
    authedPage,
  }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, { direction: 'Debo', person: 'Juan', amount: '1200.50' });
    await authedPage.getByLabel('Nota', { exact: true }).fill('Para la matrícula');
    await authedPage.getByLabel('Fecha límite', { exact: true }).fill(boliviaDay(30));
    await submitButton(authedPage).click();
    await expect.poll(async () => (await debtOf(authedPage, 'Juan'))?.principal).toBe('1200.50');
    expect((await debtOf(authedPage, 'Juan'))?.direction).toBe('i_owe');
  });

  test('RF-M13-01 la persona se autocompleta con las personas ya usadas', async ({
    authedPage,
  }) => {
    await createDebt(authedPage, 'i_owe', 'Juan', '100.00');
    await createDebt(authedPage, 'owed_to_me', 'Ana', '50.00');
    await openNewDebt(authedPage);
    const person = authedPage.getByLabel('Persona', { exact: true });
    await person.fill('Ju');
    await expect(authedPage.getByRole('option', { name: 'Juan' })).toBeVisible();
    await expect(authedPage.getByRole('option', { name: 'Ana' })).toHaveCount(0);
    await authedPage.getByRole('option', { name: 'Juan' }).click();
    await expect(person).toHaveValue('Juan');
  });

  test('RF-M13-01 una persona vacía no crea la deuda y explica el error', async ({
    authedPage,
  }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, { direction: 'Debo', amount: '100' });
    await submitButton(authedPage).click();
    await expect(formFeedback(authedPage)).toBeVisible();
    expect(await listDebts(authedPage)).toHaveLength(0);
  });

  test('RF-M13-01 un monto de 0 no crea la deuda', async ({ authedPage }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, { direction: 'Debo', person: 'Juan', amount: '0' });
    await submitButton(authedPage).click();
    await expect(formFeedback(authedPage)).toBeVisible();
    expect(await listDebts(authedPage)).toHaveLength(0);
  });

  test('RF-M13-01 una fecha de inicio posterior a hoy no crea la deuda', async ({ authedPage }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Debo',
      person: 'Juan',
      amount: '100',
      startDate: boliviaDay(3),
    });
    await submitButton(authedPage).click();
    await expect(formFeedback(authedPage)).toBeVisible();
    expect(await listDebts(authedPage)).toHaveLength(0);
  });

  test('RF-M13-01 un interés de 101 % no crea la deuda', async ({ authedPage }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Debo',
      person: 'Juan',
      amount: '100',
      rate: '101',
      period: 'Mensual',
    });
    await submitButton(authedPage).click();
    await expect(formFeedback(authedPage)).toBeVisible();
    expect(await listDebts(authedPage)).toHaveLength(0);
  });

  test('RF-M13-01 un interés de 0 % no crea la deuda', async ({ authedPage }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Debo',
      person: 'Juan',
      amount: '100',
      rate: '0',
      period: 'Mensual',
    });
    await submitButton(authedPage).click();
    await expect(formFeedback(authedPage)).toBeVisible();
    expect(await listDebts(authedPage)).toHaveLength(0);
  });

  test('RF-M13-01 el interés mensual opcional queda guardado y acumula desde la fecha de inicio', async ({
    authedPage,
  }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Debo',
      person: 'Banco Sol',
      amount: '1000',
      startDate: boliviaDay(-30),
      rate: '3',
      period: 'Mensual',
    });
    await submitButton(authedPage).click();
    await expect
      .poll(async () => (await debtOf(authedPage, 'Banco Sol'))?.principal)
      .toBe('1000.00');
    const debt = await debtOf(authedPage, 'Banco Sol');
    expect(Number(debt?.interest?.rate)).toBe(3);
    expect(debt?.interest?.period).toBe('monthly');
    expect(Number(debt?.interestAccrued)).toBeGreaterThan(0);
  });

  test('RF-M13-01 el interés anual opcional queda guardado con su período', async ({
    authedPage,
  }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Me deben',
      person: 'Ana',
      amount: '500',
      rate: '12',
      period: 'Anual',
    });
    await submitButton(authedPage).click();
    await expect.poll(async () => (await debtOf(authedPage, 'Ana'))?.principal).toBe('500.00');
    const debt = await debtOf(authedPage, 'Ana');
    expect(Number(debt?.interest?.rate)).toBe(12);
    expect(debt?.interest?.period).toBe('yearly');
  });

  test('TASK-218 sin interés la deuda se crea sin tasa', async ({ authedPage }) => {
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, { direction: 'Debo', person: 'Luis', amount: '80' });
    await submitButton(authedPage).click();
    await expect.poll(async () => (await debtOf(authedPage, 'Luis'))?.principal).toBe('80.00');
    expect((await debtOf(authedPage, 'Luis'))?.interest).toBeUndefined();
  });

  test('TASK-218 el movimiento inicial de "Debo" entra a la cuenta como ingreso', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo', '1000.00');
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Debo',
      person: 'Juan',
      amount: '500',
      account: 'Efectivo',
    });
    await expect(rateField(authedPage)).toHaveCount(0);
    await submitButton(authedPage).click();
    await expect.poll(() => balanceOf(authedPage, accountId)).toBe(1500);
    const initial = (await listTransactions(authedPage)).filter((t) => t.origin === 'debt_initial');
    expect(initial).toHaveLength(1);
    expect(initial[0]?.kind).toBe('income');
  });

  test('TASK-218 el movimiento inicial de "Me deben" sale de la cuenta como gasto', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo', '1000.00');
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Me deben',
      person: 'Ana',
      amount: '300',
      account: 'Efectivo',
    });
    await submitButton(authedPage).click();
    await expect.poll(() => balanceOf(authedPage, accountId)).toBe(700);
    const initial = (await listTransactions(authedPage)).filter((t) => t.origin === 'debt_initial');
    expect(initial).toHaveLength(1);
    expect(initial[0]?.kind).toBe('expense');
  });

  test('TASK-218 sin cuenta no se crea ningún movimiento inicial', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo', '1000.00');
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, { direction: 'Debo', person: 'Juan', amount: '500' });
    await submitButton(authedPage).click();
    await expect.poll(async () => (await debtOf(authedPage, 'Juan'))?.principal).toBe('500.00');
    expect(await listTransactions(authedPage)).toHaveLength(0);
  });

  test('RF-M13-09 el movimiento inicial en una cuenta en $ pide el tipo de cambio, precargado', async ({
    authedPage,
  }) => {
    await setManualRate(authedPage, '10');
    const accountId = await createAccount(authedPage, 'Dólares', '20.00', { currencyCode: 'USD' });
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Debo',
      person: 'Juan',
      amount: '500',
      account: 'Dólares',
    });
    await expect(rateField(authedPage)).toBeVisible();
    await expect(rateField(authedPage)).toHaveValue(/^10([.,]0{1,2})?$/);
    // The amount is typed in the debt's currency; the app shows the one of the account.
    await expect(authedPage.getByText(/50,00/).first()).toBeVisible();
    await submitButton(authedPage).click();
    await expect.poll(() => balanceOf(authedPage, accountId)).toBe(70);
  });

  test('RF-M13-09 el tipo de cambio del movimiento inicial es editable y fija el monto de la cuenta', async ({
    authedPage,
  }) => {
    await setManualRate(authedPage, '10');
    const accountId = await createAccount(authedPage, 'Dólares', '20.00', { currencyCode: 'USD' });
    await openNewDebt(authedPage);
    await fillDebtForm(authedPage, {
      direction: 'Debo',
      person: 'Juan',
      amount: '500',
      account: 'Dólares',
    });
    await rateField(authedPage).fill('8');
    await submitButton(authedPage).click();
    // 500 / 8 = 62,50: the account gets exactly what the declared rate says.
    await expect.poll(() => balanceOf(authedPage, accountId)).toBe(82.5);
  });
});

test.describe('TASK-218 formulario de pago', () => {
  test('RF-M13-05 Desglose precargado: un pago de 500 propone interés 42,30 y capital 457,70', async ({
    authedPage,
  }) => {
    const debtId = await createInterestDebt(authedPage);
    const debt = await findDebt(authedPage, debtId);
    expect(debt?.interestAccrued).toBe('42.30');
    expect(debt?.capitalOutstanding).toBe('2000.00');
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await expect(valueOf(authedPage, 'Interés')).toHaveValue(/^42[.,]30$/);
    await expect(valueOf(authedPage, 'Capital')).toHaveValue(/^457[.,]70$/);
  });

  test('RF-M13-05 Desglose precargado: al guardar desde el Banco, 42,30 cuentan como gasto en "Intereses"', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '5000.00', { type: 'bank' });
    const debtId = await createInterestDebt(authedPage);
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await expect(valueOf(authedPage, 'Interés')).toHaveValue(/^42[.,]30$/);
    await choose(authedPage, 'Cuenta', 'Banco', formDialog(authedPage));
    await submitButton(authedPage).click();
    await expect.poll(() => balanceOf(authedPage, bank)).toBe(4500);
    const items = await listTransactions(authedPage);
    const interest = items.find((t) => t.category?.name === 'Intereses');
    expect(interest?.kind).toBe('expense');
    expect(interest?.entries[0]?.amount).toBe('-42.30');
    const capital = items.find((t) => t.category?.name === 'Deudas y préstamos');
    expect(capital?.kind).toBe('expense');
    expect(capital?.entries[0]?.amount).toBe('-457.70');
    const saved = await findDebt(authedPage, debtId);
    expect(saved?.payments).toHaveLength(1);
    expect(saved?.payments[0]).toMatchObject({
      amount: '500.00',
      interestPart: '42.30',
      capitalPart: '457.70',
    });
  });

  test('RF-M13-05 el desglose es editable: interés 30,00 y capital 470,00', async ({
    authedPage,
  }) => {
    const debtId = await createInterestDebt(authedPage);
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await expect(valueOf(authedPage, 'Interés')).toHaveValue(/^42[.,]30$/);
    await valueOf(authedPage, 'Interés').fill('30');
    await valueOf(authedPage, 'Capital').fill('470');
    await submitButton(authedPage).click();
    await expect.poll(async () => (await findDebt(authedPage, debtId))?.payments.length).toBe(1);
    const saved = await findDebt(authedPage, debtId);
    expect(saved?.payments[0]).toMatchObject({
      amount: '500.00',
      interestPart: '30.00',
      capitalPart: '470.00',
    });
  });

  test('RF-M13-05 un interés mayor que el acumulado no se guarda y explica el error', async ({
    authedPage,
  }) => {
    const debtId = await createInterestDebt(authedPage);
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await valueOf(authedPage, 'Interés').fill('100');
    await valueOf(authedPage, 'Capital').fill('400');
    await submitButton(authedPage).click();
    await expect(formFeedback(authedPage)).toBeVisible();
    expect((await findDebt(authedPage, debtId))?.payments).toHaveLength(0);
  });

  test('TASK-218 la cuenta es opcional: sin cuenta no hay movimientos y baja el saldo', async ({
    authedPage,
  }) => {
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00');
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('200');
    await expect(valueOf(authedPage, 'Capital')).toHaveValue(/^200([.,]00)?$/);
    await submitButton(authedPage).click();
    await expect
      .poll(async () => (await findDebt(authedPage, debtId))?.capitalOutstanding)
      .toBe('300.00');
    expect(await listTransactions(authedPage)).toHaveLength(0);
    await expect(authedPage.getByText(/300,00/).first()).toBeVisible();
  });

  test('RF-M13-09 con una cuenta en $ se pide y se precarga el tipo de cambio', async ({
    authedPage,
  }) => {
    await setManualRate(authedPage, '10');
    const usd = await createAccount(authedPage, 'Dólares', '100.00', { currencyCode: 'USD' });
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00');
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await expect(rateField(authedPage)).toHaveCount(0);
    await choose(authedPage, 'Cuenta', 'Dólares', formDialog(authedPage));
    await expect(rateField(authedPage)).toBeVisible();
    await expect(rateField(authedPage)).toHaveValue(/^10([.,]0{1,2})?$/);
    // The amount is in the debt's currency; the app calculates the one of the account.
    await expect(authedPage.getByText(/50,00/).first()).toBeVisible();
    await submitButton(authedPage).click();
    await expect.poll(() => balanceOf(authedPage, usd)).toBe(50);
    await expect.poll(async () => (await findDebt(authedPage, debtId))?.status).toBe('paid');
  });

  test('RF-M13-09 el tipo de cambio del pago es editable y se guarda', async ({ authedPage }) => {
    await setManualRate(authedPage, '10');
    const usd = await createAccount(authedPage, 'Dólares', '100.00', { currencyCode: 'USD' });
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00');
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await choose(authedPage, 'Cuenta', 'Dólares', formDialog(authedPage));
    await rateField(authedPage).fill('8');
    await submitButton(authedPage).click();
    // 500 / 8 = 62,50 leave the account, with no rounding residue.
    await expect.poll(() => balanceOf(authedPage, usd)).toBe(37.5);
    const outgoing = (await listTransactions(authedPage)).find(
      (t) => t.origin === 'debt_payment' && t.entries[0]?.currencyCode === 'USD',
    );
    expect(outgoing?.entries[0]?.amount).toBe('-62.50');
  });

  test('RF-M13-09 con una cuenta en Bs no se pide tipo de cambio', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo', '1000.00');
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00');
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('100');
    await choose(authedPage, 'Cuenta', 'Efectivo', formDialog(authedPage));
    await expect(rateField(authedPage)).toHaveCount(0);
  });

  test('EC-M13-04 pago desde una cuenta con apartados: pide la confirmación y, al confirmar, se guarda', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '1000.00', { type: 'bank' });
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '600.00');
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00');
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await choose(authedPage, 'Cuenta', 'Banco', formDialog(authedPage));
    await submitButton(authedPage).click();
    const dialog = authedPage.getByRole('dialog').filter({ hasText: /usa .*apartad/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/100,00/).first()).toBeVisible();
    await expect(dialog.getByText(/Viaje/).first()).toBeVisible();
    await dialog.getByRole('button', { name: /confirmar/i }).click();
    await expect(authedPage.getByRole('dialog').filter({ hasText: /usa .*apartad/i })).toHaveCount(
      0,
    );
    await expect.poll(async () => (await findDebt(authedPage, debtId))?.payments.length).toBe(1);
    expect(await progressOf(authedPage, goalId)).toBe(500);
  });

  test('EC-M13-04 al cancelar la confirmación no se guarda el pago y el formulario sigue', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '1000.00', { type: 'bank' });
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '600.00');
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00');
    await openPayment(authedPage, debtId);
    await valueOf(authedPage, 'Monto').fill('500');
    await choose(authedPage, 'Cuenta', 'Banco', formDialog(authedPage));
    await submitButton(authedPage).click();
    const dialog = authedPage.getByRole('dialog').filter({ hasText: /usa .*apartad/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /cancelar/i }).click();
    await expect(authedPage.getByRole('dialog').filter({ hasText: /usa .*apartad/i })).toHaveCount(
      0,
    );
    await expect(valueOf(authedPage, 'Monto')).toHaveValue(/^500([.,]00)?$/);
    expect((await findDebt(authedPage, debtId))?.payments).toHaveLength(0);
    expect(await progressOf(authedPage, goalId)).toBe(600);
  });
});

test.describe('TASK-218 movimientos vinculados', () => {
  test('RF-M6-09 Vinculado solo se edita en su origen: el pago a Juan no deja editar monto, cuenta ni fecha', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo', '1000.00');
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00', {
      startDate: boliviaDay(),
    });
    const res = await authedPage.request.post(`/api/debts/${debtId}/payments`, {
      data: {
        id: randomUUID(),
        amount: '200.00',
        interestPart: '0.00',
        capitalPart: '200.00',
        date: boliviaDay(),
        account: {
          accountId,
          capitalTransactionId: randomUUID(),
          interestTransactionId: randomUUID(),
        },
      },
    });
    expect(res.status()).toBe(201);

    await authedPage.goto('/movimientos');
    await authedPage
      .getByRole('link', { name: /200,00/ })
      .first()
      .click();
    await expect(authedPage.getByRole('link', { name: 'Ir a la deuda' })).toBeVisible();
    await authedPage.getByRole('button', { name: 'Editar', exact: true }).click();
    await expect(authedPage.getByLabel('Monto', { exact: true })).toBeDisabled();
    await expect(authedPage.locator('main').locator('#edit-account')).toBeDisabled();
    await expect(authedPage.getByLabel('Fecha', { exact: true })).toBeDisabled();
  });
});
