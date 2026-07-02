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
 * /usage 命令查看各 provider 的 5h 额度使用情况。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, SelectList, type SelectItem, matchesKey, Key } from "@earendil-works/pi-tui";
import { getPassiveRateLimitCooldownMs, isProviderRateLimitError, isRateLimitInfoStale, parseCooldownMs, type RateLimitInfo } from "./quota-utils.ts";

// ── Types ──

interface ProviderQuota {
  rateLimitExpiresAt: number; // ms timestamp
}

/** 按 provider 存储限额缓存 */
type QuotaCache = Record<string, ProviderQuota>;

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

// ── Config ──

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface AutoModelConfig {
  primary?: { provider?: string; model?: string; thinking?: ThinkingLevel };
  fallback?: { provider?: string; model?: string; thinking?: ThinkingLevel };
}

const CONFIG_FILE = join(getAgentDir(), "auto-model.json");

function readConfig(): AutoModelConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as AutoModelConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: AutoModelConfig): void {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  } catch {}
}

// ── Constants ──

const AUTH_FILE = join(getAgentDir(), "auth.json");
const CACHE_FILE = join(getAgentDir(), "claude-quota-cache.json");
const RATE_LIMIT_FILE = join(getAgentDir(), "auto-model-rate-limits.json");
const DEFAULT_PRIMARY_PROVIDER = "anthropic";
const DEFAULT_PRIMARY_MODEL = "claude-opus-4-6";
const DEFAULT_PRIMARY_THINKING: ThinkingLevel = "high";

const DEFAULT_FALLBACK_PROVIDER = "openai-codex";
const DEFAULT_FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_FALLBACK_THINKING: ThinkingLevel = "high";

// ── Cache helpers ──

function readCache(): QuotaCache {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    // 兼容旧格式 { rateLimitExpiresAt: number }
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
    // ponytail: 写不了就算了
  }
}

