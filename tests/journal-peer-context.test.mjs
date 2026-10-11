import test from 'node:test';
import assert from 'node:assert/strict';
import { indexMonthly, pointKey } from '../public/monthly.js';
import { createJournalPeerContext } from '../public/journal-peer-context.js';

const months = Array.from({ length: 16 }, (_, index) => ({ y: 2025 + Math.floor(index / 12), m: index % 12 }));
const row = (account, value = 40, tp = 'ТП-1', point = 'P1') => ({ account, accountKey: account, tp, point, values: [...Array(15).fill(100), value] });
const item = (point = 'P1', comparison = 'previous') => ({ account: '001', point: { key: pointKey({ point }) }, month: '2026-04', comparisons: { [comparison]: { available: true, value: 100, dropPercent: 60 } } });
const annotate = rows => createJournalPeerContext(indexMonthly({ rows, months, warnings: [] }));

test('TP context excludes the whole current account, aggregates tariffs and never mixes another TP', () => {
  const own = row('001'), rows = [own, row('001', 40, 'ТП-1', 'P2'), ...Array.from({ length: 6 }, (_, index) => row(String(index + 2))), ...Array.from({ length: 20 }, (_, index) => row('x' + index, 100, 'ТП-2'))];
  const result = annotate(rows)(item(), [own]);
  assert.equal(result.peerContext.eligiblePeers, 6); assert.equal(result.peerContext.declinedPeers, 6);
  assert.equal(result.peerContext.sharePercent, 100); assert.equal(result.peerContext.commonDecline, true);
  assert.match(result.peerContext.detail, /других ЛС/);
});

test('partial and negative peers are excluded, and a small group cannot imply a common decline', () => {
  const own = row('001'), rows = [own, ...Array.from({ length: 5 }, (_, index) => row(String(index + 2))), row('008', null), row('009', -10)];
  rows.push({ ...row('2', 5, 'ТП-1', 'P2'), values: [...Array(15).fill(10), null] });
  const result = annotate(rows)(item(), [own]).peerContext;
  assert.equal(result.available, false); assert.equal(result.eligiblePeers, 4); assert.equal(result.commonDecline, false);
});

test('comparison uses the exact prior year month and requires six other eligible accounts', () => {
  const own = row('001');
  const rows = [own, ...Array.from({ length: 6 }, (_, index) => { const peer = row(String(index + 2)); peer.values[14] = 20; return peer; })];
  const result = annotate(rows)(item('P1', 'yearAgo'), [own]).peerContext;
  assert.equal(result.comparison, 'yearAgo'); assert.equal(result.declinedPeers, 6); assert.equal(result.commonDecline, true);
  assert.match(result.detail, /прошлого года/);
});

test('grouped case months keep their own context and do not treat a missing TP as the RES', () => {
  const own = row('001'), rows = [own, ...Array.from({ length: 6 }, (_, index) => row(String(index + 2)))];
  const grouped = { ...item(), months: [{ month: '2026-03', comparisons: { previous: { available: true, value: 100, dropPercent: 60 } } }, { month: '2026-04', comparisons: item().comparisons }] };
  const result = annotate(rows)(grouped, [own]);
  assert.equal(result.months[0].peerContext.commonDecline, false); assert.equal(result.months[1].peerContext.commonDecline, true);
  const missing = annotate(rows)(item(), [{ ...own, tp: '' }]);
  assert.equal(missing.peerContext.available, false); assert.match(missing.peerContext.reason, /единственная ТП/);
});

test('a minority fall, zero baseline and calendar holes never produce a common TP decline', () => {
  const own = row('001'), peers = Array.from({ length: 6 }, (_, index) => row(String(index + 2), index < 3 ? 40 : 100));
  const context = annotate([own, ...peers])(item(), [own]).peerContext;
  assert.equal(context.commonDecline, false); assert.equal(context.sharePercent, 50);
  for (const peer of peers) peer.values[14] = 0;
  assert.equal(annotate([own, ...peers])(item(), [own]).peerContext.available, false);
  const model = indexMonthly({ rows: [own, ...peers], months, warnings: [] });
  model.months = model.months.filter(month => !(month.y === 2026 && month.m === 2));
  assert.equal(createJournalPeerContext(model)(item(), [own]).peerContext.available, false);
});
