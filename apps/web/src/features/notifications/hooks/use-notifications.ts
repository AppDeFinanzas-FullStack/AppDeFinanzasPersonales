import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import {
  listNotificationsEndpoint,
  markAllReadEndpoint,
  markReadEndpoint,
  removeNotificationEndpoint,
  unreadCountEndpoint,
  type NotificationsPage,
} from '../api';

/** Every change of the inbox invalidates this key, the list and the count (plan §4.15.4). */
export const NOTIFICATIONS_KEY = ['notifications'] as const;
export const UNREAD_KEY = [...NOTIFICATIONS_KEY, 'unread'] as const;
const LIST_KEY = [...NOTIFICATIONS_KEY, 'list'] as const;

const REFRESH_MS = 60_000;
const PAGE_SIZE = 20;

type ListData = InfiniteData<NotificationsPage, string | null>;

/**
 * The unread count of the bell (RF-M15-06): refreshed every 60 s and when the window regains focus,
 * always in the background so it never trips the session dialog (plan §4.2.4, §4.15.4).
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: UNREAD_KEY,
    queryFn: ({ signal }) => call(unreadCountEndpoint, undefined, { background: true, signal }),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}

/** The inbox by cursor, from the newest to the oldest, while the panel is open (plan §4.15.4). */
export function useNotifications(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: LIST_KEY,
    queryFn: ({ pageParam, signal }) =>
      call(
        listNotificationsEndpoint,
        { limit: PAGE_SIZE, ...(pageParam === null ? {} : { cursor: pageParam }) },
        { background: true, signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}

function useInvalidateNotifications() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
}

/** Marks one notification as read, also when it waits for a decision (RF-M15-12). */
export function useMarkRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: (id: string) => call(markReadEndpoint(id), undefined),
    onSettled: invalidate,
  });
}

/** "Marcar todo como leído" (RF-M15-12); the decisions stay in their modules. */
export function useMarkAllRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: () => call(markAllReadEndpoint, undefined),
    onSettled: invalidate,
  });
}

/**
 * Deletes a notification from the "…" menu (RF-M15-12, RNF-06). It leaves the loaded list at once
 * and comes back if the API rejects it.
 */
export function useRemoveNotification() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: (id: string) => call(removeNotificationEndpoint(id), undefined),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: LIST_KEY });
      const previous = queryClient.getQueryData<ListData>(LIST_KEY);
      queryClient.setQueryData<ListData>(LIST_KEY, (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            },
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(LIST_KEY, context.previous);
    },
    onSettled: invalidate,
  });
}
