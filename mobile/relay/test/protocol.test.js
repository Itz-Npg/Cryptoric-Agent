/**
 * Tests for the relay's protocol half.
 *
 * These mirror `mobile/ios/Tests/CryptoricKitTests/CryptoricKitTests.swift` on
 * purpose. Both sides of the wire contract are tested against the same rules,
 * because a field renamed in one implementation and not the other produces an
 * app that shows nothing while every test on each side still passes.
 *
 * Run with: `node --test mobile/relay/test/`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RelayState,
  decodeCommand,
  normaliseTask,
  isTerminal,
  isSuccess,
  UNKNOWN_STATUS
} from '../src/protocol.js'

function at(secondsAgo = 0) {
  return new Date(Date.now() - secondsAgo * 1000).toISOString()
}

function task(overrides = {}) {
  return {
    id: 't1',
    title: 'Fix the button',
    status: 'implementing',
    stage: 'implement',
    lastNote: '',
    updatedAt: at(),
    changedPaths: [],
    ...overrides
  }
}

test('an unknown status degrades to blocked, never to success', () => {
  const normalised = normaliseTask(task({ status: 'teleported' }))
  assert.equal(normalised.status, UNKNOWN_STATUS)
  assert.equal(normalised.status, 'blocked')
  assert.equal(isSuccess(normalised.status), false)
  assert.equal(isTerminal(normalised.status), true)
})

test('a known status is preserved', () => {
  assert.equal(normaliseTask(task({ status: 'completed' })).status, 'completed')
  assert.equal(normaliseTask(task({ status: 'queued' })).status, 'queued')
})

test('missing fields become empty rather than undefined', () => {
  const normalised = normaliseTask({ id: 'x' })
  assert.equal(normalised.title, '')
  assert.equal(normalised.stage, '')
  assert.deepEqual(normalised.changedPaths, [])
  assert.equal(typeof normalised.updatedAt, 'string')
})

test('replace and snapshot round-trip a task list', () => {
  const state = new RelayState()
  state.replace([task({ id: 'a' }), task({ id: 'b', status: 'completed' })])
  const snapshot = state.snapshot()
  assert.equal(snapshot.tasks.length, 2)
  assert.ok(snapshot.generatedAt)
})

test('needsAttention covers every non-success terminal state', () => {
  const state = new RelayState()
  state.replace([
    task({ id: 'ok', status: 'completed' }),
    task({ id: 'bad', status: 'failed' }),
    task({ id: 'stuck', status: 'blocked' }),
    task({ id: 'gone', status: 'cancelled' }),
    task({ id: 'busy', status: 'verifying' })
  ])
  assert.deepEqual(state.needsAttention().map((t) => t.id).sort(), ['bad', 'gone', 'stuck'])
})

test('a stale update does not overwrite a newer one', () => {
  const state = new RelayState()
  state.replace([task({ id: 't1', status: 'completed', updatedAt: at(0) })])
  // A delayed "queued" from before must not resurrect the task.
  state.upsert(task({ id: 't1', status: 'queued', updatedAt: at(60) }))
  assert.equal(state.get('t1').status, 'completed')
})

test('a newer update does overwrite an older one', () => {
  const state = new RelayState()
  state.replace([task({ id: 't1', status: 'implementing', updatedAt: at(60) })])
  state.upsert(task({ id: 't1', status: 'completed', updatedAt: at(0) }))
  assert.equal(state.get('t1').status, 'completed')
})

test('a task with no id is rejected rather than stored under undefined', () => {
  const state = new RelayState()
  assert.equal(state.upsert(task({ id: '' })), null)
  assert.equal(state.snapshot().tasks.length, 0)
})

test('followUp reaches the task and becomes its last note', () => {
  const state = new RelayState()
  state.replace([task({ id: 't1' })])
  const entry = state.followUp('t1', '  also check mobile  ')
  assert.equal(entry.text, 'also check mobile')
  assert.equal(state.get('t1').lastNote, 'also check mobile')
  assert.equal(state.followUpsFor('t1').length, 1)
})

test('followUp to an unknown task throws rather than silently accepting', () => {
  const state = new RelayState()
  assert.throws(() => state.followUp('nope', 'hello'), /No such task/)
})

test('followUp to a finished task throws rather than reviving it', () => {
  const state = new RelayState()
  state.replace([task({ id: 't1', status: 'completed' })])
  assert.throws(() => state.followUp('t1', 'hello'), /already finished/)
})

test('followUp with no text throws', () => {
  const state = new RelayState()
  state.replace([task({ id: 't1' })])
  assert.throws(() => state.followUp('t1', '   '), /needs some text/)
})

test('cancel only works on a running task', () => {
  const state = new RelayState()
  state.replace([task({ id: 'running' }), task({ id: 'done', status: 'completed' })])
  assert.equal(state.cancel('running').status, 'cancelled')
  assert.throws(() => state.cancel('done'), /already finished/)
  assert.throws(() => state.cancel('missing'), /No such task/)
})

test('subscribers are notified and can unsubscribe', () => {
  const state = new RelayState()
  let calls = 0
  const unsubscribe = state.subscribe(() => { calls += 1 })
  state.replace([task()])
  assert.equal(calls, 1)
  unsubscribe()
  state.replace([])
  assert.equal(calls, 1)
})

test('one broken subscriber does not silence the others', () => {
  const state = new RelayState()
  let good = 0
  state.subscribe(() => { throw new Error('boom') })
  state.subscribe(() => { good += 1 })
  state.replace([task()])
  assert.equal(good, 1)
})

test('commands decode and malformed ones throw', () => {
  assert.deepEqual(decodeCommand({ kind: 'refresh' }), { kind: 'refresh' })
  assert.deepEqual(decodeCommand({ kind: 'followUp', taskId: 't1', text: ' hi ' }), {
    kind: 'followUp',
    taskId: 't1',
    text: 'hi'
  })
  assert.deepEqual(decodeCommand({ kind: 'cancel', taskId: 't1' }), { kind: 'cancel', taskId: 't1' })

  assert.throws(() => decodeCommand(null), /must be an object/)
  assert.throws(() => decodeCommand({ kind: 'nope' }), /Unknown command/)
  assert.throws(() => decodeCommand({ kind: 'followUp' }), /needs taskId/)
  assert.throws(() => decodeCommand({ kind: 'followUp', taskId: 't1' }), /needs text/)
  assert.throws(() => decodeCommand({ kind: 'cancel' }), /needs taskId/)
})

test('generatedAt is ISO-8601, matching what the Swift decoder expects', () => {
  const state = new RelayState()
  const { generatedAt } = state.snapshot()
  assert.ok(generatedAt.includes('T'), `not ISO-8601: ${generatedAt}`)
  assert.ok(!Number.isNaN(Date.parse(generatedAt)))
})