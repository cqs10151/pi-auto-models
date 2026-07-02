export interface RateLimitInfo {
  utilization?: string;
  status?: string;
  reset?: string;
  weeklyUtilization?: string;
  weeklyStatus?: string;
  weeklyReset?: string;
  requestsLimit?: string;
  requestsRemaining?: string;
  requestsReset?: string;
  tokensLimit?: string;
  tokensRemaining?: string;
  tokensReset?: string;
  capturedAt?: number;
}

const PASSIVE_LIMIT_THRESHOLD = 0.99;

export function getPassiveRateLimitCooldownMs(info: RateLimitInfo | undefined, now = Date.now()): number {
  if (!info?.utilization) return 0;
  if (Number(info.utilization) < PASSIVE_LIMIT_THRESHOLD) return 0;
  if (!info.reset) return 0;

  const resetSeconds = Number(info.reset);
  if (!Number.isFinite(resetSeconds)) return 0;
  return Math.max(0, resetSeconds * 1000 - now);
}
