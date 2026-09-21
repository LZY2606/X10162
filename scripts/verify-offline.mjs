#!/usr/bin/env node
/**
 * Offline verification entry point (pnpm run verify:offline).
 *
 * From a clean checkout with locked dependencies this runs, in order:
 *   1. pnpm install --frozen-lockfile
 *   2. lint (formatting included via the prettier ESLint plugin)
 *   3. typecheck
 *   4. unit tests (Jest; tests that need optional external tools self-skip)
 *   5. server build (pnpm compile)
 *   6. bundled tree-sitter wasm check (scripts/check-wasm.mjs)
 *   7. a real stdio LSP smoke session (scripts/lsp-smoke.mjs)
 *   8. publish package content verification (npm pack --dry-run)
 *
 * Everything runs locally: no network access and no ShellCheck, shfmt, man
 * pages or other optional tools are required. The LSP smoke session spawns
 * the server with an isolated empty PATH to prove that those capabilities
 * degrade per protocol while the remaining requests keep succeeding.
 *
 * A stable summary is written to artifacts/verify-manifest.json: tool
 * versions, package content digest, fixture fingerprint, per-request LSP
 * results and degradation reasons. The manifest intentionally contains no
 * absolute paths, timestamps or durations so it is comparable across runs.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_DIR = join(REPO_ROOT, 'server')
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts')
const MANIFEST_PATH = join(ARTIFACTS_DIR, 'verify-manifest.json')
const SMOKE_TRANSCRIPT_PATH = join(ARTIFACTS_DIR, 'lsp-smoke.json')
const VERIFY_WORKSPACE = join(REPO_ROOT, 'testing', 'verify-workspace')

const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// Files that must be part of the published server package.
const REQUIRED_PACKAGE_FILES = [
  'package.json',
  'README.md',
  'out/cli.js',
  'out/server.js',
  'out/get-options.sh',
  'tree-sitter-bash.wasm',
]

const steps = []
let packageSummary = null
let smokeSummary = null

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function runStep(name, command, args, options = {}) {
  console.log(`\n=== verify:offline: ${name} ===`)
  console.log(`$ ${command} ${args.join(' ')}`)
  // Record the portable command name in the manifest, but spawn the current
  // Node.js binary so no absolute paths leak into the artifacts.
  const executable = command === 'node' ? process.execPath : command
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    encoding: 'utf8',
  })
  const status = result.status === 0 ? 'passed' : 'failed'
  steps.push({ name, command: [command, ...args].join(' '), status })
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`step "${name}" failed with exit code ${result.status}`)
  }
  return result
}

function fingerprintDirectory(directory) {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }
  walk(directory)
  const entries = files.map((file) => {
    const relativePath = relative(directory, file).split(sep).join('/')
    return `${relativePath}:${sha256(readFileSync(file))}`
  })
  return {
    path: relative(REPO_ROOT, directory).split(sep).join('/'),
    files: entries.map((entry) => entry.split(':')[0]),
    sha256: sha256(entries.join('\n')),
  }
}

function verifyPackageContents() {
  const result = runStep(
    'package-contents',
    NPM,
    ['pack', '--dry-run', '--json'],
    { cwd: SERVER_DIR, captureOutput: true },
  )
  const packReport = JSON.parse(result.stdout)[0]
  const packedFiles = packReport.files.map((file) => file.path).sort()

  const missing = REQUIRED_PACKAGE_FILES.filter((file) => !packedFiles.includes(file))
  if (missing.length > 0) {
    throw new Error(`published package is missing required files: ${missing.join(', ')}`)
  }

  const digest = createHash('sha256')
  for (const file of packedFiles) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(join(SERVER_DIR, file)))
    digest.update('\0')
  }

  const packageJson = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'))
  packageSummary = {
    name: packageJson.name,
    version: packageJson.version,
    fileCount: packedFiles.length,
    requiredFiles: REQUIRED_PACKAGE_FILES,
    sha256: digest.digest('hex'),
  }
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

function executableAvailable(command) {
  const pathEnv = process.env.PATH ?? ''
  for (const directory of pathEnv.split(process.platform === 'win32' ? ';' : ':')) {
    if (directory && existsSync(join(directory, command))) {
      return true
    }
  }
  return false
}

function writeManifest(status) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true })

  if (existsSync(SMOKE_TRANSCRIPT_PATH)) {
    const transcript = JSON.parse(readFileSync(SMOKE_TRANSCRIPT_PATH, 'utf8'))
    smokeSummary = {
      transcript: 'artifacts/lsp-smoke.json',
      requests: transcript.results,
      degradations: transcript.degradations,
    }
  }

  const manifest = {
    schemaVersion: 1,
    status,
    toolchain: {
      node: process.version,
      pnpm: toolVersion(PNPM, ['--version']),
      npm: toolVersion(NPM, ['--version']),
      platform: process.platform,
      arch: process.arch,
    },
    hostTools: {
      note: 'optional tools on the host PATH; Jest tests that need them self-skip when absent, and the LSP smoke session always runs with an isolated empty PATH',
      shellcheck: executableAvailable('shellcheck') ? 'available' : 'unavailable',
      shfmt: executableAvailable('shfmt') ? 'available' : 'unavailable',
      man: executableAvailable('man') ? 'available' : 'unavailable',
    },
    steps,
    fixtures: fingerprintDirectory(VERIFY_WORKSPACE),
    package: packageSummary,
    lsp: smokeSummary,
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main() {
  let status = 'passed'
  try {
    runStep('install', PNPM, ['install', '--frozen-lockfile'])
    runStep('lint', PNPM, ['lint:bail'])
    runStep('typecheck', PNPM, [
      'exec',
      'tsc',
      '--noEmit',
      '-p',
      'tsconfig.eslint.json',
    ])
    runStep('unit-tests', PNPM, ['exec', 'jest', '--runInBand'])
    runStep('build', PNPM, ['compile'])
    runStep('tree-sitter-wasm', 'node', ['scripts/check-wasm.mjs'])
    runStep('lsp-smoke', 'node', ['scripts/lsp-smoke.mjs'])
    verifyPackageContents()
  } catch (error) {
    status = 'failed'
    console.error(`\nverify:offline failed: ${error.message ?? error}`)
  } finally {
    try {
      writeManifest(status)
      console.log('\nManifest: artifacts/verify-manifest.json')
    } catch (error) {
      console.error(`failed to write the manifest: ${error.message ?? error}`)
      status = 'failed'
    }
  }

  if (status !== 'passed') {
    process.exit(1)
  }
  console.log('\nverify:offline passed')
}

await main()
