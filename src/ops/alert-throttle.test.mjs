import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlertThrottle } from './alert-throttle.mjs';

test('createAlertThrottle limits each alert category independently', () => {
  let current = 1_000;
  const throttle = createAlertThrottle({ windowMs: 10_000, now: () => current });
  assert.equal(throttle.allow('runtime'), true);
  assert.equal(throttle.allow('runtime'), false);
  assert.equal(throttle.allow('maintenance'), true);
  current += 10_001;
  assert.equal(throttle.allow('runtime'), true);
});

test('createAlertThrottle bounds stored keys and rejects empty keys', () => {
  const throttle = createAlertThrottle({ maxKeys: 10 });
  assert.equal(throttle.allow(''), false);
  for (let index = 0; index < 20; index += 1) assert.equal(throttle.allow('alert-' + index), true);
  assert.equal(throttle.allow('alert-19'), false);
});
