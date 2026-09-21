#!/usr/bin/env node
/**
 * Verifies the repository-local tree-sitter-bash.wasm that the server bundles
 * and loads at runtime (server/src/parser.ts reads it relative to out/).
 *
 * The check fails when the wasm is missing or when its ABI version does not
 * match the ABI recorded in server/parser.info and the range supported by the
 * installed web-tree-sitter. The server never falls back to a globally
 * installed grammar, so a mismatch here must fail the verification.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Resolved exactly like the compiled server does: server/out/../<file>.
const SERVER_OUT = join(REPO_ROOT, 'server', 'out')
const WASM_PATH = resolve(SERVER_OUT, '..', 'tree-sitter-bash.wasm')
const PARSER_INFO_PATH = join(REPO_ROOT, 'server', 'parser.info')

const require = createRequire(join(REPO_ROOT, 'server', 'package.json'))

async function main() {
  let wasm
  try {
    wasm = await readFile(WASM_PATH)
  } catch {
    throw new Error(
      'server/tree-sitter-bash.wasm is missing. Restore the bundled grammar; ' +
        'the server does not fall back to a globally installed one.',
    )
  }

  const parserInfo = await readFile(PARSER_INFO_PATH, 'utf8')
  const abiMatch = parserInfo.match(/^parser ABI (\d+)$/m)
  if (!abiMatch) {
    throw new Error('server/parser.info does not record a "parser ABI" version')
  }
  const expectedAbi = Number(abiMatch[1])

  const { Language, Parser } = require('web-tree-sitter')
  await Parser.init()
  // These constants are populated by Parser.init(), so read them afterwards.
  const { LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION } = require('web-tree-sitter')
  const parser = new Parser()
  const language = await Language.load(wasm)
  parser.setLanguage(language)

  const { abiVersion } = language
  if (abiVersion !== expectedAbi) {
    throw new Error(
      `tree-sitter-bash.wasm has ABI ${abiVersion}, but server/parser.info records ` +
        `ABI ${expectedAbi}. Regenerate the grammar with scripts/upgrade-tree-sitter.sh.`,
    )
  }
  if (abiVersion < MIN_COMPATIBLE_VERSION || abiVersion > LANGUAGE_VERSION) {
    throw new Error(
      `tree-sitter-bash.wasm ABI ${abiVersion} is outside the range supported by the ` +
        `installed web-tree-sitter (${MIN_COMPATIBLE_VERSION}..${LANGUAGE_VERSION}).`,
    )
  }

  // Prove the grammar actually parses with the installed runtime.
  const tree = parser.parse('echo hello\n')
  if (tree.rootNode.type !== 'program' || tree.rootNode.hasError) {
    throw new Error('tree-sitter-bash.wasm failed to parse a trivial program')
  }
  tree.delete()
  parser.delete()

  console.log(
    `tree-sitter wasm ok: server/tree-sitter-bash.wasm (ABI ${abiVersion}, ` +
      `supported ${MIN_COMPATIBLE_VERSION}..${LANGUAGE_VERSION})`,
  )
}

main().catch((error) => {
  console.error(`tree-sitter wasm check failed: ${error.message ?? error}`)
  process.exit(1)
})
