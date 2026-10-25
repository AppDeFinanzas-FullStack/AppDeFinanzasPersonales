import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createBudget, createBudgetPeriod, deleteBudgetsOf } from '../factories/budget.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import {
  createOccurrence,
  createRule,
  deleteRecurringOf,
  occurrenceStatus,
} from '../factories/recurring.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * Isolation sweep of `/api` (plan §5.1, §5.3, §3.9; RNF-14). The routes are read from the app the
 * composition root builds (`buildContainer(env)` and `createApp(container)`), over the test
 * database with fake integrations, and every one of them must be listed in `COVERAGE`:
 *
 * - `public`: needs no session (health and the first half of `/api/auth`);
 * - `session`: private, and nothing of another user can be named in the request;
 * - `{ foreign, refs }`: private and the request can name a resource. `foreign` builds the request
 *   that points the route at a resource of user A; `refs` builds requests that name a resource of A
 *   from inside the body or the query. Sent from the session of user B, a `foreign` request must be
 *   answered 404, and both kinds must be answered exactly as the same request over a resource
 *   that does not exist ("a foreign resource behaves as an inexistent one", RNF-14).
 *
 * The guard test fails when a route is mounted without an entry here, and when an entry has no
 * route. Every private route must also refuse a request without a session.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const UNKNOWN_CODE = 'QQQ';
const CUSTOM_CODE = 'ARS';

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  // The latest release: every module is mounted and none answers RELEASE_NOT_AVAILABLE.
  RELEASE: '1.2',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
  traceId?: string;
}
const problem = (res: { body: unknown }) => res.body as Problem;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Spec {
  method: Method;
  path: string;
  query?: Record<string, string>;
  body?: object;
}

/** What is named in a request: resources of user A, or the same kinds of resource that do not exist. */
interface Ids {
  account: string;
  category: string;
  transaction: string;
  shortcut: string;
  goal: string;
  debt: string;
  budget: string;
  /** A `closed_pending` period of `budget`. */
  budgetPeriod: string;
  notification: string;
  undoToken: string;
  currency: string;
  rule: string;
  occurrence: string;
  /** Resources of the user who sends the request. */
  own: {
    account: string;
    category: string;
    transaction: string;
    goal: string;
    rule: string;
    occurrence: string;
    debt: string;
  };
}

type Build = (ids: Ids) => Spec;

type Coverage = 'public' | 'session' | { foreign?: Build[]; refs?: Build[] };

