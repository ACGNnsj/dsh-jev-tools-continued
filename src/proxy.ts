/**
 * The network exit: direct, the operating system's proxy, or one named by hand.
 *
 * Jev decides availability by IP, so a host that sits behind a blocked region
 * gets a `403 RegionError` on every judgment and — because every capability here
 * is fail-open — the plugin simply looks idle. Node's `fetch` does not read the
 * Windows proxy settings (they live in the registry, and only WinINET and
 * Chromium honour them), so "use my system proxy" has to be read and applied
 * here rather than inherited.
 *
 * One setting covers all three modes:
 *
 *   - empty      → direct, exactly as before this module existed;
 *   - `system`   → the OS proxy (Windows: registry; elsewhere: `HTTPS_PROXY`);
 *   - a URL      → that proxy, e.g. `http://127.0.0.1:7897`.
 *
 * The result is an undici `dispatcher`, which is the only way to route Node's
 * own `fetch` through a proxy without replacing the transport.
 *
 * @module dsh-jev-tools/proxy
 */

import { execFile } from 'node:child_process'

/** Registry key that holds the per-user WinINET proxy configuration. */
const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** How long a `reg query` may take before the read is abandoned. */
const REG_TIMEOUT_MS = 1_500

/**
 * Resolved dispatchers, keyed by the setting that produced them.
 *
 * A proxy setting changes rarely and reading the registry costs a process spawn,
 * so the promise is memoised rather than re-derived per request. Keying on the
 * setting text means editing the setting produces a different entry instead of
 * serving a stale one.
 */
const cache = new Map<string, Promise<unknown | undefined>>()

/**
 * Resolve the dispatcher for a proxy setting.
 *
 * @param setting - the `proxy` setting: empty, `system`, or a proxy URL.
 * @returns a dispatcher to hand to `fetch`, or `undefined` for a direct connection.
 */
export function dispatcherFor (setting: string): Promise<unknown | undefined> {
  const key = setting.trim()
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const pending = build(key)
  cache.set(key, pending)
  return pending
}

/**
 * Build one dispatcher.
 *
 * @param setting - the normalised setting text.
 * @returns the dispatcher, or `undefined` when the connection stays direct.
 */
async function build (setting: string): Promise<unknown | undefined> {
  const url = setting === ''
    ? undefined
    : setting.toLowerCase() === 'system' ? await systemProxy() : setting
  if (url === undefined) return undefined
  const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`
  try {
    // Dynamic on purpose: a profile without the optional package keeps working
    // (direct connection) instead of failing to mount the whole plugin.
    const { ProxyAgent } = await import('undici')
    return new ProxyAgent(target)
  } catch {
    return undefined
  }
}

/**
 * Read the operating system's proxy.
 *
 * @returns the proxy URL, or `undefined` when the system has none enabled.
 */
async function systemProxy (): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return process.env.HTTPS_PROXY ?? process.env.https_proxy
      ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      ?? undefined
  }
  const text = await regQuery()
  if (text === undefined) return undefined
  const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/mi.exec(text)
  if (enabled === null || Number.parseInt(enabled[1] ?? '0', 16) !== 1) return undefined
  const server = /^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/mi.exec(text)
  if (server === null) return undefined
  return parseProxyServer(server[1] ?? '')
}

/**
 * Read the WinINET registry key.
 *
 * @returns the raw `reg query` output, or `undefined` when it cannot be read.
 */
function regQuery (): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      'reg',
      ['query', REG_PATH],
      { timeout: REG_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => { resolve(error === null ? stdout : undefined) }
    )
  })
}

/**
 * Pull one address out of a `ProxyServer` value.
 *
 * Windows stores either a bare `host:port` or a per-scheme list such as
 * `http=h:1;https=h:2`. The HTTPS entry is the one that matters for an HTTPS
 * endpoint, so it wins; a bare value is used as-is.
 *
 * @param raw - the registry value.
 * @returns the proxy address, or `undefined` when it holds nothing usable.
 */
export function parseProxyServer (raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  // The common form is a bare `host:port`, which carries no scheme at all.
  if (!text.includes('=')) return text
  const entries = new Map<string, string>()
  for (const part of text.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    const scheme = part.slice(0, at).trim().toLowerCase()
    const address = part.slice(at + 1).trim()
    if (scheme !== '' && address !== '') entries.set(scheme, address)
  }
  const chosen = entries.get('https') ?? entries.get('http') ?? [...entries.values()][0]
  return chosen === undefined || chosen === '' ? undefined : chosen
}
