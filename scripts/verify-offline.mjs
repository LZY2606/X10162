#!/usr/bin/env node
/**
 * Offline verification entry point: `pnpm run verify:offline`.
 *
 * From a clean checkout with locked dependencies, runs in order:
 *   1. install   pnpm install --frozen-lockfile
 *   2. lint      format + lint check (no autofix)
 *   3. test      typecheck + unit tests (Jest)
 *   4. build     compile the server (and VS Code client)
 *   5. wasm      verify the in-repo tree-sitter wasm exists and its ABI
 *                matches server/parser.info (never falls back to a global
 *                install — a missing or mismatched wasm fails the run)
 *   6. smoke     real stdio LSP session against the compiled server with an
 *                isolated PATH (no ShellCheck/shfmt/man), saving normalized
 *                request/response JSON under artifacts/lsp-smoke/
 *   7. pack      verify the publishable package contents
 *
 * Writes artifacts/verify-manifest.json with tool versions, package and
 * fixture fingerprints, per-request LSP results and degradation reasons.
 * The manifest is deterministic: no absolute paths, timestamps, durations
 * or process ids.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts')
const MANIFEST_PATH = path.join(ARTIFACTS_DIR, 'verify-manifest.json')
const WASM_PATH = path.join(REPO_ROOT, 'server', 'tree-sitter-bash.wasm')
const PARSER_INFO_PATH = path.join(REPO_ROOT, 'server', 'parser.info')
const FIXTURES_DIR = path.join(REPO_ROOT, 'testing', 'fixtures')

const REQUIRED_PACKAGE_ENTRIES = [
  'package/package.json',
  'package/README.md',
  'package/out/cli.js',
  'package/out/server.js',
  'package/out/get-options.sh',
  'package/tree-sitter-bash.wasm',
]

const steps = []

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

async function runStep(name, fn) {
  console.log(`\n=== verify:offline — ${name} ===`)
  let result
  try {
    result = await fn()
  } catch (error) {
    steps.push({ name, status: 'failed' })
    throw error
  }
  steps.push({ name, status: 'passed' })
  return result
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  }
}

/** Fingerprint the fixture workspace: sorted "hash path" lines, symlink aware. */
function fingerprintFixtures() {
  const lines = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(FIXTURES_DIR, full).split(path.sep).join('/')
      if (entry.isSymbolicLink()) {
        lines.push(`link ${rel} -> ${fs.readlinkSync(full)}`)
      } else if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        lines.push(`${sha256(fs.readFileSync(full))}  ${rel}`)
      }
    }
  }
  walk(FIXTURES_DIR)
  lines.sort()
  return {
    root: 'testing/fixtures',
    fileCount: lines.length,
    sha256: sha256(lines.join('\n')),
  }
}

/** The bundled wasm must exist in-repo and match the ABI in parser.info. */
function checkWasm() {
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(
      'server/tree-sitter-bash.wasm is missing; the bundled parser is required ' +
        '(no fallback to globally installed grammars is allowed)',
    )
  }
  const parserInfo = fs.readFileSync(PARSER_INFO_PATH, 'utf8')
  const abiMatch = /^parser ABI (\d+)$/m.exec(parserInfo)
  if (!abiMatch) {
    throw new Error('server/parser.info does not declare a "parser ABI" version')
  }
  const expectedAbiVersion = Number(abiMatch[1])

  // Guard against silently resolving the grammar from anywhere but the repo.
  const compiledParser = fs.readFileSync(
    path.join(REPO_ROOT, 'server', 'out', 'parser.js'),
    'utf8',
  )
  if (!compiledParser.includes('../tree-sitter-bash.wasm')) {
    throw new Error('server/out/parser.js does not load the in-repo tree-sitter-bash.wasm')
  }

  const serverRequire = createRequire(path.join(REPO_ROOT, 'server', 'package.json'))
  const { Parser, Language } = serverRequire('web-tree-sitter')
  return Promise.resolve()
    .then(() => Parser.init())
    .then(async () => {
      const language = await Language.load(fs.readFileSync(WASM_PATH))
      if (language.abiVersion !== expectedAbiVersion) {
        throw new Error(
          `tree-sitter-bash.wasm ABI ${language.abiVersion} does not match ` +
            `server/parser.info (parser ABI ${expectedAbiVersion}); ` +
            'run scripts/upgrade-tree-sitter.sh to realign them',
        )
      }
      return {
        path: 'server/tree-sitter-bash.wasm',
        sha256: sha256(fs.readFileSync(WASM_PATH)),
        abiVersion: language.abiVersion,
        expectedAbiVersion,
      }
    })
}

