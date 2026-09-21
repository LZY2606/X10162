#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Enforces explicit ownership of the bundled tree-sitter language wasm:
 *
 *   - server/tree-sitter-bash.wasm must exist in the repository.
 *   - The tree-sitter-cli/ABI metadata in server/parser.info must agree with
 *     the installed web-tree-sitter runtime; a mismatch means the wasm cannot
 *     be loaded and verification must fail.
 *   - The grammar is loaded through the compiled parser's production path;
 *     there is intentionally no fallback to a global or cache wasm.
 *
 * Emits artifacts/wasm-report.json.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const REPO_ROOT = process.env.VERIFY_REPO_ROOT || process.cwd()
const SERVER_DIR = join(REPO_ROOT, 'server')
const WASM_PATH = join(SERVER_DIR, 'tree-sitter-bash.wasm')
const PARSER_INFO_PATH = join(SERVER_DIR, 'parser.info')
const RUNTIME_PACKAGE_CANDIDATES = [
  join(SERVER_DIR, 'node_modules', 'web-tree-sitter', 'package.json'),
  join(REPO_ROOT, 'node_modules', 'web-tree-sitter', 'package.json'),
]
const RUNTIME_PACKAGE_PATH = RUNTIME_PACKAGE_CANDIDATES.find((candidate) =>
  existsSync(candidate),
)
const require = createRequire(import.meta.url)

async function main() {
  const artifactsDir = process.env.VERIFY_ARTIFACTS_DIR
  if (!artifactsDir) {
    console.error('VERIFY_ARTIFACTS_DIR must be set')
    process.exit(2)
  }

  const failures = []

  if (!existsSync(WASM_PATH)) {
    failures.push(
      'bundled server/tree-sitter-bash.wasm is missing; refusing to fall back to a global wasm',
    )
  }

  const parserInfo = existsSync(PARSER_INFO_PATH)
    ? readFileSync(PARSER_INFO_PATH, 'utf8')
    : ''
  if (!parserInfo) failures.push('server/parser.info is missing')

  const cliVersion = /tree-sitter-cli "([^"]+)"/.exec(parserInfo)?.[1] ?? null
  const abiRecorded = /parser ABI (\d+)/.exec(parserInfo)?.[1] ?? null
  if (!cliVersion) failures.push('tree-sitter-cli version missing from parser.info')
  if (!abiRecorded) failures.push('parser ABI missing from parser.info')

  const runtimeVersion = existsSync(RUNTIME_PACKAGE_PATH)
    ? JSON.parse(readFileSync(RUNTIME_PACKAGE_PATH, 'utf8')).version
    : null
  if (!runtimeVersion) {
    failures.push('web-tree-sitter is not installed (run pnpm install --frozen-lockfile)')
  } else if (cliVersion && runtimeVersion !== cliVersion) {
    failures.push(
      `tree-sitter version mismatch: parser.info records ${cliVersion} but web-tree-sitter ${runtimeVersion} is installed`,
    )
  }

  // Real load through the production parser entry. A version/ABI mismatch
  // raises here; the harness fails instead of substituting another grammar.
  let loadError = null
  let initialized = false
  try {
    const { initializeParser } = require(join(SERVER_DIR, 'out', 'parser.js'))
    const parser = await initializeParser()
    initialized = Boolean(parser)
    parser.delete()
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
  }
  if (!initialized) {
    failures.push(
      `bundled wasm failed to load with the installed web-tree-sitter (${loadError ?? 'unknown error'}); refusing to substitute another grammar`,
    )
  }

  // Guard the production source: it may only read the bundled wasm file.
  const parserSource = readFileSync(join(SERVER_DIR, 'src', 'parser.ts'), 'utf8')
  if (!parserSource.includes('tree-sitter-bash.wasm')) {
    failures.push('server/src/parser.ts does not reference the bundled wasm filename')
  }
  if (/tree-sitter\/cli\/src/i.test(parserSource)) {
    failures.push('parser appears to reference a global tree-sitter CLI grammar path')
  }

  const sha256 = existsSync(WASM_PATH)
    ? createHash('sha256').update(readFileSync(WASM_PATH)).digest('hex')
    : null
  const size = existsSync(WASM_PATH) ? readFileSync(WASM_PATH).length : null

  const report = {
    wasmPath: 'server/tree-sitter-bash.wasm',
    sha256,
    size,
    parserInfo: {
      treeSitterCliVersion: cliVersion,
      abiRecorded: abiRecorded ? Number(abiRecorded) : null,
      webTreeSitterRuntimeVersion: runtimeVersion,
    },
    loadedSuccessfully: initialized,
    failures,
  }

  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(
    join(artifactsDir, 'wasm-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )

  if (failures.length > 0) {
    console.error('WASM verification failed:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(
    `WASM verification passed (bundled tree-sitter-bash.wasm loads; ABI ${abiRecorded}, tree-sitter ${cliVersion})`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
