export type Release = '1.0' | '1.1' | '1.2';

export type ModuleKey =
  | 'M1'
  | 'M2'
  | 'M3'
  | 'M4'
  | 'M5'
  | 'M6'
  | 'M7'
  | 'M8'
  | 'M9'
  | 'M10'
  | 'M11'
  | 'M12'
  | 'M13'
  | 'M14'
  | 'M15';

export type ModuleRelease = Record<ModuleKey, Release>;

export type ReleasedNotificationType =
  | 'budget_alert'
  | 'period_close'
  | 'payment_upcoming'
  | 'goal_progress'
  | 'log_day'
  | 'recurring_pending';

export const MODULE_RELEASE: ModuleRelease = {
  M1: '1.0',
  M2: '1.0',
  M3: '1.0',
  M4: '1.0',
  M5: '1.0',
  M6: '1.0',
  M7: '1.0',
  M8: '1.0',
  M9: '1.0',
  M10: '1.0',
  M11: '1.1',
  M12: '1.1',
  M13: '1.1',
  M14: '1.2',
  M15: '1.1',
};

const RELEASE_ORDER: Record<Release, number> = { '1.0': 0, '1.1': 1, '1.2': 2 };

const NOTIFICATION_TYPE_RELEASE: Record<ReleasedNotificationType, Release> = {
  budget_alert: '1.1',
  period_close: '1.1',
  payment_upcoming: '1.1',
  goal_progress: '1.2',
  log_day: '1.2',
  recurring_pending: '1.2',
};

export function isReleased(module: ModuleKey, release: Release): boolean {
  return RELEASE_ORDER[MODULE_RELEASE[module]] <= RELEASE_ORDER[release];
}

export function releasedNotificationTypes(release: Release): ReleasedNotificationType[] {
  return (Object.keys(NOTIFICATION_TYPE_RELEASE) as ReleasedNotificationType[]).filter(
    (type) => RELEASE_ORDER[NOTIFICATION_TYPE_RELEASE[type]] <= RELEASE_ORDER[release],
  );
}
