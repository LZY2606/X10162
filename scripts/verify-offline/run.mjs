#!/usr/bin/env node
/**
 * `pnpm run verify:offline` — offline verification pipeline.
 *
 * Runs, in order, from a checkout with locked dependencies installed
 * (`pnpm install --frozen-lockfile`):
 *   1. tree-sitter-wasm  bundled grammar presence and parser.info fingerprint
 *   2. lint              eslint + prettier, no autofix (pnpm lint:bail)
 *   3. typecheck         tsc --noEmit over the eslint tsconfig
 *   4. unit-tests        jest, excluding the suites that need external tools
 *   5. build             pnpm compile (server bundle incl. get-options.sh)
 *   6. lsp-smoke         real stdio LSP session against testing/verify-workspace
 *   7. package           npm pack content verification
 *
 * Everything runs offline: no downloads, no external tool installation, and
 * the LSP smoke session executes with a scrubbed PATH so ShellCheck, shfmt
 * and man page lookups must degrade gracefully instead of failing.
 *
 * Writes artifacts/verify-manifest.json with toolchain versions, the package
 * content digest, the fixture fingerprint and the per-request LSP results.
 * The manifest has a stable key order and contains no absolute paths,
 * timestamps, process ids or durations.
 */
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts')
const VERIFY_WORKSPACE = path.join(REPO_ROOT, 'testing', 'verify-workspace')

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const node = process.execPath

const steps = []

function runStep(name, command, args) {
  console.log(`\n=== verify:offline :: ${name} ===`)
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  const status = result.status === 0 ? 'passed' : 'failed'
  const displayCommand = command === process.execPath ? 'node' : command
  steps.push({ name, command: `${displayCommand} ${args.join(' ')}`, status })
  return result.status === 0
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function fixtureFingerprint() {
  const files = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (fs.statSync(full).isFile()) files.push(full)
    }
  }
  walk(VERIFY_WORKSPACE)
  const entries = files
    .map((full) => ({
      path: path.relative(VERIFY_WORKSPACE, full).split(path.sep).join('/'),
      sha256: sha256(fs.readFileSync(full)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return {
    workspace: 'testing/verify-workspace',
    files: entries,
    sha256: sha256(Buffer.from(entries.map((e) => `${e.path}\0${e.sha256}\n`).join(''), 'utf8')),
  }
}

function checkTreeSitter() {
  const wasmPath = path.join(REPO_ROOT, 'server', 'tree-sitter-bash.wasm')
  const parserInfoPath = path.join(REPO_ROOT, 'server', 'parser.info')
  if (!fs.existsSync(wasmPath)) {
    return { ok: false, error: 'server/tree-sitter-bash.wasm is missing' }
  }
  if (!fs.existsSync(parserInfoPath)) {
    return { ok: false, error: 'server/parser.info is missing' }
  }
  return {
    ok: true,
    value: {
      wasm: 'server/tree-sitter-bash.wasm',
      sha256: sha256(fs.readFileSync(wasmPath)),
      parserInfo: fs.readFileSync(parserInfoPath, 'utf8').trim().split('\n'),
      loadedInSmokeSession: false,
    },
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeManifest({ treeSitter, pnpmVersion, failed }) {
  const smoke = readJson(path.join(ARTIFACTS_DIR, 'lsp-smoke.json'))
  const pack = readJson(path.join(ARTIFACTS_DIR, 'package-contents.json'))
  if (smoke && treeSitter) {
    treeSitter.loadedInSmokeSession = smoke.requests.some(
      (request) => request.method === 'initialize' && request.status === 'ok',
    )
  }
  const rootPackage = readJson(path.join(REPO_ROOT, 'package.json')) ?? {}
  const manifest = {
    schemaVersion: 1,
    toolchain: {
      node: process.version,
      pnpm: pnpmVersion,
      packageManager: rootPackage.packageManager ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    treeSitter: treeSitter ?? null,
    fixtures: fixtureFingerprint(),
    steps,
    lsp: smoke
      ? {
          transcript: 'artifacts/lsp-smoke.json',
          isolatedEnvironment: smoke.isolatedEnvironment,
          requests: smoke.requests,
          degradations: smoke.degradations,
        }
      : null,
    package: pack
      ? {
          contents: 'artifacts/package-contents.json',
          name: pack.name,
          version: pack.version,
          fileCount: pack.fileCount,
          contentsSha256: pack.contentsSha256,
          tarballSha256: pack.tarball.sha256,
          requiredFiles: pack.requiredFiles,
          treeSitterWasm: pack.treeSitterWasm,
        }
      : null,
    optionalToolTests: {
      policy: 'tests requiring shellcheck, shfmt or man/col skip themselves when the tool is not on PATH',
      helper: 'testing/tools.ts',
    },
    result: failed ? 'failed' : 'passed',
  }
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, 'verify-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

function main() {
  const pnpmVersionResult = spawnSync(pnpm, ['--version'], { encoding: 'utf8' })
  const pnpmVersion = pnpmVersionResult.status === 0 ? pnpmVersionResult.stdout.trim() : 'unknown'

  const treeSitter = checkTreeSitter()
  steps.push({
    name: 'tree-sitter-wasm',
    command: 'check server/tree-sitter-bash.wasm and server/parser.info',
    status: treeSitter.ok ? 'passed' : 'failed',
  })
  if (!treeSitter.ok) {
    console.error(`verify:offline: ${treeSitter.error}`)
    writeManifest({ treeSitter: null, pnpmVersion, failed: true })
    process.exit(1)
  }

  const pipeline = [
    ['lint', pnpm, ['run', 'lint:bail']],
    ['typecheck', pnpm, ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.eslint.json']],
    // Tests that need external executables (shellcheck, shfmt, man/col)
    // skip themselves via testing/tools.ts when the tool is unavailable.
    ['unit-tests', pnpm, ['exec', 'jest', '--runInBand']],
    ['build', pnpm, ['run', 'compile']],
    ['lsp-smoke', node, ['scripts/verify-offline/lsp-smoke.mjs']],
    ['package', node, ['scripts/verify-offline/verify-package.mjs']],
  ]

  let failed = false
  for (const [name, command, args] of pipeline) {
    if (!runStep(name, command, args)) {
      failed = true
      break
    }
  }

  writeManifest({ treeSitter: treeSitter.value, pnpmVersion, failed })

  if (failed) {
    console.error('\nverify:offline: FAILED (see artifacts/verify-manifest.json)')
    process.exit(1)
  }
  console.log('\nverify:offline: all steps passed, manifest written to artifacts/verify-manifest.json')
}

main()
