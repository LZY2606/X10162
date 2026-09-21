#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Real stdio LSP smoke session for the offline verification pipeline.
 *
 * Spawns the compiled server (`server/out/cli.js start`) with a PATH that
 * exposes none of the optional external tools (ShellCheck, shfmt, man pages),
 * drives it through a fixed request sequence over JSON-RPC with Content-Length
 * framing, and records every request and response as normalized JSON.
 *
 * Outputs (in the artifacts directory):
 *   - lsp-session.json: ordered, normalized request/response transcript
 *   - lsp-report.json:  per-request summaries and degradation evidence
 *
 * Normalization replaces URIs, temporary directories, process ids and
 * timestamps with stable placeholders; real payloads are kept intact.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = process.env.VERIFY_REPO_ROOT || process.cwd()
const WORKSPACE = join(REPO_ROOT, 'testing', 'verify-workspace')
const MAIN_URI = pathToFileURL(join(WORKSPACE, 'main.sh')).href
const LIB_URI = pathToFileURL(join(WORKSPACE, 'lib.sh')).href
const SERVER_ENTRY = join(REPO_ROOT, 'server', 'out', 'cli.js')
const REQUEST_TIMEOUT_MS = 30000

const PLACEHOLDERS = {
  workspace: '__WORKSPACE__',
  temp: '__TMPDIR__',
  pid: '__PID__',
  time: '__TIME__',
}

/**
 * Build a minimal PATH exposing only node (and an `ls` symlink so completion
 * has a real executable to report) while hiding ShellCheck, shfmt and man.
 */
function buildIsolatedPath() {
  const isolatedBin = mkdtempSync(join(tmpdir(), 'bash-lsp-verify-bin-'))
  // node is required for the server entry; resolved from the running process.
  symlinkSync(process.execPath, join(isolatedBin, 'node'))
  // `ls` lets us exercise executable completion and hover degradation
  // (documentation lookup needs `man`, which stays hidden).
  for (const candidate of ['/bin/ls', '/usr/bin/ls']) {
    try {
      symlinkSync(candidate, join(isolatedBin, 'ls'))
      break
    } catch {
      // try the next candidate
    }
  }
  return { isolatedBin }
}

class LspClient {
  constructor({ env }) {
    this.nextId = 1
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.notifications = []
    this.process = spawn(process.execPath, [SERVER_ENTRY, 'start'], {
      cwd: WORKSPACE,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process.stdout.on('data', (chunk) => this.onData(chunk))
    this.process.on('exit', (code, signal) => {
      this.exitCode = { code, signal }
      const error = new Error(`server exited early with ${code ?? signal}`)
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) break
      const header = this.buffer.slice(0, headerEnd).toString('utf8')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) throw new Error(`Missing Content-Length header: ${header}`)
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) break
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.slice(bodyStart + length)
      this.dispatch(JSON.parse(body))
    }
  }

  dispatch(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const entry = this.pending.get(message.id)
      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(message.id)
        entry.resolve(message)
      }
    } else if (message.method) {
      this.notifications.push(message)
    }
  }

  send(message) {
    const body = JSON.stringify(message)
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    this.process.stdin.write(frame)
  }

  request(method, params) {
    const id = this.nextId++
    const startedAt = process.hrtime.bigint()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request ${method} (id ${id}) timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (message) =>
          resolve({ message, elapsedMs: hrtimeMs(startedAt) }),
        reject,
        timer,
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async close() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.process.kill('SIGKILL')
        resolve()
      }, 5000)
      this.process.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function hrtimeMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6
}

/**
 * Find a 0-based LSP position for an occurrence of `needle` in `text`.
 */
function positionOf(text, needle, occurrence = 0) {
  let index = -1
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1)
    if (index < 0) throw new Error(`anchor not found: ${needle}`)
  }
  const before = text.slice(0, index)
  const line = before.split('\n').length - 1
  const character = index - before.lastIndexOf('\n') - 1
  return { line, character }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Recursively normalize a JSON payload so the transcript is reproducible.
 */
function normalize(value, context) {
  if (typeof value === 'string') {
    return normalizeString(value, context)
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, context))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[normalizeString(key, context)] = normalize(value[key], context)
    }
    return out
  }
  return value
}

