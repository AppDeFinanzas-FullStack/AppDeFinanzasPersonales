import type { NotificationDto } from '@finanzas/contracts';

import type {
  NotificationRecord,
  NotificationsPage,
} from '../../application/services/notifications.service.js';

/** Builds the answers of `/api/notifications` (plan §4.15.1, §4.15.2). */
export const NotificationsPresenter = {
  toDto(record: NotificationRecord): NotificationDto {
    return {
      id: record.id,
      type: record.type,
      params: record.params,
      targetRoute: record.targetRoute,
      createdAt: record.createdAt.toISOString(),
      read: record.readAt !== null,
      ...(record.decision === null ? {} : { decision: { ...record.decision } }),
    };
  },

  page(page: NotificationsPage): { items: NotificationDto[]; nextCursor: string | null } {
    return {
      items: page.items.map((record) => NotificationsPresenter.toDto(record)),
      nextCursor: page.nextCursor,
    };
  },

  unreadCount(count: number): { count: number } {
    return { count };
  },
};
