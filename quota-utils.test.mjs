import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPassiveRateLimitCooldownMs, isProviderRateLimitError, isRateLimitInfoStale, parseCooldownMs } from './quota-utils.ts';

test('avoids Claude when passive 5h utilization is effectively exhausted', () => {
  const now = 1_700_000_000_000;
  const resetSeconds = now / 1000 + 60;

  assert.equal(
    getPassiveRateLimitCooldownMs({ utilization: '0.99', status: 'allowed_warning', reset: String(resetSeconds) }, now),
    60_000,
  );
});

test('does not avoid Claude for lower passive utilization warnings', () => {
  assert.equal(getPassiveRateLimitCooldownMs({ utilization: '0.98', status: 'allowed_warning' }, 1_700_000_000_000), 0);
});

test('treats passive rate limit data older than its window as stale', () => {
  const now = 1_700_000_000_000;

  assert.equal(isRateLimitInfoStale({ capturedAt: now - 5 * 60 * 60 * 1000 - 1 }, now), true);
  assert.equal(isRateLimitInfoStale({ capturedAt: now - 60_000 }, now), false);
});

test('/usage hides stale passive Claude quota snapshots', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  assert.match(source, /isRateLimitInfoStale/);
  assert.match(source, /Quota unknown/);
  assert.match(source, /Stale data/);
});

test('falls back when 429 reset header is already stale', () => {
  const now = 1_700_000_000_000;

  assert.equal(parseCooldownMs({ 'anthropic-ratelimit-unified-5h-reset': String(now / 1000 - 60) }, now, 1234), 1234);
});

test('detects provider rate limit errors without response headers', () => {
  assert.equal(isProviderRateLimitError('429 {"error":{"type":"rate_limit_error"}}'), true);
  assert.equal(isProviderRateLimitError('Retry failed after 2 attempts: Retry cancelled'), false);
});

test('message_end caches Anthropic 429 errors when headers are unavailable', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  assert.match(source, /pi\.on\("message_end"/);
  assert.match(source, /isProviderRateLimitError/);
});

test('message_end does not invent a reset time when headers are unavailable', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  assert.match(source, /existingReset/);
  assert.doesNotMatch(source, /reset: String\(Math\.ceil\(\(Date\.now\(\) \+ cooldownMs\)/);
});

test('/usage shows visible loading while querying', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  assert.match(source, /pi\.registerCommand\("usage"/);
  assert.doesNotMatch(source, /pi\.registerCommand\("quota"/);
  assert.match(source, /ui\.setStatus\("auto-model-usage", .*Checking quota/);
  assert.match(source, /finally \{[\s\S]*ui\.setStatus\("auto-model-usage", undefined\);/);
  assert.match(source, /ui\.setWorkingVisible\(true\);[\s\S]*finally \{[\s\S]*ui\.setWorkingVisible\(true\);/);
  assert.doesNotMatch(source, /ui\.setWorkingVisible\(false\);/);
});

test('session start unhides the built-in working loader after reload', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  assert.match(source, /pi\.on\("session_start", async \(_event, ctx\) => \{\n\s+ctx\.ui\.setWorkingVisible\(true\);/);
});

test('formatWindowLabel labels windows by real duration, not position', async () => {
  const { formatWindowLabel } = await import('./format.ts');
  assert.equal(formatWindowLabel(5 * 3600), '5h');
  assert.equal(formatWindowLabel(7 * 24 * 3600), 'Weekly');
  assert.equal(formatWindowLabel(30 * 24 * 3600), '30d');
});

test('/usage renders whatever Codex windows exist even without a 5h window', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(source, /codexWindows/);
  assert.doesNotMatch(source, /codexPrimary/);
});

test('Codex usage shows no 5h activity and labels long-reset window as weekly', async () => {
  const format = await import('./format.ts');
  const lines = format.formatCodexUsageLines?.([
    {
      used_percent: 13,
      limit_window_seconds: 5 * 3600,
      reset_after_seconds: 6 * 24 * 3600,
      reset_at: 1784523154,
    },
  ], 'pro');

  assert.deepEqual(lines?.slice(0, 2), [
    '  📈 5h quota: No 5h activity',
    '  📈 Weekly quota: [███░░░░░░░░░░░░░░░░░] 13% (pro)',
  ]);
  assert.match(lines?.[2] ?? '', /^  🔄 Weekly window reset: /);
});
