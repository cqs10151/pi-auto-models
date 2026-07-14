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
  return String(reset);
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

export function formatCodexUsageLines(windows: CodexWindowLike[], planType?: string): string[] {
  const labeled = windows.map((w) => ({ w, label: formatCodexWindowLabel(w) }));
  const lines: string[] = [];
  if (labeled.length > 0 && !labeled.some(({ label }) => label === "5h")) {
    lines.push("  📈 5h quota: No 5h activity");
  }
  labeled.forEach(({ w, label }, i) => {
    const pct = Math.round(w.used_percent);
    const plan = i === 0 && planType ? ` (${planType})` : "";
    lines.push(`  📈 ${label} quota: ${makeBar(pct)} ${pct}%${plan}`);
  });
  for (const { w, label } of labeled) {
    lines.push(`  🔄 ${label} window reset: ${formatReset(w.reset_at)}`);
  }
  return lines;
}
