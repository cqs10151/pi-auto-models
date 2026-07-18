/**
 * Pure display formatting helpers for the /usage output.
 */

export function formatTimeLeft(ms: number): string {
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

export function formatAge(capturedAt: number): string {
  const sec = Math.round((Date.now() - capturedAt) / 1000);
  if (sec < 60) return `${sec}s ago`;
  return `${Math.round(sec / 60)}min ago`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function makeBar(pct: number): string {
  const safePct = Math.max(0, Math.min(100, pct));
  const filled = Math.round(safePct / 5);
  return "[" + "█".repeat(filled) + "░".repeat(20 - filled) + "]";
}

/** Label a Codex quota window by its actual duration (OpenAI may drop/rename windows). */
export function formatWindowLabel(limitWindowSeconds: number): string {
  const hours = limitWindowSeconds / 3600;
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return days === 7 ? "Weekly" : `${days}d`;
  }
  return `${Math.round(hours)}h`;
}

export function formatReset(reset: string | number): string {
  const seconds = Number(reset);
  if (Number.isFinite(seconds)) return new Date(seconds * 1000).toLocaleString();
  const d = new Date(reset);
  return Number.isNaN(d.getTime()) ? String(reset) : d.toLocaleString();
}

function formatShortReset(reset: string | number): string {
  const seconds = Number(reset);
  const d = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(reset);
  if (Number.isNaN(d.getTime())) return String(reset);
  return d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface QuotaRow {
  label: string;
  pct: number;
  note?: string;
  reset?: string | number;
}

/** One aligned line per quota: label, bar, right-aligned pct, inline reset. */
function renderQuotaRows(rows: QuotaRow[]): string[] {
  const width = Math.max(...rows.map((r) => r.label.length));
  return rows.map(
    (r) =>
      `  📈 ${r.label.padEnd(width)} ${makeBar(r.pct)} ${String(r.pct).padStart(3)}%` +
      (r.note ? ` (${r.note})` : "") +
      (r.reset !== undefined ? ` · resets ${formatShortReset(r.reset)}` : ""),
  );
}

interface ClaudeLimitLike {
  kind?: string;
  percent?: number;
  severity?: string;
  resets_at?: string;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

function claudeLimitLabel(l: ClaudeLimitLike): string {
  if (l.kind === "session") return "5h";
  if (l.kind === "weekly_all") return "Weekly";
  if (l.kind === "weekly_scoped") return `${l.scope?.model?.display_name ?? "Scoped"} weekly`;
  return l.kind ?? "?";
}

/** Render the Anthropic OAuth usage `limits` array (session / weekly / scoped e.g. Fable). */
export function formatClaudeUsageLines(limits: ClaudeLimitLike[]): string[] {
  return renderQuotaRows(
    limits.map((l) => ({
      label: claudeLimitLabel(l),
      pct: Math.round(l.percent ?? 0), // ponytail: percent is 0-100 per observed API response
      note: l.severity && l.severity !== "normal" ? l.severity : undefined,
      reset: l.resets_at,
    })),
  );
}

/** Render passively captured rate-limit headers (Claude / OpenAI API) in the same aligned style. */
export function formatPassiveRateLimitLines(rl: {
  utilization?: string;
  status?: string;
  reset?: string;
  weeklyUtilization?: string;
  weeklyStatus?: string;
  weeklyReset?: string;
  requestsLimit?: string;
  requestsRemaining?: string;
  tokensLimit?: string;
  tokensRemaining?: string;
  tokensReset?: string;
}): string[] {
  const rows: QuotaRow[] = [];
  if (rl.utilization) {
    rows.push({
      label: "5h",
      pct: Math.round(Number(rl.utilization) * 100),
      note: rl.status && rl.status !== "allowed" ? rl.status : undefined,
      reset: rl.reset,
    });
  }
  if (rl.weeklyUtilization) {
    rows.push({
      label: "Weekly",
      pct: Math.round(Number(rl.weeklyUtilization) * 100),
      note: rl.weeklyStatus && rl.weeklyStatus !== "allowed" ? rl.weeklyStatus : undefined,
      reset: rl.weeklyReset,
    });
  }
  if (rl.requestsLimit && rl.requestsRemaining) {
    const limit = Number(rl.requestsLimit);
    const used = limit - Number(rl.requestsRemaining);
    rows.push({
      label: "Requests",
      pct: limit > 0 ? Math.round((used / limit) * 100) : 0,
      note: `${used}/${limit}`,
    });
  }
  if (rl.tokensLimit && rl.tokensRemaining) {
    const limit = Number(rl.tokensLimit);
    const used = limit - Number(rl.tokensRemaining);
    rows.push({
      label: "Tokens",
      pct: limit > 0 ? Math.round((used / limit) * 100) : 0,
      note: `${formatTokens(used)}/${formatTokens(limit)}`,
      reset: !rl.reset && !rl.weeklyReset ? rl.tokensReset : undefined,
    });
  }
  return rows.length > 0 ? renderQuotaRows(rows) : [];
}

interface CodexWindowLike {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

function formatCodexWindowLabel(w: CodexWindowLike): string {
  // Codex may report the old 5h duration even when only the weekly window is active.
  return w.reset_after_seconds > 24 * 3600 ? "Weekly" : formatWindowLabel(w.limit_window_seconds);
}

export interface CodexExtraLimitLike {
  limit_name?: string;
  metered_feature?: string;
  rate_limit?: { primary_window?: CodexWindowLike; secondary_window?: CodexWindowLike };
}

export function formatCodexUsageLines(
  windows: CodexWindowLike[],
  planType?: string,
  extras: CodexExtraLimitLike[] = [],
): string[] {
  const labeled = windows.map((w) => ({ w, label: formatCodexWindowLabel(w) }));
  const rows: QuotaRow[] = labeled.map(({ w, label }, i) => ({
    label,
    pct: Math.round(w.used_percent),
    note: i === 0 && planType ? planType : undefined,
    reset: w.reset_at,
  }));
  for (const extra of extras) {
    // "GPT-5.3-Codex-Spark" → "Spark"
    const name = (extra.limit_name || extra.metered_feature || "extra").split("-").pop()!;
    const extraWindows = [extra.rate_limit?.primary_window, extra.rate_limit?.secondary_window].filter(
      (w): w is CodexWindowLike => !!w,
    );
    for (const w of extraWindows) {
      rows.push({
        label: `${name} ${formatCodexWindowLabel(w).toLowerCase()}`,
        pct: Math.round(w.used_percent),
        reset: w.reset_at,
      });
    }
  }
  const lines = rows.length > 0 ? renderQuotaRows(rows) : [];
  if (labeled.length > 0 && !labeled.some(({ label }) => label === "5h")) {
    lines.unshift("  📈 5h: no recent activity");
  }
  return lines;
}
