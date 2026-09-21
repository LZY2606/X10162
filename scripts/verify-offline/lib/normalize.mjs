import fs from 'node:fs'
import os from 'node:os'

/**
 * Normalizers for artifacts emitted by the offline verification pipeline.
 *
 * The recorded requests/responses must be diffable across machines and CI
 * runs, so every value that depends on the checkout location, the operating
 * system user, the language server process id or elapsed wall-clock time is
 * replaced with a stable placeholder. Real payloads are preserved: only the
 * volatile substrings are rewritten.
 */

export const PLACEHOLDERS = {
  repo: '<REPO_ROOT>',
  fixture: '<FIXTURE_DIR>',
  tmp: '<TMP_DIR>',
  home: '<HOME_DIR>',
  pid: '<PID>',
}

/** Returns substrings that must be rewritten in recorded payloads. */
function buildVolatileSubstrings({ repoRoot, fixtureDir, tmpDir }) {
  const home = os.homedir()
  const pairs = []
  const add = (value, placeholder) => {
    if (!value) return
    const real = safeRealpath(value)
    for (const candidate of [...new Set([value, real])].filter(Boolean)) {
      pairs.push([candidate, placeholder])
      pairs.push([toFileUri(candidate), placeholder])
    }
  }

  add(repoRoot, PLACEHOLDERS.repo)
  add(fixtureDir, PLACEHOLDERS.fixture)
  add(tmpDir, PLACEHOLDERS.tmp)
  add(home, PLACEHOLDERS.home)

  // Longer paths first so nested prefixes (fixture inside repo) are rewritten
  // with the most specific placeholder.
  pairs.sort((a, b) => b[0].length - a[0].length)
  return pairs
}

function safeRealpath(value) {
  try {
    return fs.realpathSync.native(value)
  } catch {
    return null
  }
}

function toFileUri(pathname) {
  let resolved = pathname
  if (process.platform === 'win32') {
    resolved = resolved.replace(/\\/g, '/')
    if (!resolved.startsWith('/')) resolved = `/${resolved}`
  }
  return `file://${encodeURI(resolved)}`
}

/**
 * Creates a string normalizer. `pidHints` covers the language server pid and
 * process-group ids observed while the session was running.
 */
export function createStringNormalizer({ repoRoot, fixtureDir, tmpDir, pidHints = [] }) {
  const substrings = buildVolatileSubstrings({ repoRoot, fixtureDir, tmpDir })

  const pidPatterns = pidHints
    .filter((pid, index) => pid && pidHints.indexOf(pid) === index)
    .map((pid) => [new RegExp(`(?<![0-9])${pid}(?![0-9])`, 'g'), PLACEHOLDERS.pid])

  return function normalizeString(value) {
    let output = String(value)
    for (const [candidate, placeholder] of substrings) {
      output = output.split(candidate).join(placeholder)
      const encoded = encodeURI(candidate)
      if (encoded !== candidate) output = output.split(encoded).join(placeholder)
    }
    for (const [pattern, placeholder] of pidPatterns) {
      output = output.replace(pattern, placeholder)
    }
    return output
  }
}

/**
 * Deep-clones a JSON value, rewriting every string with `normalizeString` and
 * sorting object keys so the emitted artifact has a stable order.
 */
export function normalizeJson(value, normalizeString) {
  if (typeof value === 'string') return normalizeString(value)
  if (Array.isArray(value))
    return value.map((item) => normalizeJson(item, normalizeString))
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeJson(value[key], normalizeString)
        return acc
      }, {})
  }
  return value
}

/**
 * Rounds an elapsed duration (milliseconds) up to a power-of-two bucket so the
 * recorded value reflects timing without pinning an exact machine-specific
 * number.
 */
export function normalizeDuration(durationMs) {
  const ms = Math.max(0, Math.round(durationMs))
  let bucket = 1
  while (bucket < ms) bucket *= 2
  return `<${bucket}ms`
}
