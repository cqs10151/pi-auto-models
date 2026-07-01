import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPassiveRateLimitCooldownMs } from './quota-utils.ts';

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

test('/usage shows visible loading while querying', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  assert.match(source, /pi\.registerCommand\("usage"/);
  assert.doesNotMatch(source, /pi\.registerCommand\("quota"/);
  assert.match(source, /ui\.setStatus\("auto-model-usage", .*查询额度中/);
  assert.match(source, /finally \{[\s\S]*ui\.setStatus\("auto-model-usage", undefined\);/);
  assert.match(source, /ui\.setWorkingVisible\(true\);[\s\S]*finally \{[\s\S]*ui\.setWorkingVisible\(true\);/);
  assert.doesNotMatch(source, /ui\.setWorkingVisible\(false\);/);
});

test('session start unhides the built-in working loader after reload', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  assert.match(source, /pi\.on\("session_start", async \(_event, ctx\) => \{\n\s+ctx\.ui\.setWorkingVisible\(true\);/);
});
