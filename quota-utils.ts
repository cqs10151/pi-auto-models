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
const PASSIVE_RATE_LIMIT_STALE_MS = 5 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;

export function isRateLimitInfoStale(info: RateLimitInfo | undefined, now = Date.now()): boolean {
  if (!info?.capturedAt) return false;
  return now - info.capturedAt > PASSIVE_RATE_LIMIT_STALE_MS;
}

export function getPassiveRateLimitCooldownMs(info: RateLimitInfo | undefined, now = Date.now()): number {
  if (!info?.utilization) return 0;
  if (isRateLimitInfoStale(info, now)) return 0;
  if (Number(info.utilization) < PASSIVE_LIMIT_THRESHOLD) return 0;
  if (!info.reset) return 0;

  const resetSeconds = Number(info.reset);
  if (!Number.isFinite(resetSeconds)) return 0;
  return Math.max(0, resetSeconds * 1000 - now);
}

export function isProviderRateLimitError(message: string | undefined): boolean {
  if (!message) return false;
  return /\b429\b|rate_limit_error|rate limit/i.test(message);
}

export function parseCooldownMs(
  headers: Record<string, string> | undefined,
  now = Date.now(),
  defaultCooldownMs = DEFAULT_COOLDOWN_MS,
): number {
  if (!headers) return defaultCooldownMs;
  const reset = headers["anthropic-ratelimit-unified-5h-reset"] ?? headers["anthropic-ratelimit-unified-reset"];
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds)) {
      const ms = seconds * 1000 - now;
      if (ms > 0) return ms;
    }
  }
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const ms = Number(retryAfterMs);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  return defaultCooldownMs;
}