/** Pack the server and verify the publishable contents. */
function checkPackage() {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bls-offline-pack-'))
  try {
    const output = execFileSync('npm', ['pack', '--pack-destination', packDir, '--json'], {
      cwd: path.join(REPO_ROOT, 'server'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const packResult = JSON.parse(output.slice(output.indexOf('[')))
    const tarball = path.join(packDir, packResult[0].filename)

    const extractDir = path.join(packDir, 'extracted')
    fs.mkdirSync(extractDir)
    execFileSync('tar', ['-xzf', tarball, '-C', extractDir], { stdio: 'inherit' })

    const files = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          files.push(full)
        }
      }
    }
    walk(extractDir)

    const lines = files
      .map((file) => {
        const rel = path.relative(extractDir, file).split(path.sep).join('/')
        return `${sha256(fs.readFileSync(file))}  ${rel}`
      })
      .sort()
    const entries = lines.map((line) => line.slice(line.indexOf('  ') + 2))

    const missing = REQUIRED_PACKAGE_ENTRIES.filter(
      (entry) => !entries.includes(entry),
    )
    if (missing.length > 0) {
      throw new Error(`package tarball is missing required entries: ${missing.join(', ')}`)
    }

    return {
      fileCount: entries.length,
      sha256: sha256(lines.join('\n')),
      requiredEntries: REQUIRED_PACKAGE_ENTRIES,
    }
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true })
  }
}

function getPnpmVersion() {
  return execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
}

function writeManifest(manifest) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main() {
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='))
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null
  const shouldRun = (name) => !only || only.includes(name)

  const manifest = {
    schemaVersion: 1,
    tool: { node: process.version, pnpm: getPnpmVersion() },
    steps,
  }

  try {
    if (shouldRun('install'))
      await runStep('install', () => runCommand('pnpm', ['install', '--frozen-lockfile']))
    if (shouldRun('lint')) await runStep('lint', () => runCommand('pnpm', ['lint:bail']))
    if (shouldRun('test')) await runStep('test', () => runCommand('pnpm', ['run', 'test']))
    if (shouldRun('build')) await runStep('build', () => runCommand('pnpm', ['compile']))

    manifest.fixtures = fingerprintFixtures()
    if (shouldRun('wasm')) manifest.wasm = await runStep('wasm', () => checkWasm())

    if (shouldRun('smoke')) {
      await runStep('smoke', () =>
        runCommand(process.execPath, [
          path.join(REPO_ROOT, 'scripts', 'verify-offline-lsp-smoke.mjs'),
          '--out-dir',
          path.join(ARTIFACTS_DIR, 'lsp-smoke'),
        ]),
      )
      const smokeSummary = JSON.parse(
        fs.readFileSync(path.join(ARTIFACTS_DIR, 'lsp-smoke', 'summary.json'), 'utf8'),
      )
      manifest.lsp = {
        workspace: smokeSummary.workspace,
        artifactsDir: 'artifacts/lsp-smoke',
        requests: smokeSummary.requests,
        degradations: smokeSummary.degradations,
      }
    }

    if (shouldRun('pack')) manifest.package = await runStep('pack', () => checkPackage())
  } catch (error) {
    writeManifest(manifest)
    console.error(`\nverify:offline FAILED: ${error.message || error}`)
    process.exit(1)
  }

  writeManifest(manifest)
  console.log(`\nverify:offline passed — manifest written to ${MANIFEST_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