function normalizeString(value, context) {
  let result = value
  // Normalize file:// URI forms first, then bare paths. Doing it in the other
  // order leaves a raw path behind after the "file://" prefix.
  result = result.split(MAIN_URI).join(`file://${PLACEHOLDERS.workspace}/main.sh`)
  result = result.split(LIB_URI).join(`file://${PLACEHOLDERS.workspace}/lib.sh`)
  result = result
    .split(pathToFileURL(`${context.workspace}/`).href)
    .join(`file://${PLACEHOLDERS.workspace}/`)
  result = result
    .split(pathToFileURL(context.workspace).href)
    .join(`file://${PLACEHOLDERS.workspace}`)
  result = result.split(context.workspace).join(PLACEHOLDERS.workspace)
  result = result.split(context.tempDir).join(PLACEHOLDERS.temp)
  if (context.pid) result = result.split(String(context.pid)).join(PLACEHOLDERS.pid)
  result = result
    .split(pathToFileURL(context.tempDir).href)
    .join(`file://${PLACEHOLDERS.temp}`)
  // Server log timestamps: "12:34:56.789 LEVEL ..."
  result = result.replace(/^\d{2}:\d{2}:\d{2}\.\d{3}/m, PLACEHOLDERS.time)
  return result
}

async function runSession() {
  const { isolatedBin } = buildIsolatedPath()
  const context = { workspace: WORKSPACE, tempDir: isolatedBin, pid: null }

  const client = new LspClient({
    env: {
      ...process.env,
      PATH: isolatedBin,
      // Deterministic diagnostics configuration; optional tools stay at
      // defaults and fail to resolve on the isolated PATH.
      BASH_IDE_LOG_LEVEL: 'debug',
    },
  })
  context.pid = client.process.pid

  const transcript = []
  const record = (kind, payload) => {
    transcript.push({
      kind,
      method: payload.method,
      payload: normalize(payload, context),
    })
  }

  try {
    const mainText = readFileSync(join(WORKSPACE, 'main.sh'), 'utf8')
    const libText = readFileSync(join(WORKSPACE, 'lib.sh'), 'utf8')

    // 1. initialize
    const init = await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'verify-offline-harness', version: '1.0.0' },
      rootUri: pathToFileURL(`${WORKSPACE}/`).href,
      capabilities: {},
    })
    record('response', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      result: init.message.result,
    })
    client.notify('initialized', {})

    // 2. didOpen — diagnostics arrive as a notification; no response exists.
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: MAIN_URI,
        languageId: 'shellscript',
        version: 1,
        text: mainText,
      },
    })
    record('notification', {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: MAIN_URI, version: 1 } },
    })
    // Give the debounced analyzer/linter room to publish diagnostics.
    await sleep(1000)

    // The cross-file sourced library is parsed on demand, but didOpen also
    // triggers background analysis that may open it; open explicitly too.
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: LIB_URI,
        languageId: 'shellscript',
        version: 1,
        text: libText,
      },
    })
    record('notification', {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: LIB_URI, version: 1 } },
    })
    await sleep(1000)

    // 3. completion on the "greet_library" call in main.sh
    const completionPos = positionOf(mainText, 'greet_library')
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri: MAIN_URI },
      position: completionPos,
    })
    record('response', {
      ...completion.message,
      method: 'textDocument/completion',
    })

    // Unfiltered completion at a blank position lists PATH executables as well.
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(join(WORKSPACE, 'blank-probe.sh')).href,
        languageId: 'shellscript',
        version: 1,
        text: '\n',
      },
    })
    const completionAll = await client.request('textDocument/completion', {
      textDocument: { uri: pathToFileURL(join(WORKSPACE, 'blank-probe.sh')).href },
      position: { line: 1, character: 0 },
    })
    record('response', {
      ...completionAll.message,
      method: 'textDocument/completion:unfiltered',
    })

    // 4. definition on the same call — must resolve into lib.sh
    const definition = await client.request('textDocument/definition', {
      textDocument: { uri: MAIN_URI },
      position: completionPos,
    })
    record('response', {
      ...definition.message,
      method: 'textDocument/definition',
    })

    // 5. documentSymbol for both files
    for (const [name, uri] of [
      ['main.sh', MAIN_URI],
      ['lib.sh', LIB_URI],
    ]) {
      const symbols = await client.request('textDocument/documentSymbol', {
        textDocument: { uri },
      })
      record('response', {
        ...symbols.message,
        method: `textDocument/documentSymbol:${name}`,
      })
    }

    // 6. rename preview (prepareRename + rename) on GREETING in main.sh
    const greetingPos = positionOf(mainText, 'GREETING')
    const prepareRename = await client.request('textDocument/prepareRename', {
      textDocument: { uri: MAIN_URI },
      position: greetingPos,
    })
    record('response', {
      ...prepareRename.message,
      method: 'textDocument/prepareRename',
    })
    const rename = await client.request('textDocument/rename', {
      textDocument: { uri: MAIN_URI },
      position: greetingPos,
      newName: 'GREETING_RENAMED',
    })
    record('response', {
      ...rename.message,
      method: 'textDocument/rename',
    })

    // 7. Degradation probes (optional tools hidden via isolated PATH)
    const formatting = await client.request('textDocument/formatting', {
      textDocument: { uri: MAIN_URI },
      options: { tabSize: 4, insertSpaces: true },
    })
    record('response', {
      ...formatting.message,
      method: 'textDocument/formatting',
    })

    // Hover over the `ls` completion candidate: without `man`/`help` on PATH
    // the server returns null rather than inventing documentation.
    // Use a synthetic unsaved document containing ls to avoid fixture churn.
    const lsText = 'ls -la\n'
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(join(WORKSPACE, 'ls-probe.sh')).href,
        languageId: 'shellscript',
        version: 1,
        text: lsText,
      },
    })
    await sleep(300)
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: pathToFileURL(join(WORKSPACE, 'ls-probe.sh')).href },
      position: { line: 0, character: 1 },
    })
    record('response', { ...hover.message, method: 'textDocument/hover' })

    // Network unavailability: an unreachable explainshell endpoint must not
    // break the hover request or the session; the server logs and falls back.
    client.notify('workspace/didChangeConfiguration', {
      settings: {
        bashIde: {
          explainshellEndpoint: 'http://127.0.0.1:1',
          shellcheckPath: '',
          shfmt: { path: '' },
        },
      },
    })
    await sleep(200)
    const explainshellHover = await client.request('textDocument/hover', {
      textDocument: { uri: pathToFileURL(join(WORKSPACE, 'ls-probe.sh')).href },
      position: { line: 0, character: 1 },
    })
    record('response', {
      ...explainshellHover.message,
      method: 'textDocument/hover:explainshell-unavailable',
    })

    // 8. shutdown + exit
    const shutdown = await client.request('shutdown', null)
    record('response', { ...shutdown.message, method: 'shutdown' })
    client.notify('exit', null)
    record('notification', { jsonrpc: '2.0', method: 'exit', params: null })

    // Collect published diagnostics and log messages after shutdown settles.
    await sleep(200)

    const serverMessages = client.notifications.map((message) =>
      normalize(
        { ...message, method: message.method },
        context,
      ),
    )

    return {
      transcript,
      serverMessages,
      assertions: buildAssertions({
        init: init.message.result,
        completion: completion.message.result,
        completionAll: completionAll.message.result,
        definition: definition.message.result,
        rename: rename.message.result,
        prepareRename: prepareRename.message.result,
        formatting: formatting.message.result,
        hover: hover.message.result,
        explainshellHover: explainshellHover.message.result,
        notifications: client.notifications,
      }),
      exitCode: client.exitCode ?? null,
    }
  } finally {
    await client.close()
    rmSync(isolatedBin, { recursive: true, force: true })
  }
}