const TODAY = new Date();
const dayOffset = (days: number): string =>
  new Date(TODAY.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const onlyForeign = (...foreign: Build[]): Coverage => ({ foreign });

const COVERAGE: Record<string, Coverage> = {
  // Public.
  'GET /api/health': 'public',
  'GET /api/health/ready': 'public',
  'POST /api/auth/sign-up': 'public',
  'POST /api/auth/sign-in': 'public',
  'POST /api/auth/confirmation/resend': 'public',
  'POST /api/auth/confirm': 'public',
  'POST /api/auth/password/forgot': 'public',
  'POST /api/auth/password/reset': 'public',

  // Private, nothing of another user can be named.
  'POST /api/auth/password/change': 'session',
  'POST /api/auth/sign-out': 'session',
  'POST /api/auth/sign-out-all': 'session',
  'GET /api/me': 'session',
  'PATCH /api/me': 'session',
  'GET /api/me/export': 'session',
  'POST /api/me/delete': 'session',
  'GET /api/settings': 'session',
  'PATCH /api/settings': 'session',
  'POST /api/settings/reset': 'session',
  'GET /api/rates/current': 'session',
  'GET /api/rates/history': 'session',
  'PUT /api/fx/manual': 'session',
  'DELETE /api/fx/manual': 'session',
  'GET /api/currencies': 'session',
  'GET /api/dashboard': 'session',
  'GET /api/register/context': 'session',
  'GET /api/onboarding': 'session',
  'POST /api/onboarding/step1': 'session',
  'POST /api/onboarding/step2': 'session',
  'POST /api/onboarding/step3': 'session',
  'POST /api/onboarding/skip': 'session',
  'POST /api/onboarding/skip-all': 'session',
  'GET /api/notifications': 'session',
  'GET /api/notifications/unread-count': 'session',
  'POST /api/notifications/read-all': 'session',
  'GET /api/transactions/summary': 'session',

  // Private, the request can name a resource.
  'GET /api/accounts': 'session',
  'POST /api/accounts': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/accounts',
        body: {
          id: uuidv7(),
          type: 'cash',
          name: `Caja ${randomUUID().slice(0, 8)}`,
          currencyCode: a.currency,
          initialBalance: '0.00',
          initialBalanceDate: dayOffset(10),
          color: 'blue',
          icon: 'wallet',
        },
      }),
    ],
  },
  'PUT /api/accounts/order': {
    refs: [(a) => ({ method: 'PUT', path: '/api/accounts/order', body: { ids: [a.account] } })],
  },
  'PATCH /api/accounts/:id': onlyForeign((a) => ({
    method: 'PATCH',
    path: `/api/accounts/${a.account}`,
    body: { name: 'Cambiada por otro' },
  })),
  'DELETE /api/accounts/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/accounts/${a.account}`,
  })),
  'POST /api/accounts/:id/adjust': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/accounts/${a.account}/adjust`,
    body: { transactionId: uuidv7(), realBalance: '5.00' },
  })),
  'POST /api/accounts/:id/archive': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/accounts/${a.account}/archive`,
    body: { confirmNonZero: true },
  })),
  'POST /api/accounts/:id/restore': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/accounts/${a.account}/restore`,
    body: {},
  })),
  'GET /api/accounts/:id/balance-series': onlyForeign((a) => ({
    method: 'GET',
    path: `/api/accounts/${a.account}/balance-series`,
    query: { from: dayOffset(5), to: dayOffset(0) },
  })),

  'GET /api/categories': 'session',
  'POST /api/categories': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/categories',
        body: {
          id: uuidv7(),
          kind: 'expense',
          parentId: a.category,
          name: `Sub ${randomUUID().slice(0, 8)}`,
          icon: 'tag',
        },
      }),
    ],
  },
  'PUT /api/categories/order': {
    refs: [
      (a) => ({
        method: 'PUT',
        path: '/api/categories/order',
        body: { kind: 'expense', parentId: null, ids: [a.category] },
      }),
    ],
  },
  'GET /api/categories/merge-preview': {
    refs: [
      (a) => ({
        method: 'GET',
        path: '/api/categories/merge-preview',
        query: { from: a.category, to: a.own.category },
      }),
      (a) => ({
        method: 'GET',
        path: '/api/categories/merge-preview',
        query: { from: a.own.category, to: a.category },
      }),
    ],
  },
  'POST /api/categories/merge': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/categories/merge',
        body: { fromId: a.category, toId: a.own.category },
      }),
      (a) => ({
        method: 'POST',
        path: '/api/categories/merge',
        body: { fromId: a.own.category, toId: a.category },
      }),
    ],
  },
  'PATCH /api/categories/:id': {
    foreign: [
      (a) => ({
        method: 'PATCH',
        path: `/api/categories/${a.category}`,
        body: { name: 'Cambiada por otro' },
      }),
    ],
    refs: [
      (a) => ({
        method: 'PATCH',
        path: `/api/categories/${a.own.category}`,
        body: { parentId: a.category },
      }),
    ],
  },
  'DELETE /api/categories/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/categories/${a.category}`,
  })),
  'GET /api/categories/:id/archive-impact': onlyForeign((a) => ({
    method: 'GET',
    path: `/api/categories/${a.category}/archive-impact`,
  })),
  'POST /api/categories/:id/archive': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/categories/${a.category}/archive`,
    body: {},
  })),
  'POST /api/categories/:id/restore': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/categories/${a.category}/restore`,
    body: {},
  })),

  'POST /api/currencies': 'session',
  'PATCH /api/currencies/:code': onlyForeign((a) => ({
    method: 'PATCH',
    path: `/api/currencies/${a.currency}`,
    body: { symbol: '$' },
  })),
  'POST /api/currencies/:code/deactivate': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/currencies/${a.currency}/deactivate`,
    body: {},
  })),
  'POST /api/currencies/:code/activate': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/currencies/${a.currency}/activate`,
    body: { rate: '1.00' },
  })),
  'PATCH /api/fx-settings': {
    refs: [
      (a) => ({ method: 'PATCH', path: '/api/fx-settings', body: { baseCurrency: a.currency } }),
    ],
  },

  'GET /api/shortcuts': 'session',
  'POST /api/shortcuts': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/shortcuts',
        body: {
          id: uuidv7(),
          name: 'Atajo ajeno',
          kind: 'expense',
          accountId: a.account,
          categoryId: a.own.category,
        },
      }),
      (a) => ({
        method: 'POST',
        path: '/api/shortcuts',
        body: {
          id: uuidv7(),
          name: 'Atajo ajeno',
          kind: 'expense',
          accountId: a.own.account,
          categoryId: a.category,
        },
      }),
    ],
  },
  'PUT /api/shortcuts/order': {
    refs: [(a) => ({ method: 'PUT', path: '/api/shortcuts/order', body: { ids: [a.shortcut] } })],
  },
  'PATCH /api/shortcuts/:id': onlyForeign((a) => ({
    method: 'PATCH',
    path: `/api/shortcuts/${a.shortcut}`,
    body: { name: 'Cambiado por otro' },
  })),
  'DELETE /api/shortcuts/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/shortcuts/${a.shortcut}`,
  })),

  'GET /api/transactions': {
    refs: [
      (a) => ({ method: 'GET', path: '/api/transactions', query: { accountId: a.account } }),
      (a) => ({ method: 'GET', path: '/api/transactions', query: { categoryId: a.category } }),
    ],
  },
  'POST /api/transactions': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/transactions',
        body: {
          kind: 'expense',
          id: uuidv7(),
          accountId: a.account,
          categoryId: a.own.category,
          amount: '1.00',
          date: dayOffset(1),
        },
      }),
      (a) => ({
        method: 'POST',
        path: '/api/transactions',
        body: {
          kind: 'expense',
          id: uuidv7(),
          accountId: a.own.account,
          categoryId: a.category,
          amount: '1.00',
          date: dayOffset(1),
        },
      }),
    ],
  },
  'POST /api/transactions/undo': {
    refs: [
      (a) => ({ method: 'POST', path: '/api/transactions/undo', body: { undoToken: a.undoToken } }),
    ],
  },
  'POST /api/transactions/batch-delete': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/transactions/batch-delete',
        body: { ids: [a.transaction] },
      }),
    ],
  },
  'POST /api/transactions/batch-recategorize': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/transactions/batch-recategorize',
        body: { ids: [a.transaction], categoryId: a.own.category },
      }),
      (a) => ({
        method: 'POST',
        path: '/api/transactions/batch-recategorize',
        body: { ids: [a.own.transaction], categoryId: a.category },
      }),
    ],
  },
  'GET /api/transactions/:id': onlyForeign((a) => ({
    method: 'GET',
    path: `/api/transactions/${a.transaction}`,
  })),
  'PATCH /api/transactions/:id': {
    foreign: [
      (a) => ({
        method: 'PATCH',
        path: `/api/transactions/${a.transaction}`,
        body: { note: 'Cambiada por otro' },
      }),
    ],
    refs: [
      (a) => ({
        method: 'PATCH',
        path: `/api/transactions/${a.own.transaction}`,
        body: { accountId: a.account },
      }),
      (a) => ({
        method: 'PATCH',
        path: `/api/transactions/${a.own.transaction}`,
        body: { categoryId: a.category },
      }),
    ],
  },
  'DELETE /api/transactions/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/transactions/${a.transaction}`,
  })),

  'GET /api/goals': 'session',
  'POST /api/goals': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/goals',
        body: {
          id: uuidv7(),
          name: `Meta ${randomUUID().slice(0, 8)}`,
          target: '100.00',
          currencyCode: 'BOB',
          icon: 'piggy-bank',
          color: 'blue',
          dedicatedAccountId: a.account,
        },
      }),
    ],
  },
  'GET /api/goals/:id': onlyForeign((a) => ({
    method: 'GET',
    path: `/api/goals/${a.goal}`,
  })),
  'PATCH /api/goals/:id': onlyForeign((a) => ({
    method: 'PATCH',
    path: `/api/goals/${a.goal}`,
    body: { name: 'Cambiada por otro' },
  })),
  'DELETE /api/goals/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/goals/${a.goal}`,
  })),
  'POST /api/goals/:id/earmarks': {
    foreign: [
      (a) => ({
        method: 'POST',
        path: `/api/goals/${a.goal}/earmarks`,
        body: { id: uuidv7(), accountId: a.own.account, amount: '10.00' },
      }),
    ],
    refs: [
      (a) => ({
        method: 'POST',
        path: `/api/goals/${a.own.goal}/earmarks`,
        body: { id: uuidv7(), accountId: a.account, amount: '10.00' },
      }),
    ],
  },
  'POST /api/goals/:id/earmarks/release': {
    foreign: [
      (a) => ({
        method: 'POST',
        path: `/api/goals/${a.goal}/earmarks/release`,
        body: { accountId: a.own.account, amount: '10.00' },
      }),
    ],
    refs: [
      (a) => ({
        method: 'POST',
        path: `/api/goals/${a.own.goal}/earmarks/release`,
        body: { accountId: a.account, amount: '10.00' },
      }),
    ],
  },
  'POST /api/goals/:id/dedicate': {
    foreign: [
      (a) => ({
        method: 'POST',
        path: `/api/goals/${a.goal}/dedicate`,
        body: { accountId: a.own.account },
      }),
    ],
    refs: [
      (a) => ({
        method: 'POST',
        path: `/api/goals/${a.own.goal}/dedicate`,
        body: { accountId: a.account },
      }),
    ],
  },
  'POST /api/goals/:id/use-and-close': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/goals/${a.goal}/use-and-close`,
    body: {},
  })),
  'POST /api/goals/:id/archive': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/goals/${a.goal}/archive`,
    body: {},
  })),
  'POST /api/goals/:id/restore': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/goals/${a.goal}/restore`,
    body: {},
  })),
  'POST /api/goals/:id/celebrated': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/goals/${a.goal}/celebrated`,
    body: {},
  })),

  'GET /api/recurring': 'session',
  'POST /api/recurring': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/recurring',
        body: {
          id: uuidv7(),
          name: `Regla ${randomUUID().slice(0, 8)}`,
          kind: 'expense',
          amount: '10.00',
          accountId: a.account,
          categoryId: a.own.category,
          frequency: { type: 'monthly', day: 5 },
          startDate: '2090-06-05',
          end: { type: 'none' },
          mode: 'auto',
        },
      }),
      (a) => ({
        method: 'POST',
        path: '/api/recurring',
        body: {
          id: uuidv7(),
          name: `Regla ${randomUUID().slice(0, 8)}`,
          kind: 'expense',
          amount: '10.00',
          accountId: a.own.account,
          categoryId: a.category,
          frequency: { type: 'monthly', day: 5 },
          startDate: '2090-06-05',
          end: { type: 'none' },
          mode: 'auto',
        },
      }),
    ],
  },
  'PATCH /api/recurring/:id': {
    foreign: [
      (a) => ({
        method: 'PATCH',
        path: `/api/recurring/${a.rule}`,
        body: { name: 'Cambiada por otro' },
      }),
    ],
    refs: [
      (a) => ({
        method: 'PATCH',
        path: `/api/recurring/${a.own.rule}`,
        body: { accountId: a.account },
      }),
      (a) => ({
        method: 'PATCH',
        path: `/api/recurring/${a.own.rule}`,
        body: { categoryId: a.category },
      }),
    ],
  },
  'DELETE /api/recurring/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/recurring/${a.rule}`,
  })),
  'POST /api/recurring/:id/pause': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/recurring/${a.rule}/pause`,
    body: {},
  })),
  'GET /api/recurring/:id/skipped': onlyForeign((a) => ({
    method: 'GET',
    path: `/api/recurring/${a.rule}/skipped`,
  })),
  'POST /api/recurring/:id/resume': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/recurring/${a.rule}/resume`,
    body: { registerDates: [] },
  })),
  'POST /api/recurring/occurrences/:id/confirm': {
    foreign: [
      (a) => ({
        method: 'POST',
        path: `/api/recurring/occurrences/${a.occurrence}/confirm`,
        body: { transactionId: uuidv7(), rateUsdBob: '6.96' },
      }),
    ],
    refs: [
      (a) => ({
        method: 'POST',
        path: `/api/recurring/occurrences/${a.own.occurrence}/confirm`,
        body: { transactionId: uuidv7(), rateUsdBob: '6.96', accountId: a.account },
      }),
      (a) => ({
        method: 'POST',
        path: `/api/recurring/occurrences/${a.own.occurrence}/confirm`,
        body: { transactionId: uuidv7(), rateUsdBob: '6.96', categoryId: a.category },
      }),
    ],
  },
  'POST /api/recurring/occurrences/:id/skip': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/recurring/occurrences/${a.occurrence}/skip`,
    body: {},
  })),

  'GET /api/budgets': 'session',
  'POST /api/budgets': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/budgets',
        body: {
          id: uuidv7(),
          scope: 'category',
          categoryId: a.category,
          amount: '500.00',
          currencyCode: 'BOB',
        },
      }),
    ],
  },
  'GET /api/budgets/:id': onlyForeign((a) => ({
    method: 'GET',
    path: `/api/budgets/${a.budget}`,
  })),
  'PATCH /api/budgets/:id': onlyForeign((a) => ({
    method: 'PATCH',
    path: `/api/budgets/${a.budget}`,
    body: { amount: '1.00' },
  })),
  'DELETE /api/budgets/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/budgets/${a.budget}`,
  })),
  'POST /api/budgets/:id/pause': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/budgets/${a.budget}/pause`,
    body: {},
  })),
  'POST /api/budgets/:id/resume': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/budgets/${a.budget}/resume`,
    body: {},
  })),
  'POST /api/budgets/:id/reset-carryover': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/budgets/${a.budget}/reset-carryover`,
    body: {},
  })),
  'POST /api/budgets/:id/periods/:periodId/decision': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/budgets/${a.budget}/periods/${a.budgetPeriod}/decision`,
    body: { result: 'surplus', carry: '0.00', discard: '500.00' },
  })),

  'GET /api/debts': 'session',
  'POST /api/debts': {
    refs: [
      (a) => ({
        method: 'POST',
        path: '/api/debts',
        body: {
          id: uuidv7(),
          direction: 'i_owe',
          person: 'Persona nueva',
          principal: '10.00',
          currencyCode: 'BOB',
          startDate: dayOffset(5),
          initialMovement: { transactionId: uuidv7(), accountId: a.account },
        },
      }),
    ],
  },
  'PATCH /api/debts/:id': onlyForeign((a) => ({
    method: 'PATCH',
    path: `/api/debts/${a.debt}`,
    body: { person: 'Cambiada por otro' },
  })),
  'DELETE /api/debts/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/debts/${a.debt}`,
  })),
  'POST /api/debts/:id/payments': {
    foreign: [
      (a) => ({
        method: 'POST',
        path: `/api/debts/${a.debt}/payments`,
        body: {
          id: uuidv7(),
          amount: '10.00',
          interestPart: '0.00',
          capitalPart: '10.00',
          date: dayOffset(1),
        },
      }),
    ],
    refs: [
      (a) => ({
        method: 'POST',
        path: `/api/debts/${a.own.debt}/payments`,
        body: {
          id: uuidv7(),
          amount: '10.00',
          interestPart: '0.00',
          capitalPart: '10.00',
          date: dayOffset(1),
          account: {
            accountId: a.account,
            capitalTransactionId: uuidv7(),
            interestTransactionId: uuidv7(),
          },
        },
      }),
    ],
  },
  'DELETE /api/debts/:id/payments/last': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/debts/${a.debt}/payments/last`,
  })),
  'POST /api/debts/:id/forgive': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/debts/${a.debt}/forgive`,
    body: {},
  })),

  'POST /api/notifications/:id/read': onlyForeign((a) => ({
    method: 'POST',
    path: `/api/notifications/${a.notification}/read`,
    body: {},
  })),
  'DELETE /api/notifications/:id': onlyForeign((a) => ({
    method: 'DELETE',
    path: `/api/notifications/${a.notification}`,
  })),
};

