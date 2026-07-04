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

export function formatReset(reset: string | number): string {
  const seconds = Number(reset);
  if (Number.isFinite(seconds)) return new Date(seconds * 1000).toLocaleString();
  return String(reset);
}
