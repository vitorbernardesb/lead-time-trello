const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const logic = source.slice(source.indexOf('  var AUTO_COOLDOWN ='), source.indexOf('  function runAutomations('));
const review = 'Revisões em Atraso ⏰';
const now = Date.now();
function movement(id, name = review, age = 1000) {
  return { id, type: 'updateCard', date: new Date(now - age).toISOString(), data: { listAfter: { id: name, name } } };
}
function fixture(options = {}) {
  let value = options.value || 'low', saved = options.saved, writes = 0, reads = 0, errors = 0;
  let failPut = options.failPut;
  const context = {
    Date: class extends Date { static now() { return now; } },
    console: { warn() { errors++; } },
    apiUrl: p => p,
    assertOk: r => { if (!r.ok) throw Error('HTTP failure'); return r; },
    queuedFetch: async (url, init) => {
      if (init && init.method === 'PUT') {
        writes++;
        assert.equal(JSON.parse(init.body).idValue, 'high');
        if (failPut) return { ok: false };
        value = 'high';
        return { ok: true };
      }
      reads++;
      if (options.waitRead) await options.waitRead;
      return { ok: true, json: async () => [{ idCustomField: 'priority', idValue: value }] };
    }
  };
  vm.createContext(context);
  vm.runInContext(logic, context);
  const t = {
    get: async () => { if (options.failGet) throw Error('Read failed'); return saved; },
    set: async (scope, visibility, key, event) => {
      assert.equal(key, 'priorityAutomationEvent');
      if (options.failSet) throw Error('Write failed');
      saved = event;
    }
  };
  return {
    run: (actions = [movement('entry')], list = review) => context.updateOverduePriority(t,
      { id: 'card' }, actions, { prioridade: { fieldId: 'priority', options: { ALTO: 'high' } } }, 'fake', list),
    stats: () => ({ writes, reads, errors, saved }),
    changeValue: v => { value = v; },
    allowRetry: () => { context._priorityAutomationState.card.retryAt = 0; failPut = false; },
    reload: () => { context._priorityAutomationState = {}; }
  };
}

(async () => {
  let f = fixture({ value: 'high' });
  await f.run();
  assert.equal(f.stats().writes, 0, 'Already high must not be written');
  assert.equal(f.stats().saved, 'entry');

  f = fixture();
  await f.run();
  f.changeValue('low');
  await f.run();
  f.reload();
  await f.run();
  assert.equal(f.stats().writes, 1, 'Processed event must not override later manual edits, including after reload');
  await f.run([movement('new-entry', review, 0)]);
  assert.equal(f.stats().writes, 2, 'A new entry must still be processed');

  f = fixture({ failSet: true });
  await f.run();
  await f.run();
  f.reload();
  await f.run();
  assert.equal(f.stats().writes, 1, 'Failed persistence must not repeat successful PUT, including after reload');
  assert.ok(f.stats().errors > 0, 'Persistence failure must be reported');

  f = fixture({ failGet: true });
  await f.run();
  await f.run();
  assert.equal(f.stats().writes, 0, 'Failed control read must prevent mutation');
  assert.equal(f.stats().errors, 1, 'Failed reads must be throttled');

  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  f = fixture({ waitRead: waiting });
  const first = f.run();
  await f.run();
  release();
  await first;
  assert.equal(f.stats().writes, 1, 'Concurrent badge calls must share an in-flight lock');

  f = fixture({ failPut: true });
  await f.run();
  await f.run();
  assert.equal(f.stats().writes, 1, 'Failed PUT must not retry immediately');
  assert.equal(f.stats().saved, undefined, 'Failed PUT must not mark the event as done');
  f.allowRetry();
  await f.run();
  assert.equal(f.stats().writes, 2);
  assert.equal(f.stats().saved, 'entry');

  f = fixture();
  await f.run([movement('expired', review, 600001)]);
  await f.run([movement('future', review, -1000)]);
  await f.run([movement('entry')], 'Planejamento');
  await f.run([movement('entry'), movement('exit', 'Planejamento', 0)]);
  await f.run([]);
  assert.equal(f.stats().reads, 0, 'Old, future, exited and missing movements must not trigger the rule');
  console.log('Priority automation: value checks, event deduplication, persistence failures, concurrency, retry and movement guards passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