// The routes outside `/api`: the jobs tick (protected by its own secret) and the end-to-end support.
const INTERNAL_ROUTES = [
  'POST /internal/jobs/tick',
  'GET /internal/test/mailbox',
  'POST /internal/test/users',
  'POST /internal/test/rates',
  'POST /internal/test/notifications',
];

// The prefixes the routers are mounted on; a router on any other prefix fails the guard test.
const MOUNTS = [
  '/api',
  '/api/auth',
  '/api/me',
  '/api/settings',
  '/api/rates',
  '/api/currencies',
  '/api/accounts',
  '/api/dashboard',
  '/api/shortcuts',
  '/api/register',
  '/api/categories',
  '/api/transactions',
  '/api/onboarding',
  '/api/notifications',
  '/api/goals',
  '/api/recurring',
  '/api/debts',
  '/api/budgets',
  '/internal/jobs',
  '/internal/test',
];

interface LayerLike {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle: { stack?: LayerLike[] };
  matchers: (path: string) => false | { path: string };
}

/** Every `METHOD /full/path` the app answers, read from its router (Express 5). */
function mountedRoutes(app: Express): string[] {
  const root = (app as unknown as { router: { stack: LayerLike[] } }).router;
  const found: string[] = [];
  for (const layer of root.stack) {
    const routes = layer.handle.stack;
    if (routes === undefined) continue;
    const matchers = (layer as unknown as { matchers: ((p: string) => false | { path: string })[] })
      .matchers;
    const prefixes = MOUNTS.filter((prefix) => {
      const hit = matchers[0]?.(`${prefix}/__probe__`);
      return hit !== undefined && hit !== false && hit.path === prefix;
    });
    if (prefixes.length !== 1 || prefixes[0] === undefined) {
      throw new Error(
        `a router is mounted on a prefix this sweep does not know: ${String(prefixes)}`,
      );
    }
    const prefix = prefixes[0];
    for (const inner of routes) {
      if (inner.route === undefined) {
        throw new Error(`a router nested under ${prefix} is not supported by this sweep`);
      }
      const path = String(inner.route.path);
      for (const method of Object.keys(inner.route.methods)) {
        found.push(`${method.toUpperCase()} ${prefix}${path === '/' ? '' : path}`);
      }
    }
  }
  return found;
}