function collectLabels(completionResult) {
  if (!Array.isArray(completionResult)) return []
  return completionResult.map((item) => item.label)
}

function buildAssertions(results) {
  const diagnostics = results.notifications
    .filter((message) => message.method === 'textDocument/publishDiagnostics')
    .map((message) => ({
      uri: message.params.uri,
      diagnosticSources: (message.params.diagnostics || []).map(
        (diagnostic) => diagnostic.source ?? 'tree-sitter',
      ),
    }))

  const completionLabels = collectLabels(results.completion)
  const completionAllLabels = collectLabels(results.completionAll)
  const definitionUris = results.definition
    ? (Array.isArray(results.definition) ? results.definition : [results.definition])
        .map((location) => location.uri)
    : []

  const assertions = [
    {
      name: 'initialize returns server capabilities',
      ok: Boolean(
        results.init?.capabilities?.completionProvider &&
          results.init?.capabilities?.definitionProvider === true &&
          results.init?.capabilities?.documentSymbolProvider === true,
      ),
    },
    {
      name: 'completion includes the cross-file function greet_library',
      ok: completionLabels.includes('greet_library'),
      detail: `completion item count: ${completionLabels.length}`,
    },
    {
      name: 'completion includes an executable from PATH (ls)',
      ok: completionAllLabels.includes('ls'),
      detail: 'proves PATH executables still resolve without the optional tools',
    },
    {
      name: 'definition resolves into the sourced library (lib.sh)',
      ok: definitionUris.some((uri) => uri.endsWith('lib.sh')),
      detail: `definition targets: ${definitionUris.join(', ') || '(none)'}`,
    },
    {
      name: 'prepareRename returns the GREETING range',
      ok:
        Boolean(results.prepareRename) &&
        typeof results.prepareRename.start?.line === 'number',
    },
    {
      name: 'rename preview edits both main.sh and sourced lib.sh',
      ok:
        Boolean(results.rename?.changes) &&
        Object.keys(results.rename.changes).some((uri) => uri.endsWith('lib.sh')) &&
        Object.keys(results.rename.changes).some((uri) => uri.endsWith('main.sh')),
      detail: `edit targets: ${Object.keys(results.rename?.changes ?? {}).join(', ')}`,
    },
    {
      name: 'formatting degrades to null when shfmt is unavailable',
      ok: Array.isArray(results.formatting) && results.formatting.length === 0,
      detail: `formatting result: ${JSON.stringify(results.formatting)} (no edits produced)`,
    },
    {
      name: 'hover degrades to null without man pages',
      ok: results.hover === null,
      detail: `hover result: ${JSON.stringify(results.hover)}`,
    },
    {
      name: 'hover survives an unreachable explainshell endpoint (no network)',
      ok: results.explainshellHover === null,
      detail: `explainshell hover result: ${JSON.stringify(results.explainshellHover)}`,
    },
    {
      name: 'diagnostics carry no ShellCheck source without shellcheck on PATH',
      ok: diagnostics.every((entry) =>
        entry.diagnosticSources.every((source) => source !== 'shellcheck'),
      ),
      detail: JSON.stringify(diagnostics),
    },
  ]

  return assertions
}

