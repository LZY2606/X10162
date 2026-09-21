#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Verifies the contents of the publishable server tarball without packing it
 * to disk or contacting the registry:
 *
 *   - `npm pack --dry-run --json` lists exactly what would be published.
 *   - Required entries (protocol entry, built server, bundled tree-sitter wasm
 *     and the get-options helper) must be present.
 *   - Development-only content (sources, tests, fixtures) must not leak in.
 *   - A stable SHA-256 digest per required file is reported for the manifest.
 *
 * Emits artifacts/package-report.json and fails on any violation.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.env.VERIFY_REPO_ROOT || process.cwd()
const SERVER_DIR = join(REPO_ROOT, 'server')

const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'tree-sitter-bash.wasm',
  'out/cli.js',
  'out/server.js',
  'out/parser.js',
  'out/get-options.sh',
]

const FORBIDDEN_PATTERNS = [
  /^src\//,
  /^__tests__\//,
  /(^|\/)__tests__\//,
  /(^|\/)fixtures\//,
  // Declaration files are intentionally shipped (see "typings"); only ban raw
  // implementation sources and source maps.
  /(^|\/)src\/.*\.ts$/,
  /\.map$/,
]

function sha256(relativePath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(join(SERVER_DIR, relativePath)))
  return hash.digest('hex')
}

function main() {
  const artifactsDir = process.env.VERIFY_ARTIFACTS_DIR
  if (!artifactsDir) {
    console.error('VERIFY_ARTIFACTS_DIR must be set')
    process.exit(2)
  }

  const output = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: SERVER_DIR, encoding: 'utf8' },
  )
  const [packResult] = JSON.parse(output)
  const files = packResult.files.map((file) => file.path).sort()

  const failures = []
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) {
      failures.push(`required file missing from package: ${required}`)
    } else if (!existsSync(join(SERVER_DIR, required))) {
      failures.push(`package lists ${required} but it is absent on disk`)
    }
  }
  for (const file of files) {
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file))) {
      failures.push(`development-only file would be published: ${file}`)
    }
  }

  // package.json bin/main must point at the shipped protocol entry.
  const packageJson = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'))
  if (packageJson.bin?.['bash-language-server'] !== 'out/cli.js') {
    failures.push('package.json bin entry is not out/cli.js')
  }
  if (packageJson.main !== './out/server.js') {
    failures.push('package.json main entry is not ./out/server.js')
  }

  const requiredContent = REQUIRED_FILES.map((path) => ({
    path,
    size: packResult.files.find((file) => file.path === path)?.size ?? null,
    sha256: existsSync(join(SERVER_DIR, path)) ? sha256(path) : null,
  }))

  const report = {
    name: packResult.name,
    version: packResult.version,
    filename: packResult.filename,
    unpackedSize: packResult.unpackedSize,
    fileCount: files.length,
    files,
    requiredContent,
    failures,
  }

  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(
    join(artifactsDir, 'package-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )

  if (failures.length > 0) {
    console.error('Package verification failed:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(
    `Package verification passed (${files.length} files, wasm and protocol entry present)`,
  )
}

main()