function setProviderRateLimit(provider: string, expiresAt: number): void {
  const cache = readCache();
  cache[provider] = { rateLimitExpiresAt: expiresAt };
  writeCache(cache);
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

// ── Extension ──

export default function (pi: ExtensionAPI) {
  const cfg = readConfig();
  let CLAUDE_PROVIDER = cfg.primary?.provider ?? DEFAULT_PRIMARY_PROVIDER;
  let CLAUDE_MODEL = cfg.primary?.model ?? DEFAULT_PRIMARY_MODEL;
  let CLAUDE_THINKING: ThinkingLevel = cfg.primary?.thinking ?? DEFAULT_PRIMARY_THINKING;
  let FALLBACK_PROVIDER = cfg.fallback?.provider ?? DEFAULT_FALLBACK_PROVIDER;
  let FALLBACK_MODEL = cfg.fallback?.model ?? DEFAULT_FALLBACK_MODEL;
  let FALLBACK_THINKING: ThinkingLevel = cfg.fallback?.thinking ?? DEFAULT_FALLBACK_THINKING;

  let usingClaude = false;
  let lastRequestProvider: string | undefined;
  const rateLimits = new Map<string, RateLimitInfo>(Object.entries(readRateLimits()));

  pi.on("before_provider_request", (event, ctx) => {
    lastRequestProvider = event.model?.provider ?? ctx.model?.provider ?? lastRequestProvider;
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWorkingVisible(true);
    const claudeCooldownMs = Math.max(
      getProviderRateLimitLeft(CLAUDE_PROVIDER),
      getPassiveRateLimitCooldownMs(rateLimits.get(CLAUDE_PROVIDER)),
    );
    if (claudeCooldownMs > 0) {
      setProviderRateLimit(CLAUDE_PROVIDER, Date.now() + claudeCooldownMs);
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

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!isProviderRateLimitError(event.message.errorMessage)) return;
    const provider = event.message.provider ?? lastRequestProvider ?? ctx.model?.provider;
    if (!provider) return;

    const cooldownMs = parseCooldownMs(undefined);
    setProviderRateLimit(provider, Date.now() + cooldownMs);
    rateLimits.set(provider, {
      utilization: "1",
      status: "rate_limited",
      reset: String(Math.ceil((Date.now() + cooldownMs) / 1000)),
      capturedAt: Date.now(),
    });
    writeRateLimits(rateLimits);

    if (usingClaude && provider === CLAUDE_PROVIDER) {
      const ok = await setModelTo(pi, ctx, FALLBACK_PROVIDER, FALLBACK_MODEL, FALLBACK_THINKING);
      if (ok) {
        usingClaude = false;
        ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("warning", `⚡ ${FALLBACK_MODEL}`));
        ctx.ui.notify(`Claude 限额，已切换到 ${FALLBACK_MODEL}`, "warning");
      }
    }
  });

  // ── /usage 命令 ──

  pi.registerCommand("usage", {
    description: "显示 Claude / Codex 5h 额度使用情况",
    handler: async (_args, ctx) => {
      // ponytail: 跨 await 不再读 ctx，避免 reload 后 stale；只捕获 UI 对象
      const ui = ctx.ui;
      ui.setWorkingMessage("查询额度中…");
      ui.setWorkingVisible(true);
      ui.setStatus("auto-model-usage", ui.theme.fg("warning", "⏳ 查询额度中…"));
      try {
        const auth = readAuth();
        const lines: string[] = [];

      for (const [provider, label] of [
        [CLAUDE_PROVIDER, `Primary (${CLAUDE_MODEL})`],
        [FALLBACK_PROVIDER, `Fallback (${FALLBACK_MODEL})`],
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
        const passiveLeft = getPassiveRateLimitCooldownMs(rateLimits.get(provider));
        if (passiveLeft > 0) setProviderRateLimit(provider, Date.now() + passiveLeft);
        const left = Math.max(getProviderRateLimitLeft(provider), passiveLeft);
        const rl = rateLimits.get(provider);
        const stale = isRateLimitInfoStale(rl);
        if (codexUsage?.rate_limit?.limit_reached && codexPrimary) {
          lines.push(`  📊 ❌ 限额中，${formatTimeLeft(codexPrimary.reset_after_seconds * 1000)} 后恢复`);
          setProviderRateLimit(provider, codexPrimary.reset_at * 1000);
        } else if (codexUsage?.rate_limit?.allowed) {
          lines.push("  📊 ✅ 额度可用");
        } else if (left > 0) {
          lines.push(`  📊 ❌ 限额中，${formatTimeLeft(left)} 后恢复`);
        } else if (stale || (provider === CLAUDE_PROVIDER && !rl)) {
          lines.push("  📊 额度未知");
        } else {
          lines.push("  📊 ✅ 额度可用");
        }

        // Codex 有主动实时 endpoint
        if (codexPrimary) {
          const codexSecondary = codexUsage?.rate_limit?.secondary_window;
          const pct = Math.round(codexPrimary.used_percent);
          lines.push(`  📈 5h 额度: ${makeBar(pct)} ${pct}%${codexUsage?.plan_type ? ` (${codexUsage.plan_type})` : ""}`);
          if (codexSecondary) {
            const wPct = Math.round(codexSecondary.used_percent);
            lines.push(`  📈 周额度:  ${makeBar(wPct)} ${wPct}%`);
          }
          lines.push(`  🔄 5h 窗口重置: ${formatReset(codexPrimary.reset_at)}`);
          if (codexSecondary) {
            lines.push(`  🔄 周窗口重置: ${formatReset(codexSecondary.reset_at)}`);
          }
          lines.push(`  ⏰ 实时查询`);
          lines.push("");
          continue;
        }

        // Claude 从响应 headers 被动捕获
        if (stale) {
          lines.push("  📈 旧数据已过期，使用后自动获取额度详情");
        } else if (rl) {
          if (rl.utilization) {
            const pct = Math.round(Number(rl.utilization) * 100);
            lines.push(`  📈 5h 额度: ${makeBar(pct)} ${pct}%${rl.status ? ` (${rl.status})` : ""}`);
          }
          if (rl.weeklyUtilization) {
            const pct = Math.round(Number(rl.weeklyUtilization) * 100);
            lines.push(`  📈 周额度:  ${makeBar(pct)} ${pct}%${rl.weeklyStatus ? ` (${rl.weeklyStatus})` : ""}`);
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
          }
          if (rl.weeklyReset) {
            lines.push(`  🔄 周窗口重置: ${formatReset(rl.weeklyReset)}`);
          }
          if (!rl.reset && !rl.weeklyReset && rl.tokensReset) {
            lines.push(`  🔄 窗口重置: ${rl.tokensReset}`);
          }
          lines.push(`  ⏰ 数据时间: ${formatAge(rl.capturedAt ?? Date.now())}`);
        } else {
          lines.push(codexUsageError ? `  📈 获取额度失败: ${codexUsageError}` : "  📈 使用后自动获取额度详情");
        }

        lines.push("");
      }

        ui.notify(lines.join("\n"), "info");
      } finally {
        ui.setWorkingVisible(true);
        ui.setWorkingMessage(undefined);
        ui.setStatus("auto-model-usage", undefined);
      }
    },
  });

  // ── /auto-model 配置命令 ──

  pi.registerCommand("auto-model", {
    description: "配置默认模型和回退模型",
    handler: async (_args, ctx) => {
      const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
      const availableModels = ctx.modelRegistry.getAvailable();
      const modelItems: SelectItem[] = availableModels.map((m: { provider: string; id: string }) => ({
        value: `${m.provider}/${m.id}`,
        label: `${m.provider}/${m.id}`,
      }));

      // 选 slot
      const slot = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("配置 Auto Model")), 1, 0));
        container.addChild(new Text(theme.fg("muted", `Primary: ${CLAUDE_PROVIDER}/${CLAUDE_MODEL} (${CLAUDE_THINKING})`), 1, 0));
        container.addChild(new Text(theme.fg("muted", `Fallback: ${FALLBACK_PROVIDER}/${FALLBACK_MODEL} (${FALLBACK_THINKING})`), 1, 0));
        const items: SelectItem[] = [
          { value: "primary", label: "Primary 模型", description: `${CLAUDE_PROVIDER}/${CLAUDE_MODEL}` },
          { value: "fallback", label: "Fallback 模型", description: `${FALLBACK_PROVIDER}/${FALLBACK_MODEL}` },
        ];
        const list = new SelectList(items, 4, {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ 选择 • enter 确认 • esc 取消"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
        };
      });
      if (!slot) return;

      // 选模型（fzf 模糊搜索）
      const model = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        let filter = "";

        // ponytail: fzf-style 模糊匹配，按字符顺序匹配，不要求连续
        const fzfMatch = (text: string, pattern: string): number => {
          if (!pattern) return 1;
          const lower = text.toLowerCase();
          const p = pattern.toLowerCase();
          let j = 0;
          for (let i = 0; i < lower.length && j < p.length; i++) {
            if (lower[i] === p[j]) j++;
          }
          return j === p.length ? 1 : 0;
        };

        const rebuildList = () => {
          const filtered = filter
            ? modelItems.filter((item) => fzfMatch(item.label, filter))
            : modelItems;
          // 重建 SelectList
          container.removeChild(list);
          container.removeChild(helpText);
          container.removeChild(bottomBorder);
          list = new SelectList(filtered, Math.min(filtered.length, 12), selectTheme);
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(helpText);
          container.addChild(bottomBorder);
          container.invalidate();
        };

        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        const titleText = new Text("", 1, 0);
        const updateTitle = () => {
          const label = slot === "primary" ? "Primary" : "Fallback";
          const searchHint = filter ? theme.fg("accent", ` ❯ ${filter}`) : theme.fg("dim", " (输入搜索)");
          titleText.setText(theme.fg("accent", theme.bold(`选择 ${label} 模型`)) + searchHint);
        };
        updateTitle();
        container.addChild(titleText);
        const selectTheme = {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        };
        let list = new SelectList(modelItems, Math.min(modelItems.length, 12), selectTheme);
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        const helpText = new Text(theme.fg("dim", "↑↓ 选择 • 输入搜索 • enter 确认 • esc 取消"), 1, 0);
        container.addChild(helpText);
        const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(bottomBorder);
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            if (matchesKey(data, Key.backspace)) {
              if (filter.length > 0) {
                filter = filter.slice(0, -1);
                updateTitle();
                rebuildList();
              }
            } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
              filter += data;
              updateTitle();
              rebuildList();
            } else {
              list.handleInput(data);
            }
            tui.requestRender();
          },
        };
      });
      if (!model) return;

      // 选 thinking level
      const thinkingItems: SelectItem[] = THINKING_LEVELS.map((l) => ({ value: l, label: l }));
      const thinking = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("选择 Thinking Level")), 1, 0));
        const list = new SelectList(thinkingItems, 6, {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ 选择 • enter 确认 • esc 取消"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
        };
      });
      if (!thinking) return;

      const [provider, ...rest] = model.split("/");
      const modelId = rest.join("/");
      const thinkingLevel = thinking as ThinkingLevel;

      // 更新运行时变量
      if (slot === "primary") {
        CLAUDE_PROVIDER = provider;
        CLAUDE_MODEL = modelId;
        CLAUDE_THINKING = thinkingLevel;
      } else {
        FALLBACK_PROVIDER = provider;
        FALLBACK_MODEL = modelId;
        FALLBACK_THINKING = thinkingLevel;
      }

      // 持久化
      const newCfg = readConfig();
      newCfg[slot as "primary" | "fallback"] = { provider, model: modelId, thinking: thinkingLevel };
      writeConfig(newCfg);

      ctx.ui.notify(`${slot === "primary" ? "Primary" : "Fallback"} 已设置为 ${model} (${thinkingLevel})`, "info");
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
        const passiveLeft = getPassiveRateLimitCooldownMs(info);
        if (passiveLeft > 0) setProviderRateLimit(provider, Date.now() + passiveLeft);
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
