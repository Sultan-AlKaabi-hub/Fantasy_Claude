import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../js/core/fsm.js';

function machine(guard) {
  const calls = [];
  const states = {
    a: { enter: (o, from) => calls.push(`enter a from ${from}`), update: () => calls.push('update a'), exit: (o, to) => calls.push(`exit a to ${to}`) },
    b: { enter: (o, from, data) => calls.push(`enter b from ${from} ${data?.tag ?? ''}`.trim()), update: (o) => { if (o.jump) o.fsm.set('a'); } },
    dead: {},
  };
  const owner = { jump: false };
  owner.fsm = new StateMachine(owner, states, guard);
  return { owner, calls };
}

test('enter/exit hooks fire in order and frame counter resets', () => {
  const { owner, calls } = machine();
  owner.fsm.set('a');
  owner.fsm.update({}); owner.fsm.update({});
  assert.equal(owner.fsm.frame, 2);
  owner.fsm.set('b', { tag: 'x' });
  assert.deepEqual(calls, ['enter a from null', 'update a', 'update a', 'exit a to b', 'enter b from a x']);
  assert.equal(owner.fsm.frame, 0);
});

test('a transition inside update leaves the new state at frame 0', () => {
  const { owner } = machine();
  owner.fsm.set('b');
  owner.jump = true;
  owner.fsm.update({});
  assert.equal(owner.fsm.name, 'a');
  assert.equal(owner.fsm.frame, 0, 'new state must see frame 0 on its first update');
});

test('unknown states throw, guarded transitions are refused', () => {
  const { owner } = machine((from, to) => from !== 'dead');
  assert.throws(() => owner.fsm.set('nope'));
  owner.fsm.set('dead');
  assert.equal(owner.fsm.set('a'), false);
  assert.equal(owner.fsm.name, 'dead');
});

test('re-entering the same non-reentrant state is a no-op', () => {
  const { owner, calls } = machine();
  owner.fsm.set('a');
  assert.equal(owner.fsm.set('a'), false);
  assert.equal(calls.filter((c) => c.startsWith('enter a')).length, 1);
});
