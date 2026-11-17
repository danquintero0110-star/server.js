import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessOf, isBillable, GRACE_DAYS } from '../src/lib/billing.js';

const NOW = Date.parse('2026-12-10T15:00:00Z');

test('sin fecha de pago no vence (familia)', () => {
  assert.equal(accessOf({ paid_until: '' }, NOW).state, 'ok');
});

test('avisa 3 días antes, gracia después de vencer y luego bloquea', () => {
  assert.equal(accessOf({ paid_until: '2026-12-31' }, NOW).message, undefined);
  assert.match(accessOf({ paid_until: '2026-12-12' }, NOW).message, /vence en 2 días/);
  const g = accessOf({ paid_until: '2026-12-08' }, NOW);
  assert.equal(g.state, 'grace');
  assert.equal(GRACE_DAYS, 5);
  assert.equal(accessOf({ paid_until: '2026-12-05' }, NOW).state, 'grace'); // día 5 de gracia
  assert.equal(accessOf({ paid_until: '2026-12-04' }, NOW).state, 'blocked');
});

test('pausa manual y administradores', () => {
  assert.equal(accessOf({ status: 'suspended' }, NOW).state, 'blocked');
  assert.equal(accessOf({ status: 'suspended', is_admin: 1, paid_until: '2020-01-01' }, NOW).state, 'ok');
});

test('solo se frenan funciones que cuestan', () => {
  assert.ok(isBillable('POST', '/api/notes'));
  assert.ok(isBillable('POST', '/api/notes/:id/chat'));
  assert.ok(isBillable('GET', '/api/notes/:id/export.pdf'));
  assert.ok(!isBillable('GET', '/api/notes/:id'));
  assert.ok(!isBillable('GET', '/api/notes/:id/audio'));
  assert.ok(!isBillable('GET', '/api/notes/:id/whatsapp'));
  assert.ok(!isBillable('DELETE', '/api/notes/:id'));
});
