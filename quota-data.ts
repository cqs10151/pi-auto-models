/**
 * Data layer: types, persistence (config/cache/auth/rate-limits),
 * Claude usage fetching, and rate-limit header parsing.
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

export interface ClaudeLimit {
  kind?: string;
  percent?: number;
  severity?: string;
  resets_at?: string;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

export interface ClaudeUsage {
  limits?: ClaudeLimit[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelSlot {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface AutoModelConfig {
  models?: ModelSlot[];
  // Compatibility fields
  primary?: ModelSlot;
  fallback?: ModelSlot;
}

// ── Constants ──

const CONFIG_FILE = join(getAgentDir(), "auto-model.json");
const AUTH_FILE = join(getAgentDir(), "auth.json");
const CACHE_FILE = join(getAgentDir(), "claude-quota-cache.json");
const RATE_LIMIT_FILE = join(getAgentDir(), "auto-model-rate-limits.json");

// 默认 4 个降级模型梯队
export const DEFAULT_MODELS: ModelSlot[] = [
  { provider: "anthropic", model: "claude-opus-4-6", thinking: "high" },
  { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
  { provider: "openrouter", model: "google/gemma-4-31b-it:free", thinking: "off" },
  { provider: "openrouter", model: "openai/gpt-oss-20b:free", thinking: "off" },
];

// ── Config ──

export function readConfig(): ModelSlot[] {
  try {
    if (!existsSync(CONFIG_FILE)) return DEFAULT_MODELS;
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as AutoModelConfig;
    if (Array.isArray(cfg.models) && cfg.models.length > 0) {
      return cfg.models;
    }
    // Backward compatibility for primary & fallback format
    if (cfg.primary && cfg.fallback) {
      return [
        { provider: cfg.primary.provider ?? DEFAULT_MODELS[0].provider, model: cfg.primary.model ?? DEFAULT_MODELS[0].model, thinking: cfg.primary.thinking ?? "high" },
        { provider: cfg.fallback.provider ?? DEFAULT_MODELS[1].provider, model: cfg.fallback.model ?? DEFAULT_MODELS[1].model, thinking: cfg.fallback.thinking ?? "high" },
        DEFAULT_MODELS[2],
        DEFAULT_MODELS[3],
      ];
    }
    return DEFAULT_MODELS;
  } catch {
    return DEFAULT_MODELS;
  }
}

export function writeConfig(models: ModelSlot[]): void {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ models }, null, 2), "utf-8");
  } catch {}
}

// ── Cache helpers ──

function readCache(): QuotaCache {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (typeof raw.rateLimitExpiresAt === "number") {
      return { [DEFAULT_MODELS[0].provider]: { rateLimitExpiresAt: raw.rateLimitExpiresAt } };
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
  } catch {}
}

export function setProviderRateLimit(provider: string, expiresAt: number): void {
  const cache = readCache();
  cache[provider] = { rateLimitExpiresAt: expiresAt };
  writeCache(cache);
}

export function clearProviderRateLimit(provider: string): void {
  const cache = readCache();
  delete cache[provider];
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

export async function fetchClaudeUsage(entry: AuthEntry): Promise<ClaudeUsage | null> {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${entry.access}`,
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Claude usage HTTP ${res.status}`);
  return (await res.json()) as ClaudeUsage;
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