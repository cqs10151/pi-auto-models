/**
 * Quota & Cooldown Utilities (Enhanced)
 */

/**
 * 兼容标准 Headers 实例与普通 Record 对象
 */
export function normalizeHeaders(
  headers: Record<string, any> | Headers | undefined,
): Record<string, string> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};

  if (typeof (headers as any).forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }

  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    normalized[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return normalized;
}

/**
 * 从响应头解析冷却时间，并结合失败次数做指数退避
 */
export function parseRetryCooldownMs(
  rawHeaders: Record<string, any> | Headers | undefined,
  consecutiveFailures: number = 1,
  baseDefaultMs = 60 * 1000,
): number {
  const headers = normalizeHeaders(rawHeaders);

  // 1. 显式毫秒级响应头
  const retryMs = headers["retry-after-ms"];
  if (retryMs) {
    const ms = Number(retryMs);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }

  // 2. 标准 Retry-After (秒数 或 HTTP-Date)
  const retryAfter = headers["retry-after"] ?? headers["retry-after-seconds"];
  if (retryAfter) {
    const num = Number(retryAfter);
    if (!Number.isNaN(num) && num > 0) {
      return num * 1000;
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }

  // 3. 通用 RateLimit Reset 头部
  const resetHeader =
    headers["x-ratelimit-reset-requests"] ??
    headers["x-ratelimit-reset-tokens"] ??
    headers["x-ratelimit-reset"] ??
    headers["ratelimit-reset"] ??
    headers["x-ratelimit-reset-after"];

  if (resetHeader) {
    const num = Number(resetHeader);
    if (!Number.isNaN(num) && num > 0) {
      if (num > 1e9) {
        return Math.max(0, num * 1000 - Date.now());
      }
      return num * 1000;
    }
  }

  // 4. 指数退避倍率: 1次=1x(60s), 2次=3x(3m), 3次=10x(10m), 4次以上=30x(30m)
  const backoffMultipliers = [1, 1, 3, 10, 30];
  const multiplier = backoffMultipliers[Math.min(consecutiveFailures, backoffMultipliers.length - 1)];
  return baseDefaultMs * multiplier;
}

export function getModelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}