interface Account {
  email: string;
  userId: string;
  cookie: string;
}

let container: Container;
let app: Express;
let a: Account;
let b: Account;
let theirs: Ids;
let unknown: Ids;
let discovered: string[] = [];
const emails: string[] = [];
const originalRelease = process.env['RELEASE'];
// A mark in the names of each user, so that a name of A can not be taken for one of B.
const markers = { A: randomUUID().slice(0, 8), B: randomUUID().slice(0, 8) };
const marker = markers.A;

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

async function signedIn(): Promise<Account> {
  const support = container.testSupport;
  if (support === null) throw new Error('test support is off');
  const { email, password } = await support.createUser();
  emails.push(email);
  const res = await request(app)
    .post('/api/auth/sign-in')
    .set('Origin', WEB_ORIGIN)
    .send({ email, password });
  expect(res.status).toBe(200);
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('the signed-in user is not in auth_user');
  return { email, userId, cookie: sessionCookieOf(res) };
}

const METHODS = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' } as const;

/** Sends the request; without a cookie it is a request without session. */
const send = (spec: Spec, cookie?: string) => {
  let req = request(app)[METHODS[spec.method]](spec.path).set('Origin', WEB_ORIGIN);
  if (spec.query !== undefined) req = req.query(spec.query);
  if (cookie !== undefined) req = req.set('Cookie', cookie);
  if (spec.body !== undefined) req = req.send(spec.body);
  return req;
};

