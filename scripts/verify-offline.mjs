#!/usr/bin/env node
/**
 * `pnpm run verify:offline` — offline end-to-end verification.
 *
 * Runs, in order, from a checkout with lockfile-installed dependencies:
 *   1. preflight: the bundled server/tree-sitter-bash.wasm exists and its ABI
 *      matches server/parser.info (never falls back to a global install)
 *   2. format & lint check (no autofix)
 *   3. typecheck
 *   4. unit tests (suites that require ShellCheck/shfmt/man are excluded here
 *      and stay covered by the external-tools CI job)
 *   5. server build
 *   6. a real stdio LSP smoke session against testing/verify-workspace
 *   7. publish package content verification
 *
 * Steps 2-6 run with an isolated PATH (core POSIX utilities + node only) so
 * ShellCheck, shfmt, man and network tools are guaranteed to be absent; the
 * smoke session asserts the corresponding protocol-level degradation.
 *
 * Writes artifacts/verify-manifest.json and artifacts/lsp-smoke-session.json.
 * The manifest is deterministic: stable ordering, no absolute paths, no
 * timestamps.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSmokeSession } from './verify-offline/lsp-smoke.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts')
const MANIFEST_PATH = path.join(ARTIFACTS_DIR, 'verify-manifest.json')
const TRANSCRIPT_PATH = path.join(ARTIFACTS_DIR, 'lsp-smoke-session.json')
const WORKSPACE_DIR = path.join(REPO_ROOT, 'testing', 'verify-workspace')
const WASM_PATH = path.join(REPO_ROOT, 'server', 'tree-sitter-bash.wasm')
const PARSER_INFO_PATH = path.join(REPO_ROOT, 'server', 'parser.info')

// Test suites that require external tools (ShellCheck, shfmt, man). They are
// excluded from the offline unit-test run and remain covered by the
// external-tools CI job, which installs the tools and runs the full suite.
const TOOL_DEPENDENT_TEST_SUITES = [
  'server/src/__tests__/server\\.test\\.ts',
  'server/src/__tests__/absolute-hover\\.test\\.ts',
  'server/src/util/__tests__/sh\\.test\\.ts',
  'server/src/shellcheck/__tests__/index\\.test\\.ts',
  'server/src/shellcheck/__tests__/code-actions\\.test\\.ts',
  'server/src/shfmt/__tests__/index\\.test\\.ts',
]

// Core utilities kept on the isolated PATH. Notably absent: shellcheck,
// shfmt, man, col, curl, wget, git.
const ISOLATED_PATH_TOOLS = [
  'node',
  'sh',
  'bash',
  'env',
  'cat',
  'cp',
  'uname',
  'basename',
  'dirname',
  'printf',
  'sleep',
  'ls',
  'mkdir',
  'rm',
  'chmod',
  'sed',
  'grep',
  'head',
  'tail',
  'wc',
  'tr',
  'awk',
  'ps',
  'kill',
  'touch',
  'id',
  'xargs',
]

const REQUIRED_PACKAGE_FILES = [
  'package.json',
  'out/cli.js',
  'out/server.js',
  'out/get-options.sh',
  'tree-sitter-bash.wasm',
]

function fail(message) {
  throw new Error(message)
}

function sha256OfFiles(entries) {
  // entries: [{ name, content }] — order-independent, sorted by name.
  const hash = crypto.createHash('sha256')
  for (const { name, content } of [...entries].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    hash.update(name)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function findOnPath(tool, pathEnv) {
  for (const dir of pathEnv.split(path.delimiter)) {
    const candidate = path.join(dir, tool)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

function buildIsolatedEnvironment() {
  const originalPath = process.env.PATH || ''
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-offline-bin-'))
  const missing = []
  for (const tool of ISOLATED_PATH_TOOLS) {
    const resolved = findOnPath(tool, originalPath)
    if (resolved) {
      fs.symlinkSync(resolved, path.join(binDir, tool))
    } else if (tool === 'node' || tool === 'sh') {
      missing.push(tool)
    }
  }
  if (missing.length > 0) {
    fail(`cannot build isolated environment: missing required tools: ${missing}`)
  }
  const env = {
    PATH: binDir,
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { env, binDir }
}

function resolvePnpm() {
  const execPath = process.env.npm_execpath
  if (execPath && /pnpm.*\.(cjs|js)$/.test(execPath) && fs.existsSync(execPath)) {
    return { command: process.execPath, prefixArgs: [execPath] }
  }
  const onPath = findOnPath('pnpm', process.env.PATH || '')
  if (onPath) {
    const real = fs.realpathSync(onPath)
    if (/\.(cjs|js)$/.test(real)) {
      return { command: process.execPath, prefixArgs: [real] }
    }
    return { command: onPath, prefixArgs: [] }
  }
  fail('could not locate pnpm; run via `pnpm run verify:offline`')
}

function runCommand(label, command, args, env) {
  console.log(`\n[verify:offline] ${label}: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  })
  if (result.error) {
    fail(`${label}: failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`${label}: exited with status ${result.status}`)
  }
}

function checkBundledWasm() {
  console.log('\n[verify:offline] wasm:check — validating bundled tree-sitter-bash.wasm')
  if (!fs.existsSync(WASM_PATH)) {
    fail(
      'server/tree-sitter-bash.wasm is missing. The language server only uses ' +
        'the repository-bundled parser; install/restore it instead of relying ' +
        'on a globally installed tree-sitter.',
    )
  }
  const parserInfo = fs.readFileSync(PARSER_INFO_PATH, 'utf8')
  const declaredMatch = /parser ABI (\d+)/.exec(parserInfo)
  if (!declaredMatch) {
    fail('server/parser.info does not declare a "parser ABI <n>" line')
  }
  const declaredAbi = Number(declaredMatch[1])

  const require = createRequire(path.join(REPO_ROOT, 'server', 'package.json'))
  const { Parser, Language } = require('web-tree-sitter')
  const wasmBytes = fs.readFileSync(WASM_PATH)
  return (async () => {
    await Parser.init()
    let loaded
    try {
      loaded = await Language.load(wasmBytes)
    } catch (error) {
      fail(
        `bundled tree-sitter-bash.wasm is incompatible with the bundled ` +
          `web-tree-sitter runtime: ${error.message}`,
      )
    }
    const actualAbi = loaded.abiVersion
    if (actualAbi !== declaredAbi) {
      fail(
        `tree-sitter ABI mismatch: server/parser.info declares ABI ${declaredAbi} ` +
          `but server/tree-sitter-bash.wasm reports ABI ${actualAbi}. ` +
          'Run scripts/upgrade-tree-sitter.sh to regenerate them together.',
      )
    }
    console.log(
      `[verify:offline] wasm:check — ABI ${actualAbi} matches server/parser.info`,
    )
    return {
      path: 'server/tree-sitter-bash.wasm',
      sha256: crypto.createHash('sha256').update(wasmBytes).digest('hex'),
      declaredAbiVersion: declaredAbi,
      abiVersion: actualAbi,
    }
  })()
}

function fingerprintFixtures() {
  const files = fs
    .readdirSync(WORKSPACE_DIR)
    .filter((name) => fs.statSync(path.join(WORKSPACE_DIR, name)).isFile())
    .sort()
  if (files.length === 0) {
    fail('testing/verify-workspace is empty')
  }
  const entries = files.map((name) => ({
    name,
    content: fs.readFileSync(path.join(WORKSPACE_DIR, name)),
  }))
  return {
    workspace: 'testing/verify-workspace',
    files,
    contentSha256: sha256OfFiles(entries),
  }
}

function verifyPackageContents(originalEnv) {
  console.log('\n[verify:offline] pack:verify — checking publish package contents')
  const npmPath = findOnPath('npm', process.env.PATH || '')
  if (!npmPath) {
    fail('npm is required for `npm pack --dry-run` but was not found on PATH')
  }
  const result = spawnSync(npmPath, ['pack', '--dry-run', '--json'], {
    cwd: path.join(REPO_ROOT, 'server'),
    env: originalEnv,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    fail(`npm pack --dry-run failed:\n${result.stderr}`)
  }
  let packInfo
  try {
    packInfo = JSON.parse(result.stdout)
  } catch {
    fail(`could not parse npm pack --dry-run output:\n${result.stdout}`)
  }
  const entry = Array.isArray(packInfo) ? packInfo[0] : packInfo
  const files = (entry.files || []).map((file) => file.path).sort()
  const missing = REQUIRED_PACKAGE_FILES.filter((name) => !files.includes(name))
  if (missing.length > 0) {
    fail(
      `publish package is missing required files: ${missing.join(', ')}. ` +
        'Did the server build step run?',
    )
  }
  const serverDir = path.join(REPO_ROOT, 'server')
  const contentSha256 = sha256OfFiles(
    files.map((name) => ({
      name,
      content: fs.readFileSync(path.join(serverDir, name)),
    })),
  )
  console.log(
    `[verify:offline] pack:verify — ${files.length} files, all required files present`,
  )
  return {
    name: entry.name,
    version: entry.version,
    fileCount: files.length,
    requiredFiles: REQUIRED_PACKAGE_FILES,
    contentSha256,
  }
}

async function main() {
  const started = []
  const recordStep = (name, status, detail) => {
    started.push(detail ? { name, status, detail } : { name, status })
  }

  const { env: isolatedEnv } = buildIsolatedEnvironment()
  const pnpm = resolvePnpm()
  const pnpmVersion = spawnSync(pnpm.command, [...pnpm.prefixArgs, '--version'], {
    encoding: 'utf8',
  }).stdout.trim()

  const manifest = {
    schemaVersion: 1,
    command: 'pnpm run verify:offline',
    toolchain: {
      node: process.version,
      pnpm: pnpmVersion,
      platform: process.platform,
      arch: process.arch,
    },
    isolation:
      'lint, typecheck, unit tests, build and the LSP smoke session run with PATH restricted to core POSIX utilities and node; shellcheck, shfmt, man, col and network tools are unavailable',
    steps: started,
  }

  const writeManifest = () => {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  }

  const runStep = async (name, fn) => {
    try {
      const detail = await fn()
      recordStep(name, 'passed', detail)
      writeManifest()
    } catch (error) {
      recordStep(name, 'failed', error.message)
      writeManifest()
      console.error(`\n[verify:offline] FAILED at step "${name}": ${error.message}`)
      console.error(`[verify:offline] manifest written to ${MANIFEST_PATH}`)
      process.exit(1)
    }
  }

  await runStep('wasm:check', async () => {
    manifest.wasm = await checkBundledWasm()
    return `bundled wasm ABI ${manifest.wasm.abiVersion} matches parser.info`
  })

  await runStep('lint', async () => {
    runCommand(
      'lint',
      pnpm.command,
      [...pnpm.prefixArgs, 'run', 'lint:bail'],
      isolatedEnv,
    )
  })

  await runStep('typecheck', async () => {
    runCommand(
      'typecheck',
      pnpm.command,
      [...pnpm.prefixArgs, 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.eslint.json'],
      isolatedEnv,
    )
  })

  await runStep('test:unit', async () => {
    const ignoreArgs = ['/node_modules/', ...TOOL_DEPENDENT_TEST_SUITES].flatMap(
      (pattern) => ['--testPathIgnorePatterns', pattern],
    )
    runCommand(
      'test:unit',
      pnpm.command,
      [...pnpm.prefixArgs, 'exec', 'jest', '--runInBand', ...ignoreArgs],
      isolatedEnv,
    )
    return `excluded ${TOOL_DEPENDENT_TEST_SUITES.length} tool-dependent suites (covered by the external-tools CI job)`
  })

  await runStep('build', async () => {
    runCommand('build', pnpm.command, [...pnpm.prefixArgs, 'run', 'compile'], isolatedEnv)
  })

  await runStep('smoke:lsp', async () => {
    console.log('\n[verify:offline] smoke:lsp — driving stdio LSP session')
    const { requests, degradations } = await runSmokeSession({
      repoRoot: REPO_ROOT,
      serverEntry: path.join(REPO_ROOT, 'server', 'out', 'cli.js'),
      workspaceDir: WORKSPACE_DIR,
      transcriptPath: TRANSCRIPT_PATH,
      serverEnv: { ...isolatedEnv, BASH_IDE_LOG_LEVEL: 'error' },
    })
    manifest.lsp = {
      transcript: 'artifacts/lsp-smoke-session.json',
      requests,
      degradations,
    }
    return `${requests.length} LSP requests, ${degradations.length} verified degradations`
  })

  await runStep('pack:verify', async () => {
    manifest.package = verifyPackageContents(process.env)
    return `${manifest.package.fileCount} files in publish package`
  })

  manifest.fixtures = fingerprintFixtures()
  writeManifest()

  console.log('\n[verify:offline] all steps passed')
  console.log(`[verify:offline] manifest: ${path.relative(REPO_ROOT, MANIFEST_PATH)}`)
  console.log(`[verify:offline] transcript: ${path.relative(REPO_ROOT, TRANSCRIPT_PATH)}`)
}

main().catch((error) => {
  console.error(`[verify:offline] unexpected failure: ${error.stack || error}`)
  process.exit(1)
})
