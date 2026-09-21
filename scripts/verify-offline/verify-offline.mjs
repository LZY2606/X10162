#!/usr/bin/env node
/* Offline verification entry point.
 *
 * Runs, from a clean checkout with lockfile-pinned dependencies:
 *   1. formatting/lint check
 *   2. type checking
 *   3. unit tests
 *   4. server build (including copied runtime assets)
 *   5. a real stdio LSP smoke session with normalized request/response logs
 *   6. published package content verification (npm pack, no network)
 *
 * Everything must run with pnpm's offline store and exit zero. Optional
 * external tools (ShellCheck, shfmt, man pages) are deliberately absent from
 * the smoke session PATH so protocol-level degradation is asserted. The
 * bundled tree-sitter wasm is mandatory: a missing or incompatible file is a
 * hard failure, never a fallback to a globally installed parser.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listTarEntries } from './lib/tar.mjs'
import {
  normalizeDuration,
  normalizeJson,
  createStringNormalizer,
} from './lib/normalize.mjs'
import { runSmokeSession } from './run-smoke.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const artifactsDir = path.join(repoRoot, 'artifacts')
const manifestPath = path.join(artifactsDir, 'verify-manifest.json')
const transcriptPath = path.join(artifactsDir, 'lsp-session.json')
const packageTarPath = path.join(artifactsDir, 'bash-language-server.tgz')
const wasmPath = path.join(repoRoot, 'server/tree-sitter-bash.wasm')
const parserInfoPath = path.join(repoRoot, 'server/parser.info')
const fixtureDir = path.join(repoRoot, 'testing/offline-fixture')
const FIXTURE_FILES = ['main.sh', 'library.sh']

const startedAt = Date.now()
const stepResults = []

function fail(message) {
  const error = new Error(message)
  error.verificationFailure = true
  throw error
}

async function runStep(name, fn) {
  const begin = Date.now()
  try {
    const result = await fn()
    stepResults.push({
      name,
      status: 'passed',
      duration: normalizeDuration(Date.now() - begin),
    })
    return result
  } catch (error) {
    stepResults.push({
      name,
      status: 'failed',
      duration: normalizeDuration(Date.now() - begin),
      error: error.message.split('\n')[0],
    })
    throw error
  }
}

async function run(command, args, options = {}) {
  const { spawn } = await import('node:child_process')
  const display = [command, ...args].join(' ')
  console.log(`\n$ ${display}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code })
      else reject(new Error(`${display} exited with code ${code}`))
    })
  })
}

async function sha256File(filename) {
  const buffer = await fs.readFile(filename)
  return createHash('sha256').update(buffer).digest('hex')
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function toolOnPath(tool) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  return dirs.some((dir) => existsSync(path.join(dir, tool)))
}

function readVersion(output) {
  const match = String(output)
    .trim()
    .match(/v?(\d+\.\d+\.\d+[^\s]*)/)
  return match ? match[1] : String(output).trim()
}

async function main() {
  await fs.rm(artifactsDir, { recursive: true, force: true })
  await fs.mkdir(artifactsDir, { recursive: true })

  console.log('==> Offline verification starting (network access disabled)')

  const nodeVersion = (await run(process.execPath, ['--version'])).stdout
  const pnpmVersion = (await run('pnpm', ['--version'])).stdout
  const versions = {
    node: readVersion(nodeVersion),
    pnpm: readVersion(pnpmVersion),
    platform: process.platform,
    arch: process.arch,
  }

  // 0. Lockfile-pinned dependency install from the offline store. In CI the
  //    store is warmed by an explicit preceding `pnpm install
  //    --frozen-lockfile`; a machine without the packages must fail loudly
  //    instead of silently downloading anything.
  if (!process.env.VERIFY_OFFLINE_SKIP_INSTALL) {
    await runStep('install-frozen-offline', () =>
      run('pnpm', ['install', '--frozen-lockfile', '--offline']),
    )
  }

  // 1. Formatting and lint (no autofix; standards are not lowered).
  await runStep('lint', () => run('pnpm', ['lint:bail']))

  // 2. Type checking of every checked-in TypeScript project.
  await runStep('typecheck', () =>
    run('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.eslint.json']),
  )

  // 3. Unit tests (full existing suite; the server is not mocked here).
  await runStep('unit-tests', () => run('pnpm', ['exec', 'jest', '--runInBand']))

  // 4. Server build. `compile` also copies get-options.sh into out/.
  await runStep('build-server', () => run('pnpm', ['compile']))

  await runStep('verify-assets', verifyBuiltAssets)
  const wasmInfo = await runStep('verify-wasm', verifyWasm)

  // 5. Real stdio LSP smoke session with optional tools isolated.
  const smoke = await runStep('lsp-smoke-session', () => runSmokeSession({ repoRoot }))
  await persistSmokeArtifacts(smoke)

  // 6. Published package content verification.
  const packageInfo = await runStep('verify-package', verifyPackage)

  await writeManifest({ versions, smoke, packageInfo })

  console.log(`\n==> Offline verification passed in ${Date.now() - startedAt}ms`)
  console.log(`==> Manifest: ${path.relative(repoRoot, manifestPath)}`)
}

async function writeManifest({ versions, smoke, packageInfo }) {
  const normalizeString = createStringNormalizer({
    repoRoot,
    fixtureDir: smoke.fixtureDir,
    tmpDir: smoke.tmpDir,
    pidHints: [smoke.serverPid, process.pid].filter(Boolean),
  })

  const fixtureFingerprints = {}
  for (const name of FIXTURE_FILES) {
    const absolute = path.join(fixtureDir, name)
    fixtureFingerprints[name] = {
      size: (await fs.stat(absolute)).size,
      sha256: await sha256File(absolute),
    }
  }

  // Degradation is asserted from the recorded protocol behavior: the optional
  // capability answers successfully in its degraded form and the remaining
  // requests all pass.
  const degradation = [
    {
      capability: 'diagnostics (ShellCheck)',
      optionalTool: 'shellcheck',
      hostHasTool: toolOnPath('shellcheck'),
      isolated: true,
      behavior:
        'smoke session PATH contains only an empty directory; no published diagnostic has source "shellcheck" and analyzer diagnostics are still delivered',
    },
    {
      capability: 'document formatting (shfmt)',
      optionalTool: 'shfmt',
      hostHasTool: toolOnPath('shfmt'),
      isolated: true,
      behavior:
        'textDocument/formatting resolves successfully with an empty edit list instead of erroring',
    },
    {
      capability: 'hover documentation (external man/help pages)',
      optionalTool: 'bash/man/col',
      hostHasTool: toolOnPath('man'),
      isolated: true,
      behavior:
        'textDocument/hover on an external command resolves successfully with result null when no shell or man page reader is on PATH',
    },
    {
      capability: 'explainshell (network)',
      optionalTool: 'explainshell endpoint',
      hostHasTool: null,
      isolated: true,
      behavior:
        'explainshellEndpoint defaults to an empty string, so hover never performs a network request; pnpm install runs with --offline',
    },
  ]

  const assertionsByRequest = smoke.assertions.reduce((acc, assertion) => {
    const [request] = assertion.name.split('.')
    ;(acc[request] ??= []).push(assertion.name)
    return acc
  }, {})
  const requestResults = smoke.steps.map((step) => ({
    request: step.name,
    duration: normalizeDuration(step.durationMs),
    assertions: assertionsByRequest[step.name] ?? 'request completed',
  }))

  const failedAssertions = smoke.assertions.filter((assertion) => !assertion.passed)
  if (failedAssertions.length > 0) {
    fail(`smoke assertions failed: ${failedAssertions.map((a) => a.name).join(', ')}`)
  }

  const manifest = normalizeJson(
    {
      schemaVersion: 1,
      command: 'pnpm run verify:offline',
      versions,
      dependencyInstall: {
        command: 'pnpm install --frozen-lockfile --offline',
        skipped: !!process.env.VERIFY_OFFLINE_SKIP_INSTALL,
      },
      steps: stepResults,
      bundledWasm: wasmInfo?.result ?? null,
      fixtureFingerprints,
      lspSession: {
        transcript: 'artifacts/lsp-session.json',
        fixtureUris: smoke.fixture.uris,
        serverPidNormalized: true,
        requestResults,
        assertions: smoke.assertions.map((assertion) => ({
          name: assertion.name,
          passed: assertion.passed,
        })),
        degradation,
      },
      package: {
        name: packageInfo.name,
        version: packageInfo.version,
        bin: packageInfo.bin,
        main: packageInfo.main,
        tarball: packageInfo.tarball,
        tarballSize: packageInfo.tarballSize,
        entryCount: packageInfo.entryCount,
        entries: packageInfo.entries,
      },
      result: 'passed',
    },
    normalizeString,
  )

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

main().catch(async (error) => {
  const partial = {
    schemaVersion: 1,
    command: 'pnpm run verify:offline',
    result: 'failed',
    failure: error.message,
    steps: stepResults,
  }
  await fs
    .mkdir(artifactsDir, { recursive: true })
    .then(() => fs.writeFile(manifestPath, `${JSON.stringify(partial, null, 2)}\n`))
    .catch(() => {})
  console.error(`\nverify:offline failed: ${error.stack ?? error.message}`)
  if (error.smokeContext) {
    console.error('--- server log ---')
    console.error(error.smokeContext.logMessages.join('\n'))
    console.error('--- server stderr ---')
    console.error(error.smokeContext.stderr)
  }
  process.exitCode = 1
})

async function verifyBuiltAssets() {
  const required = [
    'server/out/cli.js',
    'server/out/server.js',
    'server/out/analyser.js',
    'server/out/parser.js',
    'server/out/server.d.ts',
    'server/out/get-options.sh',
  ]
  for (const relative of required) {
    const absolute = path.join(repoRoot, relative)
    if (!existsSync(absolute)) fail(`expected build output is missing: ${relative}`)
  }

  // The compiled entry must remain the documented CLI/protocol entry point.
  const cli = await fs.readFile(path.join(repoRoot, 'server/out/cli.js'), 'utf8')
  if (!cli.includes('StreamMessageReader') || !cli.includes('StreamMessageWriter')) {
    fail('server/out/cli.js is no longer the stdio LSP entry point')
  }
}

async function verifyWasm() {
  if (!existsSync(wasmPath)) {
    fail(
      'bundled server/tree-sitter-bash.wasm is missing; the parser may not ' +
        'fall back to a globally installed grammar',
    )
  }

  const wasmBuffer = await fs.readFile(wasmPath)
  const wasmHash = sha256Buffer(wasmBuffer)
  const serverPackage = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'server/package.json'), 'utf8'),
  )
  const parserInfo = await fs.readFile(parserInfoPath, 'utf8')
  const infoVersion = parserInfo.match(/tree-sitter-cli "([^"]+)"/)?.[1] ?? null

  // The runtime actually loads the wasm during the smoke session; this is an
  // early, explicit failure with a precise message when it cannot parse.
  await WebAssembly.compile(wasmBuffer).catch((error) => {
    fail(`bundled tree-sitter wasm is not a valid WebAssembly module: ${error.message}`)
  })

  return {
    path: 'server/tree-sitter-bash.wasm',
    size: wasmBuffer.length,
    sha256: wasmHash,
    parserInfoVersion: infoVersion,
    webTreeSitterDependency: serverPackage.dependencies['web-tree-sitter'],
  }
}

async function persistSmokeArtifacts(smoke) {
  const normalizeString = createStringNormalizer({
    repoRoot,
    fixtureDir: smoke.fixtureDir,
    tmpDir: smoke.tmpDir,
    pidHints: [smoke.serverPid, process.pid].filter(Boolean),
  })

  const normalizedTranscript = normalizeJson(smoke.transcript, normalizeString)
  const session = {
    schemaVersion: 1,
    description:
      'Normalized LSP stdio session captured by pnpm run verify:offline. ' +
      'Request and response payloads are recorded in full; only machine-specific ' +
      'paths, process ids and timing are rewritten.',
    fixtureUris: normalizeJson(smoke.fixture.uris, normalizeString),
    steps: smoke.steps.map((step) => ({
      name: step.name,
      duration: normalizeDuration(step.durationMs),
    })),
    assertions: smoke.assertions.map(({ name, passed, detail }) => ({
      name,
      passed,
      detail: detail === null ? null : normalizeString(detail),
    })),
    transcript: normalizedTranscript,
    serverLog: smoke.logMessages.map(normalizeString),
    serverStderr: smoke.stderr ? normalizeString(smoke.stderr) : null,
  }
  await fs.writeFile(transcriptPath, `${JSON.stringify(session, null, 2)}\n`)
}

async function verifyPackage() {
  const extractEntryBuffer = (buffer, entryName) => {
    const entry = listTarEntries(buffer).find((candidate) => candidate.name === entryName)
    if (!entry) fail(`packed tarball does not contain ${entryName}`)
    return entry.content
  }

  // Pack the server workspace without any network access.
  await fs.rm(packageTarPath, { force: true })
  await run('pnpm', ['pack', '--pack-destination', artifactsDir], {
    cwd: path.join(repoRoot, 'server'),
  })

  const packedFiles = (await fs.readdir(artifactsDir)).filter((name) =>
    name.endsWith('.tgz'),
  )
  if (packedFiles.length !== 1) {
    fail(
      `expected exactly one packed tarball in artifacts/, found: ${packedFiles.join(
        ', ',
      )}`,
    )
  }
  const packedName = packedFiles[0]
  const producedPath = path.join(artifactsDir, packedName)
  if (path.resolve(producedPath) !== path.resolve(packageTarPath)) {
    await fs.rename(producedPath, packageTarPath)
  }

  const tarBuffer = await fs.readFile(packageTarPath)
  const entries = listTarEntries(tarBuffer).map((entry) => ({
    path: entry.name,
    size: entry.content.length,
    sha256: sha256Buffer(entry.content),
  }))
  entries.sort((a, b) => a.path.localeCompare(b.path))

  const entryPaths = new Set(entries.map((entry) => entry.path))
  const requiredEntries = [
    'package.json',
    'out/cli.js',
    'out/server.js',
    'out/parser.js',
    'out/get-options.sh',
    'tree-sitter-bash.wasm',
  ]
  for (const required of requiredEntries) {
    if (!entryPaths.has(required)) {
      fail(`published package is missing required entry: ${required}`)
    }
  }

  const forbiddenEntries = entries
    .map((entry) => entry.path)
    .filter(
      (name) =>
        name.startsWith('src/') ||
        name.startsWith('__tests__') ||
        name.includes('/__tests__/') ||
        (!name.startsWith('out/') && name.endsWith('.ts')),
    )
  if (forbiddenEntries.length > 0) {
    fail(
      `published package unexpectedly contains source/test files: ${forbiddenEntries.join(
        ', ',
      )}`,
    )
  }

  const packageJsonEntry = entries.find((entry) => entry.path === 'package.json')
  if (!packageJsonEntry) fail('packed tarball does not contain package.json')
  const packedPackageJson = JSON.parse(
    extractEntryBuffer(tarBuffer, 'package/package.json').toString('utf8'),
  )

  const serverPackage = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'server/package.json'), 'utf8'),
  )
  if (packedPackageJson.name !== serverPackage.name) {
    fail('packed package.json name does not match server/package.json')
  }
  if (packedPackageJson.version !== serverPackage.version) {
    fail('packed package.json version does not match server/package.json')
  }

  return {
    tarball: `artifacts/${path.basename(packageTarPath)}`,
    tarballSize: tarBuffer.length,
    name: packedPackageJson.name,
    version: packedPackageJson.version,
    bin: packedPackageJson.bin ?? null,
    main: packedPackageJson.main ?? null,
    entryCount: entries.length,
    entries,
  }
}