/** A seeding request from the session of its owner: it must succeed. */
async function seed(spec: Spec, cookie: string): Promise<Record<string, unknown>> {
  const res = await send(spec, cookie);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`seeding ${spec.method} ${spec.path} answered ${res.status}: ${res.text}`);
  }
  return res.body as Record<string, unknown>;
}

async function seedUser(owner: Account, label: 'A' | 'B') {
  const marker = markers[label];
  const account = uuidv7();
  const category = uuidv7();
  const transaction = uuidv7();
  const shortcut = uuidv7();
  const goal = uuidv7();
  const debt = uuidv7();
  await seed(
    {
      method: 'POST',
      path: '/api/accounts',
      body: {
        id: account,
        type: 'cash',
        name: `Caja ${label} ${marker}`,
        currencyCode: 'BOB',
        initialBalance: '100.00',
        initialBalanceDate: dayOffset(10),
        color: 'blue',
        icon: 'wallet',
      },
    },
    owner.cookie,
  );
  await seed(
    {
      method: 'POST',
      path: '/api/categories',
      body: {
        id: category,
        kind: 'expense',
        parentId: null,
        name: `Cat ${label} ${marker}`,
        icon: 'tag',
      },
    },
    owner.cookie,
  );
  await seed(
    {
      method: 'POST',
      path: '/api/transactions',
      body: {
        kind: 'expense',
        id: transaction,
        accountId: account,
        categoryId: category,
        amount: '10.00',
        date: dayOffset(1),
        note: `Nota ${label} ${marker}`,
      },
    },
    owner.cookie,
  );
  await seed(
    {
      method: 'POST',
      path: '/api/shortcuts',
      body: {
        id: shortcut,
        name: `Atajo ${label} ${marker}`,
        kind: 'expense',
        accountId: account,
        categoryId: category,
      },
    },
    owner.cookie,
  );
  await seed(
    {
      method: 'POST',
      path: '/api/goals',
      body: {
        id: goal,
        name: `Meta ${label} ${marker}`,
        target: '500.00',
        currencyCode: 'BOB',
        icon: 'piggy-bank',
        color: 'blue',
      },
    },
    owner.cookie,
  );
  await seed(
    {
      method: 'POST',
      path: '/api/debts',
      body: {
        id: debt,
        direction: 'i_owe',
        person: `Persona ${label} ${marker}`,
        principal: '500.00',
        currencyCode: 'BOB',
        startDate: dayOffset(30),
      },
    },
    owner.cookie,
  );
  return { account, category, transaction, shortcut, goal, debt };
}

