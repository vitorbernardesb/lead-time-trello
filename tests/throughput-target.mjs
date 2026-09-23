import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { monthlyThroughputTarget, conclusionDayKey, selectCompletedCards } from '../js/throughput.js';
import { DEFAULTS, PRODUCAO_ATIVA } from '../js/config.js';

const at = day => new Date(day + 'T15:00:00Z');
const target = day => monthlyThroughputTarget(150, at(day));
assert.deepEqual(target('2026-09-23'), {expected: 150 * 17 / 22, elapsedBusinessDays: 17, totalBusinessDays: 22});
assert.equal(target('2026-09-01').expected, 150 / 22);
assert.equal(target('2026-09-30').expected, 150);
assert.equal(target('2026-09-19').expected, target('2026-09-18').expected);
assert.equal(target('2026-09-20').expected, target('2026-09-18').expected);
assert.equal(target('2026-08-01').expected, 0);
assert.equal(target('2026-08-02').expected, 0);
assert.equal(target('2026-08-31').expected, 150);
assert.equal(target('2024-02-29').expected, 150); // leap year
assert.equal(target('2026-10-01').elapsedBusinessDays, 1); // month reset
assert.deepEqual(monthlyThroughputTarget(150, new Date('2026-10-01T01:00:00Z')), target('2026-09-30'));

// Exercise the actual dashboard calculation and all presentation consumers.
const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const functions = ['calcKPIs', 'kpiHealth', 'buildKpiCards', 'kpiCardScore', 'healthBreakdown'].map(name => {
  const start = html.indexOf('  function ' + name + '(');
  assert.ok(start >= 0);
  return html.slice(start, html.indexOf('\n  }', start) + 4);
}).join('\n');
function calculate(day, count) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [at(day)])); }
    static now() { return +at(day); }
  }
  const config = {...DEFAULTS, meta_through: 150, peso1: 0, peso2: 0, peso3: 0, peso4: 100, peso5: 0, peso6: 0};
  const context = vm.createContext({Date: Clock, config, PRODUCAO_ATIVA, ignoredIndicatorIds: new Set(),
    monthlyThroughputTarget: meta => monthlyThroughputTarget(meta, at(day)), conclusionDayKey, selectCompletedCards,
    round1: n => Math.round(n * 10) / 10, kpi2DisplayMode: 'abs',
    cards: Array.from({length: count}, (_,i) => ({id: String(i), currentListName: 'Concluído 🏆',
      concludedAt: at(day).toISOString(), isConcluido: true, retrabalho: 0, leadTimeReal: 1}))});
  vm.runInContext(functions + '\nvar result = calcKPIs(cards, config); var tile = buildKpiCards(result, config)[4]; var breakdown = healthBreakdown(result, config);', context);
  assert.equal(context.tile.scoreOverride, context.result.score_through);
  assert.equal(context.breakdown.find(x => x.name === 'Vazão mensal').score, context.result.score_through);
  return context;
}
const current = calculate('2026-09-23', 87);
assert.equal(current.result.kpi4, 87);
assert.ok(Math.abs(current.result.score_through - 75.0588235294) < 0.00001);
assert.equal(current.result.healthScore, 75);
assert.equal(current.tile.metaLabel, 'Até hoje 115,9 · mês 150 cards');
assert.equal(calculate('2026-09-01', 7).result.healthScore, 100);
assert.equal(calculate('2026-09-30', 87).result.healthScore, 58);
assert.equal(calculate('2026-09-30', 160).result.healthScore, 100);
assert.equal(calculate('2026-09-01', 0).result.healthScore, 0);
assert.equal(calculate('2026-08-01', 0).result.healthScore, 100);
console.log('Monthly target: calendar boundaries, weekends, timezone, score and presentation passed.');
