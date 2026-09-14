import assert from 'node:assert/strict';
import { exclusionIds, scopeIndicatorData } from '../js/indicator-scope.js';

const data = {
  cards: [{ id: 'activity' }, { id: 'reference' }],
  archived: [{ id: 'old-reference' }, { id: 'old-activity' }],
  throughput: { Production: 7 },
  throughputByCard: { activity: { Production: 3 }, reference: { Production: 4 } }
};
const ids = exclusionIds({ indicatorExcluded_reference: true, 'indicatorExcluded_old-reference': true,
  indicatorExcluded_activity: false, unrelated: true });
const scoped = scopeIndicatorData(data, ids);
assert.deepEqual(scoped.cards.map(c => c.id), ['activity']);
assert.deepEqual(scoped.archived.map(c => c.id), ['old-activity']);
assert.equal(scoped.throughput.Production, 3);
assert.equal(data.throughput.Production, 7);
assert.equal(data.cards.length, 2);
assert.deepEqual(scopeIndicatorData(scoped, ids).throughput, scoped.throughput, 'Repeated filtering must not double-subtract exits');
const restored = scopeIndicatorData(scoped, new Set());
assert.deepEqual(restored.cards, data.cards);
assert.deepEqual(restored.archived, data.archived);
assert.deepEqual(restored.throughput, data.throughput);
assert.deepEqual(scopeIndicatorData(data, new Set(['activity', 'reference'])).cards, []);
// Exclusion remains valid if a card later becomes complete or is archived.
assert.equal(scopeIndicatorData({cards: [{id:'reference', isConforme:true}], archived:[]}, ids).cards.length, 0);
assert.equal(scopeIndicatorData({cards: [], archived:[{id:'reference'}]}, ids).archived.length, 0);
console.log('Indicator scope: exclusion, archive, restoration and per-card throughput passed');
