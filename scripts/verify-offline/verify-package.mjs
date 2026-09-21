#!/usr/bin/env node
/**
 * Package content verification for `pnpm run verify:offline`.
 *
 * Packs the server exactly like the release flow does (npm pack in server/,
 * lifecycle scripts skipped because the build step already ran) and verifies
 * the tarball contents:
 *   - the protocol entry points (out/cli.js, out/server.js) are present,
 *   - the formatter helper (out/get-options.sh) is present,
 *   - the bundled tree-sitter-bash.wasm is present and byte-identical to the
 *     in-repository grammar (a missing or mismatched wasm fails the run; the
 *     server never falls back to a globally installed parser),
 *   - the bin entry declared in package.json exists in the tarball.
 *
 * Writes a content digest to artifacts/package-contents.json. The digest list
 * is sorted so repeated runs produce stable output without absolute paths,
 * timestamps or process ids.
 */
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SERVER_DIR = path.join(REPO_ROOT, 'server')
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts')

const REQUIRED_FILES = [
  'package/package.json',
  'package/README.md',
  'package/out/cli.js',
  'package/out/server.js',
  'package/out/get-options.sh',
  'package/tree-sitter-bash.wasm',
]

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function walk(dir) {
  const entries = []
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      entries.push(...walk(full))
    } else if (stat.isFile()) {
      entries.push(full)
    }
  }
  return entries
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function main() {
  const repoWasmPath = path.join(SERVER_DIR, 'tree-sitter-bash.wasm')
  if (!fs.existsSync(repoWasmPath)) {
    throw new Error(
      'server/tree-sitter-bash.wasm is missing; the bundled grammar is required and no global fallback is allowed',
    )
  }
  const repoWasmSha256 = sha256(fs.readFileSync(repoWasmPath))

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-lsp-verify-pack-'))
  try {
    const pack = spawnSync(
      npmBin(),
      ['pack', SERVER_DIR, '--ignore-scripts', '--pack-destination', tmp, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    if (pack.status !== 0) {
      throw new Error(`npm pack failed: ${pack.stderr || pack.stdout}`)
    }
    const packInfo = JSON.parse(pack.stdout)[0]
    const tarballPath = path.join(tmp, packInfo.filename)
    const tarballSha256 = sha256(fs.readFileSync(tarballPath))

    const extractDir = path.join(tmp, 'extracted')
    fs.mkdirSync(extractDir)
    const untar = spawnSync('tar', ['-xzf', tarballPath, '-C', extractDir], { encoding: 'utf8' })
    if (untar.status !== 0) {
      throw new Error(`failed to extract tarball: ${untar.stderr}`)
    }

    const files = walk(path.join(extractDir, 'package'))
      .map((full) => {
        const relative = path.relative(extractDir, full).split(path.sep).join('/')
        return { path: relative, sha256: sha256(fs.readFileSync(full)), bytes: fs.statSync(full).size }
      })
      .sort((a, b) => a.path.localeCompare(b.path))

    const failures = []
    const present = new Set(files.map((file) => file.path))
    const requiredFiles = REQUIRED_FILES.map((file) => ({ path: file, present: present.has(file) }))
    for (const required of requiredFiles) {
      if (!required.present) failures.push(`required package file missing: ${required.path}`)
    }

    const packedWasm = files.find((file) => file.path === 'package/tree-sitter-bash.wasm')
    const wasmMatchesRepository = packedWasm?.sha256 === repoWasmSha256
    if (!wasmMatchesRepository) {
      failures.push('packaged tree-sitter-bash.wasm does not match the repository grammar')
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(extractDir, 'package', 'package.json'), 'utf8'),
    )
    const binEntry = manifest.bin?.['bash-language-server']
    if (!binEntry || !present.has(`package/${binEntry}`)) {
      failures.push(`bin entry bash-language-server (${binEntry}) is not part of the tarball`)
    }

    const contentsSha256 = sha256(
      Buffer.from(files.map((file) => `${file.path}\0${file.sha256}\n`).join(''), 'utf8'),
    )

    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'package-contents.json'),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          tarball: { fileName: packInfo.filename, sha256: tarballSha256 },
          fileCount: files.length,
          contentsSha256,
          requiredFiles,
          treeSitterWasm: { path: 'package/tree-sitter-bash.wasm', sha256: repoWasmSha256, wasmMatchesRepository },
          files,
        },
        null,
        2,
      )}\n`,
    )

    if (failures.length > 0) {
      for (const failure of failures) console.error(`verify-package: ${failure}`)
      process.exit(1)
    }
    console.log(
      `verify-package: ${packInfo.filename} contains ${files.length} files, contents sha256 ${contentsSha256}`,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main()
