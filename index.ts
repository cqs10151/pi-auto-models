/**
 * Auto Model Switch Extension
 *
 * 每次 session 开始时判断 Claude 是否有额度：
 * - 有额度 → claude-opus-4-6 + high thinking
 * - 没额度 → gpt-5.5 + high thinking
 *
 * 通过缓存限额过期时间避免重复检查。
 * 通过 after_provider_response 检测 429 自动切换并缓存。
 *
 * /quota 命令查看各 provider 的 5h 额度使用情况。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Types ──

interface ProviderQuota {
  rateLimitExpiresAt: number; // ms timestamp
}

/** 按 provider 存储限额缓存 */
type QuotaCache = Record<string, ProviderQuota>;

interface RateLimitInfo {
  utilization?: string;
  status?: string;
  reset?: string;
  requestsLimit?: string;
  requestsRemaining?: string;
  requestsReset?: string;
  tokensLimit?: string;
  tokensRemaining?: string;
  tokensReset?: string;
  capturedAt: number;
}

interface AuthEntry {
  type: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

interface CodexWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

interface CodexUsage {
  plan_type?: string;
  rate_limit?: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window?: CodexWindow;
    secondary_window?: CodexWindow;
  };
}

// ── Constants ──

const AUTH_FILE = join(getAgentDir(), "auth.json");
const CACHE_FILE = join(getAgentDir(), "claude-quota-cache.json");
const RATE_LIMIT_FILE = join(getAgentDir(), "auto-model-rate-limits.json");
// ponytail: 默认 5 小时冷却，Claude/Codex 限额周期通常是 5h，按实际 retry-after 覆盖
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;

const CLAUDE_PROVIDER = "anthropic";
const CLAUDE_MODEL = "claude-opus-4-6";
const CLAUDE_THINKING: "high" = "high";

const FALLBACK_PROVIDER = "openai-codex";
const FALLBACK_MODEL = "gpt-5.5";
const FALLBACK_THINKING: "high" = "high";

// ── Cache helpers ──

function readCache(): QuotaCache {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    // 兼容旧格式 { rateLimitExpiresAt: number }
    if (typeof raw.rateLimitExpiresAt === "number") {
      return { [CLAUDE_PROVIDER]: { rateLimitExpiresAt: raw.rateLimitExpiresAt } };
    }
    return raw as QuotaCache;
  } catch {
    return {};
  }
}

function writeCache(cache: QuotaCache): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch {
    // ponytail: 写不了就算了
  }
}

function setProviderRateLimit(provider: string, expiresAt: number): void {
  const cache = readCache();
  cache[provider] = { rateLimitExpiresAt: expiresAt };
  writeCache(cache);
}

function isProviderRateLimited(provider: string): boolean {
  const cache = readCache();
  const entry = cache[provider];
  if (!entry) return false;
  return Date.now() < entry.rateLimitExpiresAt;
}

function getProviderRateLimitLeft(provider: string): number {
  const cache = readCache();
  const entry = cache[provider];
  if (!entry) return 0;
  return Math.max(0, entry.rateLimitExpiresAt - Date.now());
}

// ── Auth helpers ──

