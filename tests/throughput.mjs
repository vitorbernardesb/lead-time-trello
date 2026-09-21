import assert from 'node:assert/strict';
import {
  APP_TIME_ZONE, CONCLUDED_LIST, conclusionDayKey, latestConclusionFromActions,
  selectCompletedCards, groupCompletedCards, throughputForPeriod
} from '../js/throughput.js';

const done = CONCLUDED_LIST;
const move = (date, list = done) => ({ type: 'updateCard', date, data: { listAfter: { name: list } } });
const card = (id, concludedAt, extra = {}) => ({
  id, name: 'Card ' + id, currentListName: done, concludedAt, url: 'https://trello.com/c/' + id, ...extra
});
const localDate = key => { const [y,m,d] = key.split('-').map(Number); return new Date(y, m - 1, d); };

assert.equal(APP_TIME_ZONE, 'America/Sao_Paulo');

// 1–3: uma conclusão, reentrada (última vence) e reabertura que permanece fora.
assert.equal(latestConclusionFromActions([move('2026-09-02T15:00:00Z')]), '2026-09-02T15:00:00.000Z');
assert.equal(latestConclusionFromActions([
  move('2026-09-03T15:00:00Z'), move('2026-09-05T15:00:00Z', 'Revisão'), move('2026-09-08T15:00:00Z')
]), '2026-09-08T15:00:00.000Z');
assert.equal(selectCompletedCards([card('reopened', '2026-09-04T15:00:00Z', { currentListName: 'Em andamento 💪' })]).length, 0);

const source = [
  card('a', '2026-09-02T15:00:00Z'),
  card('b', '2026-09-02T23:30:00Z'),
  card('c', '2026-09-08T15:00:00Z'),
  card('ignored', '2026-09-03T15:00:00Z'),
  card('archived', '2026-09-03T15:00:00Z', { isArchived: true }),
  card('reopened', '2026-09-04T15:00:00Z', { currentListName: 'Revisão Interna 🔎' }),
  card('duplicate', '2026-09-09T15:00:00Z'),
  card('duplicate', '2026-09-10T15:00:00Z')
];
const selected = selectCompletedCards(source, new Set(['ignored']));
assert.deepEqual(selected.map(c => c.id), ['a', 'b', 'c', 'duplicate']);
assert.equal(selected.find(c => c.id === 'duplicate').conclusionDay, '2026-09-10');

// 6–9: dois no mesmo dia, dias distintos, segunda-feira como início semanal e mês.
const range = [localDate('2026-09-01'), localDate('2026-09-30')];
assert.deepEqual(groupCompletedCards(selected, ...range, 'day').map(p => [p.key,p.value]), [
  ['2026-09-02',2], ['2026-09-08',1], ['2026-09-10',1]
]);
assert.deepEqual(groupCompletedCards(selected, ...range, 'week').map(p => [p.key,p.value]), [
  ['2026-08-31',2], ['2026-09-07',2]
]);
assert.deepEqual(groupCompletedCards(selected, ...range, 'month').map(p => [p.key,p.value]), [['2026-09',4]]);

// 10: 00:00/23:59 e viradas são convertidos explicitamente para São Paulo.
assert.equal(conclusionDayKey('2026-09-15T02:59:59Z'), '2026-09-14');
assert.equal(conclusionDayKey('2026-09-15T03:00:00Z'), '2026-09-15');
assert.equal(conclusionDayKey('2026-10-01T02:59:59Z'), '2026-09-30');
assert.equal(conclusionDayKey('2026-10-01T03:00:00Z'), '2026-10-01');

// A semana de borda respeita o intervalo exato antes de agrupar.
const boundary = selectCompletedCards([
  card('sun', '2026-09-14T02:59:59Z'), // domingo, 13/09 23:59 em São Paulo
  card('mon', '2026-09-14T03:00:00Z')  // segunda, 14/09 00:00
]);
assert.deepEqual(groupCompletedCards(boundary, localDate('2026-09-14'), localDate('2026-09-20'), 'week').map(p => [p.key,p.value]), [['2026-09-14',1]]);

// 11: a soma dos pontos é obrigatoriamente igual à vazão do mesmo período.
for (const grouping of ['day', 'week', 'month']) {
  const points = groupCompletedCards(selected, ...range, grouping);
  assert.equal(points.reduce((sum, p) => sum + p.value, 0), throughputForPeriod(selected, ...range));
  for (const point of points) assert.equal(point.cards.length, point.value);
}

assert.equal(latestConclusionFromActions([move('inválida'), { type: 'updateCard', data: {} }]), null);
assert.equal(selectCompletedCards([card('bad-date', 'inválida')]).length, 0);
console.log('Throughput: eligibility, latest completion, timezone, day/week/month grouping and chart parity passed.');
