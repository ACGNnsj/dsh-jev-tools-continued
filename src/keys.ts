/**
 * The key pool: several credentials, one pinned per session.
 *
 * A free-tier key runs out mid-session, and the failure looks like a plugin that
 * does nothing — every capability here is fail-open. So the reference setting
 * accepts a **list** of environment variable names, and the pool does two things
 * with it:
 *
 *   1. **Pin one key per session.** Judgments in one conversation must not
 *      bounce between keys: a key that answered one question is the one whose
 *      limits and behaviour are already known.
 *   2. **Move on only when a key is spent.** `unauthorized` and `rate-limited`
 *      are the two problems a different key can fix; everything else (a bad
 *      body, a region block, a network failure) is the same on every key, and
 *      switching there would just multiply the failures.
 *
 * The pool never stores a key: every pick re-resolves through the credentials
 * seam, for the same reason `credentials.ts` does — a fixed key takes effect on
 * the next judgment without a restart.
 *
 * @module dsh-jev-tools/keys
 */

import { resolveApiKey, type KeyProblem } from './credentials.js'
import type { CredentialsService } from './host.js'

/**
 * How many sessions the pool remembers before it forgets the oldest.
 *
 * The host is long-lived and every session creates an agent, so both maps need a
 * ceiling. Forgetting a session only costs its pin, which the next pick re-learns.
 */
const MAX_AGENTS = 256

/**
 * Split the key-reference setting into usable variable names.
 *
 * Commas, semicolons and whitespace all separate, so `A,B`, `A B` and a pasted
 * `A, B` all mean two keys. Duplicates collapse: resolving the same variable
 * twice would pin the same key and switch to itself.
 *
 * @param raw - the `apiKeyEnv` setting as configured.
 * @returns the reference names, in order, without blanks or duplicates.
 */
export function keyRefs (raw: string): string[] {
  const refs: string[] = []
  for (const part of raw.split(/[\s,;]+/)) {
    const ref = part.trim()
    if (ref !== '' && !refs.includes(ref)) refs.push(ref)
  }
  return refs
}

/** One reference's standing, for the status report. */
export interface KeyStanding {
  readonly ref: string
  /** Whether a value currently resolves. */
  readonly ok: boolean
  /** Where a resolving value came from, when known. */
  readonly source?: string
  /** Why a reference does not resolve, when it does not. */
  readonly problem?: KeyProblem
  /** Whether this session has already moved past it. */
  readonly exhausted: boolean
}

/** The pool's surface. */
export interface KeyPool {
  /**
   * The session's key: the pinned one when it still resolves, otherwise the
   * first usable one after it.
   *
   * @param agentId - the session, as the host names it.
   * @returns the key value, or `undefined` when no reference resolves.
   */
  first (agentId: string): Promise<string | undefined>
  /**
   * The next usable key after a failure.
   *
   * @param agentId - the session.
   * @param tried - values already attempted, so a switch never repeats one.
   * @returns the next key value, or `undefined` when none is left.
   */
  next (agentId: string, tried: readonly string[]): Promise<string | undefined>
  /**
   * Record that a key cannot be used any more in this session.
   *
   * @param agentId - the session.
   * @param value - the key value that failed.
   */
  exhaust (agentId: string, value: string): void
  /** The configured reference names, in order. */
  refs (): string[]
  /**
   * Every reference's standing, for `/jev-status`.
   *
   * @param agentId - the session.
   */
  state (agentId: string): Promise<KeyStanding[]>
}

/**
 * Create the pool.
 *
 * @param credentials - the credentials seam, read fresh on every pick.
 * @param refs - the reference names, read fresh so a settings edit lands without a restart.
 * @returns the pool.
 */
export function createKeyPool (
  credentials: () => CredentialsService | undefined,
  refs: () => string[]
): KeyPool {
  /** Session → index of the pinned reference. */
  const pinned = new Map<string, number>()
  /** Session → references this session has moved past. */
  const spent = new Map<string, Set<string>>()
  /** Value → the reference it came from, so `exhaust` can name the reference. */
  const origin = new Map<string, string>()
  /** Session ids in first-seen order, for eviction. */
  const order: string[] = []

  const spentOf = (agentId: string): Set<string> => {
    let set = spent.get(agentId)
    if (set === undefined) {
      set = new Set<string>()
      spent.set(agentId, set)
      order.push(agentId)
      if (order.length > MAX_AGENTS) {
        const oldest = order.shift()
        if (oldest !== undefined) {
          pinned.delete(oldest)
          spent.delete(oldest)
        }
      }
    }
    return set
  }

  const pick = async (agentId: string, tried: readonly string[]): Promise<string | undefined> => {
    const list = refs()
    if (list.length === 0) return undefined
    const spentHere = spentOf(agentId)
    const start = pinned.get(agentId) ?? 0
    for (let step = 0; step < list.length; step += 1) {
      const index = (start + step) % list.length
      const ref = list[index]
      if (ref === undefined || spentHere.has(ref)) continue
      const lookup = await resolveApiKey(credentials(), ref)
      if (!lookup.ok) continue
      if (tried.includes(lookup.value)) continue
      pinned.set(agentId, index)
      origin.set(lookup.value, ref)
      return lookup.value
    }
    return undefined
  }

  return {
    first: agentId => pick(agentId, []),
    next: (agentId, tried) => pick(agentId, tried),
    exhaust (agentId, value) {
      const ref = origin.get(value)
      if (ref === undefined) return
      spentOf(agentId).add(ref)
      const list = refs()
      const index = list.indexOf(ref)
      if (index >= 0 && list.length > 0) pinned.set(agentId, (index + 1) % list.length)
    },
    refs,
    async state (agentId) {
      const spentHere = spentOf(agentId)
      const standing: KeyStanding[] = []
      for (const ref of refs()) {
        const lookup = await resolveApiKey(credentials(), ref)
        standing.push(lookup.ok
          ? { ref, ok: true, exhausted: spentHere.has(ref), source: lookup.source }
          : { ref, ok: false, exhausted: spentHere.has(ref), problem: lookup.problem })
      }
      return standing
    },
  }
}