async function notificationOf(owner: Account): Promise<string> {
  const support = container.testSupport;
  if (support === null) throw new Error('test support is off');
  const eventKey = `sweep:${randomUUID()}`;
  await support.createNotification({
    email: owner.email,
    type: 'budget_alert',
    eventKey,
    params: { budgetName: `Presupuesto ${marker}` },
    targetRoute: '/presupuestos',
  });
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM notification
    WHERE user_id = ${owner.userId}::uuid AND event_key = ${eventKey}`;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the notification was not created');
  return id;
}

/** A budget of A on its category: last month `closed_pending` and this month open. */
async function budgetOf(owner: Account, categoryId: string) {
  const rows = await testPrisma().$queryRaw<
    { prevStart: string; prevEnd: string; curStart: string; curEnd: string }[]
  >`
    SELECT to_char(date_trunc('month', d) - interval '1 month', 'YYYY-MM-DD') AS "prevStart",
           to_char(date_trunc('month', d) - interval '1 day', 'YYYY-MM-DD') AS "prevEnd",
           to_char(date_trunc('month', d), 'YYYY-MM-DD') AS "curStart",
           to_char(date_trunc('month', d) + interval '1 month' - interval '1 day', 'YYYY-MM-DD')
             AS "curEnd"
      FROM (SELECT (now() AT TIME ZONE timezone)::date AS d
              FROM auth_user WHERE id = ${owner.userId}::uuid) t`;
  const months = rows[0];
  if (months === undefined) throw new Error('the user has no timezone');
  const budget = await createBudget(owner.userId, { categoryId, amount: '500.00' });
  const period = await createBudgetPeriod(owner.userId, budget, {
    startDate: months.prevStart,
    endDate: months.prevEnd,
    status: 'closed_pending',
  });
  await createBudgetPeriod(owner.userId, budget, {
    startDate: months.curStart,
    endDate: months.curEnd,
  });
  return { budget: budget.id, budgetPeriod: period.id };
}

/** The answer without what changes on every request. */
const shape = (res: { status: number; body: unknown }) => {
  const body = res.body;
  if (typeof body !== 'object' || body === null) return { status: res.status, body };
  const copy = { ...(body as Record<string, unknown>) };
  delete copy['traceId'];
  return { status: res.status, body: copy };
};

const ownTexts = (): string[] => [
  theirs.account,
  theirs.category,
  theirs.transaction,
  theirs.shortcut,
  theirs.goal,
  theirs.debt,
  theirs.budget,
  theirs.budgetPeriod,
  theirs.notification,
  theirs.rule,
  theirs.occurrence,
  marker,
];

beforeAll(async () => {
  process.env['RELEASE'] = '1.2';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
  discovered = mountedRoutes(app);

  a = await signedIn();
  b = await signedIn();
  const mine = await seedUser(a, 'A');
  const own = await seedUser(b, 'B');
  await seed(
    {
      method: 'POST',
      path: '/api/currencies',
      body: { code: CUSTOM_CODE, symbol: '$', rate: '0.10' },
    },
    a.cookie,
  );

  // A deletes a second movement, which leaves a token to undo it.
  const deleted = uuidv7();
  await seed(
    {
      method: 'POST',
      path: '/api/transactions',
      body: {
        kind: 'expense',
        id: deleted,
        accountId: mine.account,
        categoryId: mine.category,
        amount: '2.00',
        date: dayOffset(1),
      },
    },
    a.cookie,
  );
  const removal = await seed({ method: 'DELETE', path: `/api/transactions/${deleted}` }, a.cookie);
  const undoToken = removal['undoToken'];
  if (typeof undoToken !== 'string') throw new Error('the deletion returned no undo token');

  // A recurring rule of each user with a pending occurrence, written by SQL (plan §3.6). The one of
  // B is two days old, so that confirming it only fails over what the request names.
  const ruleA = await createRule(a.userId, { name: `Regla A ${marker}` });
  const occurrenceA = await createOccurrence(a.userId, ruleA.id);
  const ruleB = await createRule(b.userId, { name: `Regla B ${markers.B}` });
  const occurrenceB = await createOccurrence(b.userId, ruleB.id, { scheduledDate: dayOffset(2) });

  theirs = {
    ...mine,
    ...(await budgetOf(a, mine.category)),
    notification: await notificationOf(a),
    undoToken,
    currency: CUSTOM_CODE,
    rule: ruleA.id,
    occurrence: occurrenceA.id,
    own: {
      account: own.account,
      category: own.category,
      transaction: own.transaction,
      goal: own.goal,
      rule: ruleB.id,
      occurrence: occurrenceB.id,
      debt: own.debt,
    },
  };
  unknown = {
    account: uuidv7(),
    category: uuidv7(),
    transaction: uuidv7(),
    shortcut: uuidv7(),
    goal: uuidv7(),
    debt: uuidv7(),
    budget: uuidv7(),
    budgetPeriod: uuidv7(),
    notification: uuidv7(),
    undoToken: uuidv7(),
    currency: UNKNOWN_CODE,
    rule: uuidv7(),
    occurrence: uuidv7(),
    own: theirs.own,
  };
}, 180_000);

afterAll(async () => {
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  await deleteRecurringOf([a.userId, b.userId]);
  await testPrisma()
    .$executeRaw`DELETE FROM debt WHERE user_id = ANY(${[a.userId, b.userId]}::uuid[])`;
  await deleteBudgetsOf([a.userId, b.userId]);
  await deleteGoalsOf([a.userId, b.userId]);
  if (emails.length > 0) {
    await testPrisma().$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  }
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
});

const privateRoutes = Object.entries(COVERAGE).filter(([, c]) => c !== 'public');

/** A request to the route with no resource named: placeholders in the path, an empty body. */
const bareSpec = (key: string): Spec => {
  const [method, path] = key.split(' ');
  return {
    method: method as Method,
    path: (path ?? '').replace(/:\w+/g, uuidv7()),
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
  };
};

describe('RNF-14 cobertura: ninguna ruta montada queda sin cubrir', () => {
  it('RNF-14 cada ruta montada de /api tiene su entrada en el barrido y cada entrada tiene su ruta', () => {
    const apiRoutes = discovered.filter((r) => r.split(' ')[1]?.startsWith('/api/'));
    expect(apiRoutes.length).toBeGreaterThan(0);
    const missing = apiRoutes.filter((route) => !(route in COVERAGE));
    const stale = Object.keys(COVERAGE).filter((route) => !apiRoutes.includes(route));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it('RNF-14 toda ruta con :id o :code se prueba con un recurso ajeno', () => {
    const withParams = discovered.filter((route) => route.includes(':') && route.includes('/api/'));
    expect(withParams.length).toBeGreaterThan(0);
    const uncovered = withParams.filter((route) => {
      const entry = COVERAGE[route];
      return (
        entry === undefined ||
        typeof entry === 'string' ||
        entry.foreign === undefined ||
        entry.foreign.length === 0
      );
    });
    expect(uncovered).toEqual([]);
  });

  it('RNF-14 fuera de /api solo están las rutas internas conocidas', () => {
    const outside = discovered.filter((r) => !r.split(' ')[1]?.startsWith('/api/'));
    expect([...outside].sort()).toEqual([...INTERNAL_ROUTES].sort());
  });
});

describe('RNF-14 toda ruta privada exige sesión', () => {
  for (const [key] of privateRoutes) {
    it(`RNF-14 ${key} sin sesión responde 401 SESSION_EXPIRED`, async () => {
      const res = await send(bareSpec(key));

      expect(res.status).toBe(401);
      expect(problem(res).code).toBe('SESSION_EXPIRED');
    });

    it(`RNF-14 ${key} con una cookie que no es de ninguna sesión responde 401 SESSION_EXPIRED`, async () => {
      const res = await send(bareSpec(key), `${COOKIE_NAME}=${encodeURIComponent('nadie.firma')}`);

      expect(res.status).toBe(401);
      expect(problem(res).code).toBe('SESSION_EXPIRED');
    });
  }

  it('RNF-14 las rutas públicas no piden sesión', async () => {
    const publicKeys = Object.entries(COVERAGE)
      .filter(([, c]) => c === 'public')
      .map(([key]) => key);
    expect(publicKeys.length).toBeGreaterThan(0);
    for (const key of publicKeys) {
      const res = await send(bareSpec(key));
      expect(problem(res).code, key).not.toBe('SESSION_EXPIRED');
      expect(res.status, key).not.toBe(401);
    }
  });
});

describe('RNF-14 un recurso ajeno responde 404, igual que uno inexistente', () => {
  for (const [key, entry] of Object.entries(COVERAGE)) {
    if (typeof entry === 'string') continue;
    const foreign = entry.foreign ?? [];
    foreign.forEach((build, index) => {
      it(`RNF-14 ${key} con un recurso de A desde la sesión de B responde 404 (${index + 1})`, async () => {
        const res = await send(build(theirs), b.cookie);
        const missing = await send(build(unknown), b.cookie);

        expect(res.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(shape(res)).toEqual(shape(missing));
        for (const text of ownTexts()) {
          expect(res.text).not.toContain(text);
        }
      });
    });
  }
});

describe('RNF-14 un recurso de A nombrado en el cuerpo o en la consulta se trata como inexistente', () => {
  for (const [key, entry] of Object.entries(COVERAGE)) {
    if (typeof entry === 'string') continue;
    const refs = entry.refs ?? [];
    refs.forEach((build, index) => {
      it(`RNF-14 ${key} que nombra un recurso de A desde la sesión de B responde como con uno inexistente (${index + 1})`, async () => {
        const res = await send(build(theirs), b.cookie);
        const missing = await send(build(unknown), b.cookie);

        expect(shape(res)).toEqual(shape(missing));
        for (const text of ownTexts()) {
          expect(res.text).not.toContain(text);
        }
      });
    });
  }
});

describe('RNF-14 las listas del usuario B no traen datos de A', () => {
  const month = dayOffset(0).slice(0, 7);
  const lists: Spec[] = [
    { method: 'GET', path: '/api/accounts' },
    { method: 'GET', path: '/api/accounts', query: { status: 'archived' } },
    { method: 'GET', path: '/api/categories', query: { kind: 'expense' } },
    { method: 'GET', path: '/api/categories', query: { kind: 'income' } },
    { method: 'GET', path: '/api/transactions' },
    { method: 'GET', path: '/api/shortcuts' },
    { method: 'GET', path: '/api/notifications' },
    { method: 'GET', path: '/api/goals' },
    { method: 'GET', path: '/api/recurring' },
    { method: 'GET', path: '/api/debts' },
    { method: 'GET', path: '/api/debts', query: { view: 'person' } },
    { method: 'GET', path: '/api/budgets' },
    { method: 'GET', path: '/api/currencies' },
    { method: 'GET', path: '/api/dashboard', query: { month } },
    { method: 'GET', path: '/api/register/context' },
  ];
  for (const spec of lists) {
    const query = spec.query === undefined ? '' : `?${new URLSearchParams(spec.query).toString()}`;
    it(`RNF-14 GET ${spec.path}${query} desde la sesión de B no contiene ningún dato de A`, async () => {
      const res = await send(spec, b.cookie);

      expect(res.status).toBe(200);
      for (const text of ownTexts()) {
        expect(res.text).not.toContain(text);
      }
      expect(res.text).not.toContain(`"code":"${CUSTOM_CODE}"`);
    });
  }
});

describe('RNF-14 tras el barrido los recursos de A siguen intactos', () => {
  it('RNF-14 A sigue viendo su cuenta, su categoría, su movimiento, su atajo, su meta, su deuda, su aviso y su moneda sin cambios', async () => {
    const accounts = await send({ method: 'GET', path: '/api/accounts' }, a.cookie);
    expect(accounts.status).toBe(200);
    expect(accounts.text).toContain(theirs.account);
    expect(accounts.text).toContain(`Caja A ${marker}`);

    const categories = await send(
      { method: 'GET', path: '/api/categories', query: { kind: 'expense' } },
      a.cookie,
    );
    expect(categories.text).toContain(theirs.category);
    expect(categories.text).toContain(`Cat A ${marker}`);
    expect(categories.text).not.toContain('Cambiada por otro');

    const transaction = await send(
      { method: 'GET', path: `/api/transactions/${theirs.transaction}` },
      a.cookie,
    );
    expect(transaction.status).toBe(200);
    expect(transaction.text).toContain(`Nota A ${marker}`);
    expect(transaction.text).toContain(theirs.account);
    expect(transaction.text).toContain(theirs.category);

    const shortcuts = await send({ method: 'GET', path: '/api/shortcuts' }, a.cookie);
    expect(shortcuts.text).toContain(theirs.shortcut);
    expect(shortcuts.text).toContain(`Atajo A ${marker}`);

    const goal = await send({ method: 'GET', path: `/api/goals/${theirs.goal}` }, a.cookie);
    expect(goal.status).toBe(200);
    expect(goal.text).toContain(`Meta A ${marker}`);
    expect(goal.text).not.toContain('Cambiada por otro');

    const debts = await send({ method: 'GET', path: '/api/debts' }, a.cookie);
    expect(debts.status).toBe(200);
    expect(debts.text).toContain(theirs.debt);
    expect(debts.text).toContain(`Persona A ${marker}`);
    expect(debts.text).not.toContain('Cambiada por otro');
    const budget = await send({ method: 'GET', path: `/api/budgets/${theirs.budget}` }, a.cookie);
    expect(budget.status).toBe(200);
    expect(budget.text).toContain(theirs.budgetPeriod);
    expect(budget.text).toContain('"500.00"');

    const notifications = await send({ method: 'GET', path: '/api/notifications' }, a.cookie);
    expect(notifications.text).toContain(theirs.notification);

    const currencies = await send({ method: 'GET', path: '/api/currencies' }, a.cookie);
    expect(currencies.text).toContain(`"code":"${CUSTOM_CODE}"`);
  });

  it('RNF-14 A sigue viendo su regla recurrente y su pendiente, sin cambios', async () => {
    const overview = await send({ method: 'GET', path: '/api/recurring' }, a.cookie);
    expect(overview.status).toBe(200);
    expect(overview.text).toContain(theirs.rule);
    expect(overview.text).toContain(`Regla A ${marker}`);
    expect(overview.text).toContain(theirs.occurrence);
    expect(overview.text).not.toContain('Cambiada por otro');

    const rows = await testPrisma().$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM recurring_rule
       WHERE id = ${theirs.rule}::uuid AND user_id = ${a.userId}::uuid
         AND name = ${`Regla A ${marker}`}`;
    expect(rows.map((r) => r.status)).toEqual(['active']);
    expect(await occurrenceStatus(theirs.occurrence)).toBe('pending');
    expect(await occurrenceStatus(theirs.own.occurrence)).toBe('pending');
  });

  it('RNF-14 la fila de A en la base de datos no cambió de dueño ni se borró', async () => {
    const db = testPrisma();
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT (
        (SELECT count(*) FROM account WHERE id = ${theirs.account}::uuid AND user_id = ${a.userId}::uuid AND name = ${`Caja A ${marker}`}) +
        (SELECT count(*) FROM category WHERE id = ${theirs.category}::uuid AND user_id = ${a.userId}::uuid AND name = ${`Cat A ${marker}`}) +
        (SELECT count(*) FROM shortcut WHERE id = ${theirs.shortcut}::uuid AND user_id = ${a.userId}::uuid) +
        (SELECT count(*) FROM goal WHERE id = ${theirs.goal}::uuid AND user_id = ${a.userId}::uuid AND archived_at IS NULL AND name = ${`Meta A ${marker}`}) +
        (SELECT count(*) FROM budget WHERE id = ${theirs.budget}::uuid AND user_id = ${a.userId}::uuid AND status = 'active' AND amount = 500.00) +
        (SELECT count(*) FROM budget_period WHERE id = ${theirs.budgetPeriod}::uuid AND user_id = ${a.userId}::uuid AND status = 'closed_pending') +
        (SELECT count(*) FROM debt WHERE id = ${theirs.debt}::uuid AND user_id = ${a.userId}::uuid AND status = 'active' AND person = ${`Persona A ${marker}`}) +
        (SELECT count(*) FROM notification WHERE id = ${theirs.notification}::uuid AND user_id = ${a.userId}::uuid AND read_at IS NULL)
      )::int AS n`;
    expect(rows[0]?.n).toBe(8);
  });
});
