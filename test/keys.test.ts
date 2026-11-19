/**
 * Key-pool tests.
 *
 * Two properties carry the feature: a session stays on one key, and it moves on
 * only when that key is spent. Both are invisible in normal use — a wrong pin
 * just looks like a slow session, a missing switch looks like a dead plugin —
 * so they are asserted here rather than left to the settings page.
 *
 * @module dsh-jev-tools/test/keys
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createKeyPool, keyRefs } from '../lib/keys.js'
import type { CredentialsService } from '../lib/host.js'

/** A credentials service backed by a ref → value map. */
function service (values: Record<string, string>): CredentialsService {
  return {
    resolve: async (ref: string) => {
      const value = values[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    describe: async () => ({ configured: true, writable: true }),
  }
}

test('the reference setting splits on commas, semicolons and whitespace, without duplicates', () => {
  assert.deepEqual(keyRefs('A,B'), ['A', 'B'])
  assert.deepEqual(keyRefs('A, B; C  A'), ['A', 'B', 'C'])
  assert.deepEqual(keyRefs('  '), [])
  assert.deepEqual(keyRefs('ONE'), ['ONE'])
})

test('one session stays on the same key', async () => {
  const pool = createKeyPool(
    () => service({ FIRST: 'k1', SECOND: 'k2' }),
    () => ['FIRST', 'SECOND']
  )
  assert.equal(await pool.first('agent-a'), 'k1')
  assert.equal(await pool.first('agent-a'), 'k1')
  // A different session starts at the head of the list, not where agent-a left off.
  assert.equal(await pool.first('agent-b'), 'k1')
})

test('a spent key is skipped, and the session moves to the next one', async () => {
  const pool = createKeyPool(
    () => service({ FIRST: 'k1', SECOND: 'k2' }),
    () => ['FIRST', 'SECOND']
  )
  const first = await pool.first('agent-a')
  assert.equal(first, 'k1')
  pool.exhaust('agent-a', 'k1')
  assert.equal(await pool.next('agent-a', ['k1']), 'k2')
  // The pin moved with the switch, so the next operation starts on k2 as well.
  assert.equal(await pool.first('agent-a'), 'k2')
  // Another session never saw the exhaustion.
  assert.equal(await pool.first('agent-b'), 'k1')
})

test('an unconfigured reference is skipped rather than pinning a missing key', async () => {
  const pool = createKeyPool(
    () => service({ SECOND: 'k2' }),
    () => ['FIRST', 'SECOND']
  )
  assert.equal(await pool.first('agent-a'), 'k2')
})

test('with every key spent there is nothing left to switch to', async () => {
  const pool = createKeyPool(
    () => service({ FIRST: 'k1', SECOND: 'k2' }),
    () => ['FIRST', 'SECOND']
  )
  assert.equal(await pool.first('agent-a'), 'k1')
  pool.exhaust('agent-a', 'k1')
  assert.equal(await pool.first('agent-a'), 'k2')
  pool.exhaust('agent-a', 'k2')
  assert.equal(await pool.first('agent-a'), undefined)
  assert.equal(await pool.next('agent-a', ['k1', 'k2']), undefined)
})

test('the status report can name what is configured and what is spent', async () => {
  const pool = createKeyPool(
    () => service({ FIRST: 'k1' }),
    () => ['FIRST', 'MISSING']
  )
  // Spent only ever follows a pick: the pool learns a value's reference when it
  // hands that value out, which is the only way it can map a failure back to one.
  assert.equal(await pool.first('agent-a'), 'k1')
  pool.exhaust('agent-a', 'k1')
  const standing = await pool.state('agent-a')
  assert.deepEqual(standing, [
    { ref: 'FIRST', ok: true, exhausted: true, source: 'file' },
    { ref: 'MISSING', ok: false, exhausted: false, problem: 'unconfigured' },
  ])
})
