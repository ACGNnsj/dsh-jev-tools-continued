/**
 * Proxy-setting tests.
 *
 * Only the registry parser is unit-tested: the rest of the module talks to
 * Windows and to undici, and a test that stubs both would assert its own
 * stubs. The parser is where a real system proxy gets mis-read — `ProxyServer`
 * is either a bare `host:port` or a per-scheme list.
 *
 * @module dsh-jev-tools/test/proxy
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseProxyServer } from '../lib/proxy.js'

test('a bare host:port is used as-is', () => {
  assert.equal(parseProxyServer('127.0.0.1:7897'), '127.0.0.1:7897')
})

test('a per-scheme list prefers the https entry', () => {
  assert.equal(parseProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7897'), '127.0.0.1:7897')
  assert.equal(parseProxyServer('http=127.0.0.1:7890;socks=127.0.0.1:7891'), '127.0.0.1:7890')
})

test('an empty value has no usable address', () => {
  assert.equal(parseProxyServer(''), undefined)
  assert.equal(parseProxyServer('  '), undefined)
})
