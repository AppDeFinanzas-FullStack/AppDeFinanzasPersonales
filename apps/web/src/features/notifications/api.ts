import { NotificationDto } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

/** A page of the inbox, from the newest to the oldest (plan §4.15.2). */
const NotificationsPage = z.object({
  items: z.array(NotificationDto),
  nextCursor: z.string().nullable(),
});
export type NotificationsPage = z.infer<typeof NotificationsPage>;

const ListInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().optional(),
});

const UnreadCount = z.object({ count: z.number().int() });

const path = (id: string, action = '') => `/api/notifications/${encodeURIComponent(id)}${action}`;

export const listNotificationsEndpoint: Endpoint<z.infer<typeof ListInput>, NotificationsPage> = {
  method: 'GET',
  path: '/api/notifications',
  input: ListInput,
  output: NotificationsPage,
};

export const unreadCountEndpoint: Endpoint<undefined, z.infer<typeof UnreadCount>> = {
  method: 'GET',
  path: '/api/notifications/unread-count',
  input: z.undefined(),
  output: UnreadCount,
};

export const markReadEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'POST',
  path: path(id, '/read'),
  input: z.undefined(),
  output: z.void(),
});

export const markAllReadEndpoint: Endpoint<undefined, void> = {
  method: 'POST',
  path: '/api/notifications/read-all',
  input: z.undefined(),
  output: z.void(),
};

export const removeNotificationEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'DELETE',
  path: path(id),
  input: z.undefined(),
  output: z.void(),
});
