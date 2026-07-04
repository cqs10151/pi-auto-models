/**
 * Data layer: types, persistence (config/cache/auth/rate-limits),
 * Codex usage fetching, and rate-limit header parsing.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RateLimitInfo } from "./quota-utils.ts";

// ── Types ──

interface ProviderQuota {
  rateLimitExpiresAt: number; // ms timestamp
}

/** Rate-limit cache keyed by provider */
type QuotaCache = Record<string, ProviderQuota>;

export interface AuthEntry {
  type: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface CodexWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

export interface CodexUsage {
  plan_type?: string;
  rate_limit?: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window?: CodexWindow;
    secondary_window?: CodexWindow;
  };
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AutoModelConfig {
  primary?: { provider?: string; model?: string; thinking?: ThinkingLevel };
  fallback?: { provider?: string; model?: string; thinking?: ThinkingLevel };
}

// ── Constants ──

const CONFIG_FILE = join(getAgentDir(), "auto-model.json");
const AUTH_FILE = join(getAgentDir(), "auth.json");
const CACHE_FILE = join(getAgentDir(), "claude-quota-cache.json");
const RATE_LIMIT_FILE = join(getAgentDir(), "auto-model-rate-limits.json");

export const DEFAULT_PRIMARY_PROVIDER = "anthropic";
export const DEFAULT_PRIMARY_MODEL = "claude-opus-4-6";
export const DEFAULT_PRIMARY_THINKING: ThinkingLevel = "high";

export const DEFAULT_FALLBACK_PROVIDER = "openai-codex";
export const DEFAULT_FALLBACK_MODEL = "gpt-5.5";
export const DEFAULT_FALLBACK_THINKING: ThinkingLevel = "high";

// ── Config ──

export function readConfig(): AutoModelConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as AutoModelConfig;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: AutoModelConfig): void {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  } catch {}
}

// ── Cache helpers ──

function readCache(): QuotaCache {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    // Backward-compat with legacy format { rateLimitExpiresAt: number }
    if (typeof raw.rateLimitExpiresAt === "number") {
      return { [DEFAULT_PRIMARY_PROVIDER]: { rateLimitExpiresAt: raw.rateLimitExpiresAt } };
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
    // ponytail: if the write fails, just ignore it
  }
}

export function setProviderRateLimit(provider: string, expiresAt: number): void {
  const cache = readCache();
  cache[provider] = { rateLimitExpiresAt: expiresAt };
  writeCache(cache);
}

export function getProviderRateLimitLeft(provider: string): number {
  const cache = readCache();
  const entry = cache[provider];
  if (!entry) return 0;
  return Math.max(0, entry.rateLimitExpiresAt - Date.now());
}

// ── Auth helpers ──

export function readAuth(): Record<string, AuthEntry> {
  try {
    if (!existsSync(AUTH_FILE)) return {};
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function readRateLimits(): Record<string, RateLimitInfo> {
  try {
    if (!existsSync(RATE_LIMIT_FILE)) return {};
    return JSON.parse(readFileSync(RATE_LIMIT_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function writeRateLimits(rateLimits: Map<string, RateLimitInfo>): void {
  try {
    writeFileSync(RATE_LIMIT_FILE, JSON.stringify(Object.fromEntries(rateLimits), null, 2), "utf-8");
  } catch {}
}

// ── Codex usage ──

function extractCodexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

export async function fetchCodexUsage(entry: AuthEntry): Promise<CodexUsage | null> {
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

// ── Rate limit header parsers ──

export function parseAnthropicHeaders(headers: Record<string, string>): RateLimitInfo | null {
  const utilization = headers["anthropic-ratelimit-unified-5h-utilization"];
  if (utilization) {
    return {
      utilization,
      status: headers["anthropic-ratelimit-unified-5h-status"],
      reset: headers["anthropic-ratelimit-unified-5h-reset"],
      weeklyUtilization: headers["anthropic-ratelimit-unified-7d-utilization"],
      weeklyStatus: headers["anthropic-ratelimit-unified-7d-status"],
      weeklyReset: headers["anthropic-ratelimit-unified-7d-reset"],
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

export function parseOpenAIHeaders(headers: Record<string, string>): RateLimitInfo | null {
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
