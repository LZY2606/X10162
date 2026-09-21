#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Offline verification pipeline entry point.
 *
 * From a clean checkout (after `pnpm install --frozen-lockfile`) this runs, in
 * order: formatting/lint, type checking, unit tests, the server build, the
 * tree-sitter wasm ownership check, a real stdio LSP smoke session against the
 * in-repo workspace (with ShellCheck/shfmt/man isolated out), and publishable
 * package content verification. Everything is produced into artifacts/.
 *
 * Demonstration: `pnpm run verify:offline` (exits 0 and never downloads tools).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = process.env.VERIFY_REPO_ROOT || process.cwd()
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts')
const SERVER_DIR = join(REPO_ROOT, 'server')
const FIXTURE_WORKSPACE = join(REPO_ROOT, 'testing', 'verify-workspace')
const MANIFEST_PATH = join(ARTIFACTS_DIR, 'verify-manifest.json')

function log(message) {
  console.log(`\n▶ ${message}`)
}

function runStep(name, { command, args, env, cwd, allowFailure = false }) {
  const stepStarted = Date.now()
  const result = spawnSync(command, args, {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  const step = {
    name,
    command: [command, ...args].join(' '),
    exitCode: result.status,
    signal: result.signal,
    durationMs: 0,
    ok: result.status === 0,
  }
  step.durationMs = Date.now() - stepStarted
  if (!step.ok && !allowFailure) {
    console.error(`✖ ${name} failed (exit ${result.status ?? result.signal})`)
    throw new Error(`${name} failed (exit ${result.status ?? result.signal})`)
  }
  console.log(`  ✓ ${name} (${step.durationMs} ms)`)
  return step
}

function toolVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim().split('\n')[0] || null
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function walk(directory) {
  const entries = []
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules') continue
    const full = join(directory, name)
    const stat = statSync(full)
    if (stat.isDirectory()) entries.push(...walk(full))
    else entries.push(full)
  }
  return entries
}

function fixtureFingerprint() {
  return walk(FIXTURE_WORKSPACE)
    .map((path) => ({
      path: relative(FIXTURE_WORKSPACE, path).split('\\').join('/'),
      size: statSync(path).size,
      sha256: sha256OfFile(path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function readReport(filename) {
  const path = join(ARTIFACTS_DIR, filename)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function detectOptionalTools() {
  const probes = [
    ['shellcheck', ['shellcheck', ['--version']]],
    ['shfmt', ['shfmt', ['--version']]],
    ['man', ['man', ['--version']]],
    ['col', ['col', ['-V']]],
    ['bash', ['bash', ['--version']]],
  ]
  const detected = {}
  for (const [name, [command, args]] of probes) {
    detected[name] = toolVersion(command, args)
  }
  return detected
}

function writeManifest(steps, ok) {
  const lspReport = readReport('lsp-report.json')
  const packageReport = readReport('package-report.json')
  const wasmReport = readReport('wasm-report.json')

  const nodeVersion = process.versions.node
  const pnpmVersion = toolVersion('pnpm', ['--version'])
  const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const serverPackage = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'))

  const degradation = [
    {
      capability: 'shellcheck-diagnostics',
      isolated: true,
      toolAvailableOnHost: Boolean(detectOptionalToolsCached.shellcheck),
      expected:
        'no diagnostics with source "shellcheck"; tree-sitter diagnostics unaffected',
      observed: lspReport?.assertions?.find(
        (assertion) =>
          assertion.name ===
          'diagnostics carry no ShellCheck source without shellcheck on PATH',
      )?.ok
        ? 'no shellcheck diagnostics published'
        : 'unexpected shellcheck diagnostics',
      status: lspReport?.assertions?.find(
        (assertion) =>
          assertion.name ===
          'diagnostics carry no ShellCheck source without shellcheck on PATH',
      )?.ok
        ? 'degraded-as-expected'
        : 'unexpected',
    },
    {
      capability: 'shfmt-formatting',
      isolated: true,
      toolAvailableOnHost: Boolean(detectOptionalToolsCached.shfmt),
      expected: 'textDocument/formatting returns no edits',
      observed: lspReport?.assertions?.find((assertion) =>
        assertion.name.startsWith('formatting degrades'),
      )?.detail,
      status: lspReport?.assertions?.find((assertion) =>
        assertion.name.startsWith('formatting degrades'),
      )?.ok
        ? 'degraded-as-expected'
        : 'unexpected',
    },
    {
      capability: 'man-page-hover',
      isolated: true,
      toolAvailableOnHost: Boolean(detectOptionalToolsCached.man),
      expected: 'hover over an external command resolves to null',
      observed: lspReport?.assertions?.find((assertion) =>
        assertion.name.startsWith('hover degrades'),
      )?.detail,
      status: lspReport?.assertions?.find((assertion) =>
        assertion.name.startsWith('hover degrades'),
      )?.ok
        ? 'degraded-as-expected'
        : 'unexpected',
    },
    {
      capability: 'explainshell-network',
      isolated: true,
      toolAvailableOnHost: false,
      expected: 'hover request succeeds (null) with the endpoint unreachable',
      observed: lspReport?.assertions?.find((assertion) =>
        assertion.name.includes('explainshell'),
      )?.detail,
      status: lspReport?.assertions?.find((assertion) =>
        assertion.name.includes('explainshell'),
      )?.ok
        ? 'degraded-as-expected'
        : 'unexpected',
    },
  ]

  const manifest = {
    schemaVersion: 1,
    command: 'pnpm run verify:offline',
    status: ok ? 'passed' : 'failed',
    environment: {
      node: nodeVersion,
      pnpm: pnpmVersion,
      packageManager: rootPackage.packageManager,
      platform: process.platform,
      arch: process.arch,
      offlineInstall: 'pnpm install --frozen-lockfile',
      optionalToolsOnHost: detectOptionalToolsCached,
    },
    server: {
      name: serverPackage.name,
      version: serverPackage.version,
      bin: serverPackage.bin,
      main: serverPackage.main,
    },
    steps: steps.map((step) => ({
      name: step.name,
      command: step.command,
      ok: step.ok,
      exitCode: step.exitCode,
      signal: step.signal,
      // Durations are deliberately not recorded: they would make the manifest
      // non-reproducible. Timing stays in human-readable console output.
    })),
    fixtureWorkspace: {
      path: 'testing/verify-workspace',
      files: fixtureFingerprint(),
    },
    wasm: wasmReport
      ? {
          path: wasmReport.wasmPath,
          sha256: wasmReport.sha256,
          size: wasmReport.size,
          parserInfo: wasmReport.parserInfo,
          loadedSuccessfully: wasmReport.loadedSuccessfully,
          failures: wasmReport.failures,
        }
      : null,
    package: packageReport
      ? {
          name: packageReport.name,
          version: packageReport.version,
          filename: packageReport.filename,
          unpackedSize: packageReport.unpackedSize,
          fileCount: packageReport.fileCount,
          requiredContent: packageReport.requiredContent,
          failures: packageReport.failures,
        }
      : null,
    lsp: lspReport
      ? {
          transcript: 'artifacts/lsp-session.json',
          serverMessages: 'artifacts/lsp-server-messages.json',
          exitCode: lspReport.exitCode,
          requests: lspReport.assertions,
          degradation,
        }
      : null,
  }

  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

const detectOptionalToolsCached = detectOptionalTools()

function main() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const steps = []
  const nodeStep = (name, args, env) =>
    runStep(name, {
      command: process.execPath,
      args,
      env: { VERIFY_ARTIFACTS_DIR: ARTIFACTS_DIR, VERIFY_REPO_ROOT: REPO_ROOT, ...env },
    })

  try {
    log('1/8 lockfile consistency (pnpm install --frozen-lockfile, offline)')
    if (existsSync(join(REPO_ROOT, 'node_modules'))) {
      steps.push(
        runStep('verify-frozen-lockfile', {
          command: 'pnpm',
          args: ['install', '--frozen-lockfile', '--offline'],
        }),
      )
    } else {
      steps.push(
        runStep('install-frozen-lockfile', {
          command: 'pnpm',
          args: ['install', '--frozen-lockfile', '--offline'],
        }),
      )
    }

    log('2/8 formatting and lint (no autofix)')
    steps.push(runStep('lint', { command: 'pnpm', args: ['run', 'lint:bail'] }))

    log('3/8 type checking')
    steps.push(
      runStep('typecheck', {
        command: 'pnpm',
        args: ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.eslint.json'],
      }),
    )

    log('4/8 unit tests')
    steps.push(
      runStep('unit-tests', {
        command: 'pnpm',
        args: ['exec', 'jest', '--runInBand'],
      }),
    )

    log('5/8 server build')
    steps.push(
      runStep('build-server', { command: 'pnpm', args: ['run', 'compile'] }),
    )

    log('6/8 bundled tree-sitter wasm ownership/version check')
    steps.push(nodeStep('check-wasm', ['scripts/verify/check-wasm.mjs']))

    log('7/8 stdio LSP smoke session (optional tools isolated)')
    steps.push(
      nodeStep('lsp-smoke-session', ['scripts/verify/lsp-smoke-session.mjs']),
    )

    log('8/8 publishable package content verification')
    steps.push(nodeStep('check-package', ['scripts/verify/check-package.mjs']))

    writeManifest(steps, true)
    console.log('\nverify:offline completed successfully')
    console.log('Manifest: artifacts/verify-manifest.json')
  } catch (error) {
    writeManifest(steps, false)
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    console.error('verify:offline failed; manifest: artifacts/verify-manifest.json')
    process.exit(1)
  }
}

main()
