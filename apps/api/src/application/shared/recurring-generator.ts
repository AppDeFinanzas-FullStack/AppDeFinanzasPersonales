import {
  amountInFrom,
  BOLIVIA_TIME_ZONE,
  isFinished,
  nextDates,
  type RecurrenceRule,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type { Clock, LocalDate } from '../ports/clock.js';
import type {
  AccountRow,
  LedgerEntryInput,
  RecurringOccurrenceRow,
  RecurringRuleRow,
  Repositories,
} from '../ports/repositories.js';
import type { MovementRates, RatesContext, RatesService } from '../services/rates.service.js';
import { BalanceGuard, type BalanceDelta } from './balance-guard.js';
import type { LedgerChange, LedgerHooks } from './ledger-hooks.js';
import type { NotificationEmitter } from './notification-emitter.js';

/** The IANA timezone of the user's profile (RNF-20); `null` when the user does not exist. */
export interface UserTimezones {
  timezoneOf(userId: string): Promise<string | null>;
}

export interface RecurringGeneratorDeps {
  rates: RatesService;
  ledgerHooks: LedgerHooks;
  notifications: NotificationEmitter;
  timezones: UserTimezones;
  clock: Clock;
}

export interface RecurringGenerator {
  /**
   * Generates, inside the caller's transaction, every missing occurrence of the rule from its
   * `lastGeneratedDate` up to `today`, the local date of the user (plan §4.14.3). The caller holds
   * the user's lock and the rule's row lock.
   */
  generateDue(tx: Repositories, userId: string, rule: RecurringRuleRow, today: LocalDate): Promise<void>;
}

/** Where the notification of a pending occurrence leads (plan §4.14.4). */
const PENDING_ROUTE = '/recurrentes';

/** Errors of an automatic occurrence that leave it pending instead of failing the run (RF-M14-05). */
const PENDING_ERRORS: ReadonlySet<string> = new Set(['NEGATIVE_BALANCE', 'RATE_REQUIRED']);

const MS_PER_DAY = 86_400_000;

/** The next calendar date; local dates are compared as dates, never as instants (RF-M14-04). */
function nextDay(date: LocalDate): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

function recurrenceOf(rule: RecurringRuleRow): RecurrenceRule {
  return { frequency: rule.frequency, startDate: rule.startDate, end: rule.end };
}

/** The delta of an entry, or none when it is dated before the initial balance (RN-12). */
function deltaFor(account: AccountRow, date: LocalDate, amount: Decimal): BalanceDelta[] {
  return date < account.initialBalanceDate ? [] : [{ accountId: account.id, amount }];
}

/** The movement an automatic occurrence would save: its header data, entries and deltas. */
interface PlannedMovement {
  categoryId: string | null;
  rates: MovementRates;
  declaredRate: Decimal | null;
  entries: LedgerEntryInput[];
  deltas: BalanceDelta[];
  change: LedgerChange;
}

export function createRecurringGenerator({
  rates,
  ledgerHooks,
  notifications,
  timezones,
  clock,
}: RecurringGeneratorDeps): RecurringGenerator {
  async function account(tx: Repositories, id: string): Promise<AccountRow> {
    const row = await tx.accounts.get(id);
    if (row === null) {
      throw new AppError('NOT_FOUND');
    }
    return row;
  }

  async function planSimple(
    tx: Repositories,
    ctx: RatesContext,
    rule: RecurringRuleRow,
    amount: Decimal,
    date: LocalDate,
  ): Promise<PlannedMovement> {
    const from = await account(tx, rule.accountId);
    const signed = rule.kind === 'expense' ? amount.negated() : amount;
    return {
      categoryId: rule.categoryId,
      rates: await rates.ratesForMovement(tx, ctx, from.currencyCode, date),
      declaredRate: null,
      entries: [{ id: uuidv7(), accountId: from.id, amount: signed }],
      deltas: deltaFor(from, date, signed),
      change: {
        dates: [date],
        categoryIds: rule.categoryId === null ? [] : [rule.categoryId],
        accountIds: [from.id],
      },
    };
  }

  /**
   * A transfer between currencies takes the prefill of RF-M3-07 of the occurrence's date
   * (RF-M14-06); the declared rate is stored with the convention of plan §4.6.1.
   */
  async function planTransfer(
    tx: Repositories,
    ctx: RatesContext,
    rule: RecurringRuleRow,
    amount: Decimal,
    date: LocalDate,
  ): Promise<PlannedMovement> {
    if (rule.destAccountId === null) {
      throw new AppError('NOT_FOUND');
    }
    const from = await account(tx, rule.accountId);
    const to = await account(tx, rule.destAccountId);
    let declaredRate: Decimal | null = null;
    let amountIn = amount;
    let movementRates: MovementRates;
    if (from.currencyCode === to.currencyCode) {
      movementRates = await rates.ratesForMovement(tx, ctx, from.currencyCode, date);
    } else {
      declaredRate = await rates.transferRate(tx, ctx, from.currencyCode, to.currencyCode, date);
      if (declaredRate === null) {
        throw new AppError('RATE_REQUIRED');
      }
      amountIn = amountInFrom(amount, declaredRate, from.currencyCode);
      movementRates = await transferRates(tx, ctx, from.currencyCode, to.currencyCode, date, declaredRate);
    }
    const amountOut = amount.negated();
    return {
      categoryId: null,
      rates: movementRates,
      declaredRate,
      entries: [
        { id: uuidv7(), accountId: from.id, amount: amountOut },
        { id: uuidv7(), accountId: to.id, amount: amountIn },
      ],
      deltas: [...deltaFor(from, date, amountOut), ...deltaFor(to, date, amountIn)],
      change: { dates: [date], categoryIds: [], accountIds: [from.id, to.id] },
    };
  }

  /** The rates a transfer between currencies stores, in the currency of the origin (plan §4.6.1). */
  async function transferRates(
    tx: Repositories,
    ctx: RatesContext,
    from: string,
    to: string,
    date: LocalDate,
    declaredRate: Decimal,
  ): Promise<MovementRates> {
    if (from !== 'BOB' && to !== 'BOB') {
      return rates.ratesForMovement(tx, ctx, from, date);
    }
    const rateCurBob = from === 'BOB' ? new Decimal(1) : declaredRate;
    if (from === 'USD' || to === 'USD') {
      return { rateCurBob, rateUsdBob: declaredRate };
    }
    const { rateUsdBob } = await rates.ratesForMovement(tx, ctx, 'BOB', date);
    return { rateCurBob, rateUsdBob };
  }

  /**
   * Saves the movement of an automatic occurrence with `BalanceGuard` in `automatic` mode. Returns
   * `false` when it is blocked by a negative balance or earmarked money, or lacks a rate, so the
   * occurrence stays pending (RF-M14-05, EC-M4-03, EC-M12-05).
   */
  async function register(
    tx: Repositories,
    ctx: RatesContext,
    rule: RecurringRuleRow,
    date: LocalDate,
  ): Promise<boolean> {
    if (rule.amount === null) {
      return false;
    }
    try {
      const planned =
        rule.kind === 'transfer'
          ? await planTransfer(tx, ctx, rule, rule.amount, date)
          : await planSimple(tx, ctx, rule, rule.amount, date);
      const outcome = await BalanceGuard.apply(tx, ctx.userId, planned.deltas, { mode: 'automatic' });
      if (outcome !== undefined) {
        return false;
      }
      const id = uuidv7();
      const inserted = await tx.ledger.insertTransaction(
        {
          id,
          kind: rule.kind,
          date,
          note: rule.note,
          categoryId: planned.categoryId,
          origin: 'recurring',
          originId: null,
          parentTransactionId: null,
          recurringRuleId: rule.id,
          recurringLabel: rule.name,
          rateCurBob: planned.rates.rateCurBob,
          rateUsdBob: planned.rates.rateUsdBob,
          declaredRate: planned.declaredRate,
        },
        planned.entries,
      );
      if (!inserted) {
        throw new Error('The recurring transaction could not be inserted');
      }
      await ledgerHooks.afterChange(tx, ctx.userId, planned.change);
      return true;
    } catch (error) {
      if (error instanceof AppError && PENDING_ERRORS.has(error.code)) {
        return false;
      }
      throw error;
    }
  }

  /** The occurrence waits for the user: notice `recurring_pending:{occurrenceId}` (plan §4.14.3). */
  async function leavePending(
    tx: Repositories,
    userId: string,
    rule: RecurringRuleRow,
    occurrence: RecurringOccurrenceRow,
  ): Promise<void> {
    await notifications.emit(tx, userId, {
      type: 'recurring_pending',
      eventKey: `recurring_pending:${occurrence.id}`,
      params: { ruleId: rule.id, ruleName: rule.name, date: occurrence.scheduledDate },
      targetRoute: PENDING_ROUTE,
      decision: { kind: 'occurrence', ref: occurrence.id },
    });
  }

  return {
    async generateDue(tx, userId, rule, today) {
      if (rule.status !== 'active') {
        return;
      }
      const recurrence = recurrenceOf(rule);
      let generatedCount = rule.generatedCount;
      let lastGeneratedDate = rule.lastGeneratedDate;
      let ctx: RatesContext | null = null;

      for (;;) {
        const from = lastGeneratedDate === null ? rule.startDate : nextDay(lastGeneratedDate);
        if (isFinished(recurrence, generatedCount, from)) {
          break;
        }
        const date = nextDates(recurrence, from, 1)[0];
        if (date === undefined || date > today) {
          break;
        }
        lastGeneratedDate = date;
        const occurrence = await tx.recurringOccurrences.insertIfAbsent(rule.id, date);
        if (occurrence === null) {
          // Already generated for that date (RF-M14-12).
          continue;
        }
        generatedCount += 1;

        if (rule.mode === 'auto') {
          ctx ??= {
            userId,
            timezone: (await timezones.timezoneOf(userId)) ?? BOLIVIA_TIME_ZONE,
            now: clock.now(),
            traceId: uuidv7(),
          };
          if (await register(tx, ctx, rule, date)) {
            await tx.recurringOccurrences.decideIf(occurrence.id, 'pending', 'registered');
            continue;
          }
        }
        await leavePending(tx, userId, rule, occurrence);
      }

      const finished = isFinished(recurrence, generatedCount, today);
      if (
        generatedCount !== rule.generatedCount ||
        lastGeneratedDate !== rule.lastGeneratedDate ||
        finished
      ) {
        await tx.recurringRules.update(rule.id, {
          generatedCount,
          lastGeneratedDate,
          ...(finished ? { status: 'finished' as const } : {}),
        });
      }
    },
  };
}