function readAuth(): Record<string, AuthEntry> {
  try {
    if (!existsSync(AUTH_FILE)) return {};
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function readRateLimits(): Record<string, RateLimitInfo> {
  try {
    if (!existsSync(RATE_LIMIT_FILE)) return {};
    return JSON.parse(readFileSync(RATE_LIMIT_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeRateLimits(rateLimits: Map<string, RateLimitInfo>): void {
  try {
    writeFileSync(RATE_LIMIT_FILE, JSON.stringify(Object.fromEntries(rateLimits), null, 2), "utf-8");
  } catch {}
}

function extractCodexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

async function fetchCodexUsage(entry: AuthEntry): Promise<CodexUsage | null> {
  const accountId = entry.accountId ?? extractCodexAccountId(entry.access);
  const res = await fetch("https://chatgpt.com/backend-api/codex/usage", {
    headers: {
      authorization: `Bearer ${entry.access}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      originator: "pi",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Codex usage HTTP ${res.status}`);
  return (await res.json()) as CodexUsage;
}

// ── Model helpers ──

async function setModelTo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
): Promise<boolean> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    ctx.ui.notify(`模型 ${provider}/${modelId} 未找到`, "warning");
    return false;
  }
  const ok = await pi.setModel(model);
  if (!ok) {
    ctx.ui.notify(`模型 ${provider}/${modelId} 无可用 API Key`, "warning");
    return false;
  }
  pi.setThinkingLevel(thinking);
  return true;
}

// ── Rate limit header parsers ──

function parseAnthropicHeaders(headers: Record<string, string>): RateLimitInfo | null {
  const utilization = headers["anthropic-ratelimit-unified-5h-utilization"];
  if (utilization) {
    return {
      utilization,
      status: headers["anthropic-ratelimit-unified-5h-status"],
      reset: headers["anthropic-ratelimit-unified-5h-reset"],
      capturedAt: Date.now(),
    };
  }

  const rl = headers["anthropic-ratelimit-requests-limit"];
  if (!rl) return null;
  return {
    requestsLimit: rl,
    requestsRemaining: headers["anthropic-ratelimit-requests-remaining"],
    requestsReset: headers["anthropic-ratelimit-requests-reset"],
    tokensLimit: headers["anthropic-ratelimit-tokens-limit"],
    tokensRemaining: headers["anthropic-ratelimit-tokens-remaining"],
    tokensReset: headers["anthropic-ratelimit-tokens-reset"],
    capturedAt: Date.now(),
  };
}

function parseOpenAIHeaders(headers: Record<string, string>): RateLimitInfo | null {
  const rl = headers["x-ratelimit-limit-requests"];
  if (!rl) return null;
  return {
    requestsLimit: rl,
    requestsRemaining: headers["x-ratelimit-remaining-requests"],
    requestsReset: headers["x-ratelimit-reset-requests"],
    tokensLimit: headers["x-ratelimit-limit-tokens"],
    tokensRemaining: headers["x-ratelimit-remaining-tokens"],
    tokensReset: headers["x-ratelimit-reset-tokens"],
    capturedAt: Date.now(),
  };
}

// ── Formatting helpers ──

function formatTimeLeft(ms: number): string {
  if (ms <= 0) return "已过期";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

function formatAge(capturedAt: number): string {
  const sec = Math.round((Date.now() - capturedAt) / 1000);
  if (sec < 60) return `${sec}s 前`;
  return `${Math.round(sec / 60)}min 前`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function makeBar(pct: number): string {
  const safePct = Math.max(0, Math.min(100, pct));
  const filled = Math.round(safePct / 5);
  return "[" + "█".repeat(filled) + "░".repeat(20 - filled) + "]";
}

function formatReset(reset: string | number): string {
  const seconds = Number(reset);
  if (Number.isFinite(seconds)) return new Date(seconds * 1000).toLocaleString();
  return String(reset);
}

// ponytail: 从 retry-after / retry-after-ms header 解析冷却毫秒数
function parseCooldownMs(headers: Record<string, string> | undefined): number {
  if (!headers) return DEFAULT_COOLDOWN_MS;
  const reset = headers["anthropic-ratelimit-unified-5h-reset"] ?? headers["anthropic-ratelimit-unified-reset"];
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000 - Date.now());
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
  return DEFAULT_COOLDOWN_MS;
}

// ── Extension ──

export default function (pi: ExtensionAPI) {
  let usingClaude = false;
  let lastRequestProvider: string | undefined;
  const rateLimits = new Map<string, RateLimitInfo>(Object.entries(readRateLimits()));

  pi.on("before_provider_request", (event, ctx) => {
    lastRequestProvider = event.model?.provider ?? ctx.model?.provider ?? lastRequestProvider;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (isProviderRateLimited(CLAUDE_PROVIDER)) {
      const ok = await setModelTo(pi, ctx, FALLBACK_PROVIDER, FALLBACK_MODEL, FALLBACK_THINKING);
      if (ok) {
        usingClaude = false;
        ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("warning", `⚡ ${FALLBACK_MODEL}`));
        ctx.ui.notify(`Claude 限额中，使用 ${FALLBACK_MODEL}`, "info");
      }
    } else {
      const ok = await setModelTo(pi, ctx, CLAUDE_PROVIDER, CLAUDE_MODEL, CLAUDE_THINKING);
      if (ok) {
        usingClaude = true;
        ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("success", `🧠 ${CLAUDE_MODEL}`));
      } else {
        const fallbackOk = await setModelTo(pi, ctx, FALLBACK_PROVIDER, FALLBACK_MODEL, FALLBACK_THINKING);
        if (fallbackOk) {
          usingClaude = false;
          ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("warning", `⚡ ${FALLBACK_MODEL}`));
        }
      }
    }
  });

  // ── /quota 命令 ──

  pi.registerCommand("quota", {
    description: "显示 Claude / Codex 5h 额度使用情况",
    handler: async (_args, ctx) => {
      const auth = readAuth();
      const lines: string[] = [];

      for (const [provider, label] of [
        [CLAUDE_PROVIDER, "Claude"],
        [FALLBACK_PROVIDER, "Codex"],
      ] as const) {
        const entry = auth[provider];
        lines.push(`── ${label} (${provider}) ──`);

        // 登录状态
        if (!entry) {
          lines.push("  🔑 未登录");
        } else if (Date.now() > entry.expires) {
          lines.push("  🔑 Token 已过期，请重新 /login");
        } else {
          lines.push(`  🔑 已登录 (token 有效至 ${new Date(entry.expires).toLocaleDateString()})`);
        }

        let codexUsage: CodexUsage | null = null;
        let codexUsageError: string | undefined;
        if (provider === FALLBACK_PROVIDER && entry && Date.now() <= entry.expires) {
          try {
            codexUsage = await fetchCodexUsage(entry);
          } catch (error) {
            codexUsageError = error instanceof Error ? error.message : String(error);
          }
        }
        const codexPrimary = codexUsage?.rate_limit?.primary_window;

        // 限额状态（两个 provider 都支持）
        const left = getProviderRateLimitLeft(provider);
        if (codexUsage?.rate_limit?.limit_reached && codexPrimary) {
          lines.push(`  📊 ❌ 限额中，${formatTimeLeft(codexPrimary.reset_after_seconds * 1000)} 后恢复`);
          setProviderRateLimit(provider, codexPrimary.reset_at * 1000);
        } else if (codexUsage?.rate_limit?.allowed) {
          lines.push("  📊 ✅ 额度可用");
        } else if (left > 0) {
          lines.push(`  📊 ❌ 限额中，${formatTimeLeft(left)} 后恢复`);
        } else {
          lines.push("  📊 ✅ 额度可用");
        }

        // Codex 有主动实时 endpoint
        if (codexPrimary) {
          const pct = Math.round(codexPrimary.used_percent);
          lines.push(`  📈 5h 额度: ${makeBar(pct)} ${pct}%${codexUsage?.plan_type ? ` (${codexUsage.plan_type})` : ""}`);
          lines.push(`  🔄 5h 窗口重置: ${formatReset(codexPrimary.reset_at)}`);
          lines.push(`  ⏱  实时查询`);
          lines.push("");
          continue;
        }

        // Claude 从响应 headers 被动捕获
        const rl = rateLimits.get(provider);
        if (rl) {
          if (rl.utilization) {
            const pct = Math.round(Number(rl.utilization) * 100);
            lines.push(`  📈 5h 额度: ${makeBar(pct)} ${pct}%${rl.status ? ` (${rl.status})` : ""}`);
          }
          if (rl.requestsLimit && rl.requestsRemaining) {
            const limit = Number(rl.requestsLimit);
            const remaining = Number(rl.requestsRemaining);
            const used = limit - remaining;
            const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
            lines.push(`  📈 Requests: ${used}/${limit} ${makeBar(pct)} ${pct}%`);
          }
          if (rl.tokensLimit && rl.tokensRemaining) {
            const limit = Number(rl.tokensLimit);
            const remaining = Number(rl.tokensRemaining);
            const used = limit - remaining;
            const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
            lines.push(`  📈 Tokens:   ${formatTokens(used)}/${formatTokens(limit)} ${makeBar(pct)} ${pct}%`);
          }
          if (rl.reset) {
            lines.push(`  🔄 5h 窗口重置: ${formatReset(rl.reset)}`);
          } else if (rl.tokensReset) {
            lines.push(`  🔄 窗口重置: ${rl.tokensReset}`);
          }
          lines.push(`  ⏱  数据时间: ${formatAge(rl.capturedAt)}`);
        } else {
          lines.push(codexUsageError ? `  📈 获取额度失败: ${codexUsageError}` : "  📈 使用后自动获取额度详情");
        }

        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── 响应拦截 ──

  pi.on("after_provider_response", async (event, ctx) => {
    const headers = event.headers;
    const provider = lastRequestProvider ?? ctx.model?.provider;

    // 被动捕获 rate limit headers（Claude 有，Codex 没有）
    if (headers && provider) {
      const info = parseAnthropicHeaders(headers) ?? parseOpenAIHeaders(headers);
      if (info) {
        rateLimits.set(provider, info);
        writeRateLimits(rateLimits);
      }
    }

    // 429/529 → 记录限额并切换模型
    if (event.status === 429 || event.status === 529) {
      const cooldownMs = parseCooldownMs(headers);

      if (provider) {
        setProviderRateLimit(provider, Date.now() + cooldownMs);
      }

      // 如果当前是 Claude 被限额，切到 Codex
      if (usingClaude && (provider === CLAUDE_PROVIDER || !provider)) {
        const ok = await setModelTo(pi, ctx, FALLBACK_PROVIDER, FALLBACK_MODEL, FALLBACK_THINKING);
        if (ok) {
          usingClaude = false;
          const minutes = Math.round(cooldownMs / 60000);
          ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("warning", `⚡ ${FALLBACK_MODEL}`));
          ctx.ui.notify(`Claude 限额，已切换到 ${FALLBACK_MODEL}，${minutes}min 后重试`, "warning");
        }
      }
    }
  });
}
