/**
 * Quota & Cooldown Utilities
 */

/**
 * 统一将 Header 的 Key 转换为小写，兼容各种 HTTP Headers 格式
 */
export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    normalized[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return normalized;
}

/**
 * 尝试从响应头解析重试冷却毫秒数，若无法解析则返回默认冷却时间
 */
export function parseRetryCooldownMs(
  rawHeaders: Record<string, any> | undefined,
  defaultMs = 60 * 1000,
): number {
  if (!rawHeaders) return defaultMs;
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

  return defaultMs;
}

/**
 * 生成唯一的模型标识 key
 */
export function getModelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}