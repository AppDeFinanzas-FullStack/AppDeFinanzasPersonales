import { z } from 'zod';

import { Uuid } from './common.js';

/** The in-app notification types (RF-M15-02). There is no "strong dollar change" type (RF-M15-08). */
export const NotificationType = z.enum([
  'payment_upcoming',
  'budget_alert',
  'period_close',
  'recurring_pending',
  'log_day',
  'goal_progress',
]);
export type NotificationType = z.infer<typeof NotificationType>;

export const NotificationDecision = z.object({
  kind: z.enum(['budget_period', 'occurrence']),
  ref: z.string(),
  status: z.enum(['waiting', 'resolved']),
});
export type NotificationDecision = z.infer<typeof NotificationDecision>;

export const NotificationDto = z.object({
  id: Uuid,
  type: NotificationType,
  params: z.record(z.string(), z.unknown()),
  targetRoute: z.string(),
  createdAt: z.string(),
  read: z.boolean(),
  decision: NotificationDecision.optional(),
});
export type NotificationDto = z.infer<typeof NotificationDto>;

export const NotificationsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().max(50).default(20),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;

export const PreferenceInput = z.object({
  type: NotificationType,
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23).optional(),
  leadDays: z.number().int().min(0).max(7).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
});
export type PreferenceInput = z.infer<typeof PreferenceInput>;

export const PreferencesInput = z.array(PreferenceInput);
export type PreferencesInput = z.infer<typeof PreferencesInput>;

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** The preferences created with each user (RF-M15-02, plan §4.15.1). */
export const DEFAULT_PREFERENCES: readonly PreferenceInput[] = [
  { type: 'payment_upcoming', enabled: true },
  { type: 'budget_alert', enabled: true },
  { type: 'period_close', enabled: true },
  { type: 'recurring_pending', enabled: true },
  { type: 'log_day', enabled: false, hour: 21, weekdays: ALL_WEEKDAYS },
  { type: 'goal_progress', enabled: false },
];
