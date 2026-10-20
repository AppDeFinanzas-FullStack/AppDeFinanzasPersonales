/**
 * Readiness of the API's dependencies (plan §4.2.2): `GET /api/health/ready` answers 204 when the
 * probe passes and 503 otherwise. It never throws and never reveals why it failed.
 */
export interface ReadinessProbe {
  check(): Promise<boolean>;
}