async function main() {
  if (!process.env.VERIFY_ARTIFACTS_DIR) {
    console.error('VERIFY_ARTIFACTS_DIR must be set')
    process.exit(2)
  }
  const artifactsDir = process.env.VERIFY_ARTIFACTS_DIR
  const result = await runSession()

  const { writeFileSync } = await import('node:fs')
  const { join: joinPath } = await import('node:path')

  // Full request/response transcript with real payloads (normalized).
  writeFileSync(
    joinPath(artifactsDir, 'lsp-session.json'),
    `${JSON.stringify(result.transcript, null, 2)}\n`,
  )
  // Server-initiated messages (diagnostics, logs) — evidence of degradation.
  writeFileSync(
    joinPath(artifactsDir, 'lsp-server-messages.json'),
    `${JSON.stringify(result.serverMessages, null, 2)}\n`,
  )
  // Machine-checkable per-request report for the manifest.
  writeFileSync(
    joinPath(artifactsDir, 'lsp-report.json'),
    `${JSON.stringify(
      {
        exitCode: result.exitCode,
        assertions: result.assertions,
      },
      null,
      2,
    )}\n`,
  )

  const failed = result.assertions.filter((assertion) => !assertion.ok)
  if (result.exitCode?.code !== 0 && result.exitCode !== null) {
    console.error(`Server exited unexpectedly: ${JSON.stringify(result.exitCode)}`)
    process.exit(1)
  }
  if (failed.length > 0) {
    console.error('LSP smoke session assertions failed:')
    for (const assertion of failed) {
      console.error(`  - ${assertion.name} (${assertion.detail ?? 'no detail'})`)
    }
    process.exit(1)
  }
  console.log(
    `LSP smoke session passed (${result.assertions.length} assertions); transcript in artifacts/lsp-session.json`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
