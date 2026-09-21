#!/usr/bin/env node
/**
 * Offline LSP smoke session for `pnpm run verify:offline`.
 *
 * Spawns the compiled server (server/out/cli.js) over stdio with a scrubbed
 * PATH (no shellcheck, shfmt, man, col or bash resolvable) and drives a fixed
 * session against the in-repository workspace at testing/verify-workspace:
 * initialize, didOpen, completion, definition, documentSymbol, prepareRename,
 * rename (preview only, nothing is applied), hover, formatting, shutdown.
 *
 * The full request/response transcript is written to artifacts/lsp-smoke.json
 * as normalized JSON: repository paths, temporary directories, process ids and
 * similar machine-specific values are replaced with stable placeholders while
 * the real payloads are preserved.
 *
 * Exit code is 0 only when every expectation holds, including the graceful
 * degradation of the optional external tools.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORKSPACE = path.join(REPO_ROOT, 'testing', 'verify-workspace')
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts')
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'out', 'cli.js')
const MAIN_DOCUMENT = path.join(WORKSPACE, 'main.sh')
const REQUEST_TIMEOUT_MS = 20000
const NOTIFICATION_TIMEOUT_MS = 10000

const failures = []
function check(condition, message) {
  if (!condition) {
    failures.push(message)
    console.error(`smoke assertion failed: ${message}`)
  }
}

function normalize(value) {
  if (typeof value === 'string') {
    return value
      .split(WORKSPACE).join('<workspace>')
      .split(REPO_ROOT).join('<repo>')
      .split(os.tmpdir()).join('<tmp>')
  }
  if (Array.isArray(value)) {
    return value.map(normalize)
  }
  if (value && typeof value === 'object') {
    const result = {}
    for (const [rawKey, child] of Object.entries(value)) {
      const key = normalize(rawKey)
      if (rawKey === 'processId' || rawKey === 'pid') {
        result[key] = child == null ? child : '<pid>'
      } else if (/^(duration|elapsed|timestamp|time)(Ms)?$/i.test(rawKey)) {
        result[key] = '<duration>'
      } else {
        result[key] = normalize(child)
      }
    }
    return result
  }
  return value
}

class LspClient {
  constructor(child) {
    this.child = child
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.transcript = []
    this.waiters = []
    this.stderr = ''
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8')
    })
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) {
        throw new Error(`invalid LSP header: ${header}`)
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      this.#onMessage(JSON.parse(body))
    }
  }

  #onMessage(message) {
    this.transcript.push({ direction: 'received', message })
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id)
      if (entry) {
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) {
          entry.reject(new Error(`${entry.method} failed: ${JSON.stringify(message.error)}`))
        } else {
          entry.resolve(message.result)
        }
      }
      return
    }
    if (message.method) {
      this.notifications.push(message)
      this.waiters = this.waiters.filter((waiter) => !waiter.tryResolve(message))
    }
  }

  #send(message) {
    const body = JSON.stringify(message)
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    this.transcript.push({ direction: 'sent', message })
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out waiting for ${method} response`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer, method })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  waitForNotification(method, predicate = () => true, timeoutMs = NOTIFICATION_TIMEOUT_MS) {
    const existing = this.notifications.find(
      (message) => message.method === method && predicate(message.params),
    )
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${method} notification`))
      }, timeoutMs)
      this.waiters.push({
        tryResolve: (message) => {
          if (message.method === method && predicate(message.params)) {
            clearTimeout(timer)
            resolve(message)
            return true
          }
          return false
        },
      })
    })
  }
}

function positionOf(lines, { lineIncludes, charAfter }) {
  const line = lines.findIndex((text) => text.includes(lineIncludes))
  if (line === -1) throw new Error(`marker not found in fixture: ${lineIncludes}`)
  return { line, character: lines[line].indexOf(charAfter) + charAfter.length }
}

async function main() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`compiled server not found at ${SERVER_ENTRY}; run the build step first`)
  }

  // Isolate the server from any optional external tools: the scrubbed PATH
  // contains no shellcheck, shfmt, man, col or bash, so the corresponding
  // capabilities must degrade instead of failing the session.
  const scrubbedBin = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-lsp-verify-bin-'))
  const child = spawn(process.execPath, [SERVER_ENTRY, 'start'], {
    cwd: WORKSPACE,
    env: {
      PATH: scrubbedBin,
      HOME: os.tmpdir(),
      BASH_IDE_LOG_LEVEL: 'info',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const childExit = new Promise((resolve) => child.once('exit', (code) => resolve(code)))

  const client = new LspClient(child)
  const requests = []
  const degradations = []

  const debug = process.env.BASH_LSP_VERIFY_DEBUG === '1' ? (msg) => console.error(`[smoke ${Date.now()}] ${msg}`) : () => {}

  async function step(method, params, verify) {
    debug(`-> ${method}`)
    const result = await client.request(method, params)
    debug(`<- ${method}`)
    const note = verify ? verify(result) : undefined
    requests.push({ method, status: 'ok', ...(note ? { note } : {}) })
    return result
  }

  const workspaceUri = pathToFileURL(WORKSPACE).href
  const mainUri = pathToFileURL(MAIN_DOCUMENT).href
  const mainText = fs.readFileSync(MAIN_DOCUMENT, 'utf8')
  const mainLines = mainText.split('\n')

  try {
    const initializeResult = await step('initialize', {
      processId: null,
      rootUri: workspaceUri,
      workspaceFolders: [{ uri: workspaceUri, name: 'verify-workspace' }],
      capabilities: {},
      initializationOptions: {},
    }, (result) => {
      check(result?.capabilities?.definitionProvider === true, 'definitionProvider capability')
      check(result?.capabilities?.completionProvider != null, 'completionProvider capability')
      check(result?.capabilities?.documentSymbolProvider === true, 'documentSymbolProvider capability')
      check(result?.capabilities?.renameProvider != null, 'renameProvider capability')
    })
    void initializeResult

    client.notify('initialized', {})

    client.notify('textDocument/didOpen', {
      textDocument: { uri: mainUri, languageId: 'shellscript', version: 1, text: mainText },
    })

    // ShellCheck is not resolvable: linting must degrade (warning logged,
    // no ShellCheck diagnostics published) without breaking the session.
    const shellCheckWarning = await client.waitForNotification(
      'window/logMessage',
      (params) => typeof params?.message === 'string' && params.message.includes('ShellCheck'),
    ).catch(() => null)
    check(
      shellCheckWarning != null &&
        /disabling linting|not set|no executable/.test(shellCheckWarning.params.message),
      'ShellCheck degradation warning was logged',
    )
    degradations.push({
      capability: 'shellcheck',
      state: 'degraded',
      reason: 'shellcheck executable is not available on the scrubbed PATH; linting disabled itself and the session continued',
    })

    const completionLine = mainLines.findIndex((text) => text === 'add')
    check(completionLine !== -1, 'fixture contains a completion marker line')
    const completionResult = await step('textDocument/completion', {
      textDocument: { uri: mainUri },
      position: { line: completionLine, character: 'add'.length },
    }, (result) => {
      const items = Array.isArray(result) ? result : result?.items ?? []
      check(
        items.some((item) => item.label === 'add_numbers'),
        'completion includes add_numbers from the sourced file',
      )
    })
    void completionResult

    const definitionPosition = positionOf(mainLines, {
      lineIncludes: 'add_numbers 1 2',
      charAfter: 'add_nu',
    })
    await step('textDocument/definition', {
      textDocument: { uri: mainUri },
      position: definitionPosition,
    }, (result) => {
      const locations = Array.isArray(result) ? result : result ? [result] : []
      check(
        locations.some((location) => location.uri.endsWith('/testing/verify-workspace/lib.sh')),
        'definition of add_numbers resolves into lib.sh',
      )
    })

    await step('textDocument/documentSymbol', {
      textDocument: { uri: mainUri },
    }, (result) => {
      check(
        Array.isArray(result) && result.some((symbol) => symbol.name === 'TARGET_WORD'),
        'documentSymbol lists TARGET_WORD',
      )
    })

    const renamePosition = positionOf(mainLines, {
      lineIncludes: 'echo "$TARGET_WORD"',
      charAfter: '$TARGET_',
    })
    const prepareResult = await step('textDocument/prepareRename', {
      textDocument: { uri: mainUri },
      position: renamePosition,
    }, (result) => {
      check(result != null && result.start != null, 'prepareRename returns a range')
    })
    check(prepareResult != null, 'rename preview requires a successful prepareRename')

    await step('textDocument/rename', {
      textDocument: { uri: mainUri },
      position: renamePosition,
      newName: 'RENAMED_WORD',
    }, (result) => {
      const edits = result?.changes?.[mainUri] ?? []
      check(edits.length === 2, 'rename preview contains both TARGET_WORD occurrences')
      check(
        edits.every((edit) => edit.newText === 'RENAMED_WORD'),
        'rename preview uses the requested new name',
      )
    })

    // man/help are not resolvable: hover documentation for a builtin must
    // degrade to null while the request itself succeeds.
    const hoverPosition = positionOf(mainLines, { lineIncludes: 'echo "$GREETING"', charAfter: 'ec' })
    await step('textDocument/hover', {
      textDocument: { uri: mainUri },
      position: hoverPosition,
    }, (result) => {
      check(result === null, 'hover for a builtin degrades to null without man/help')
    })
    degradations.push({
      capability: 'man-pages',
      state: 'degraded',
      reason: 'man, col and bash are not available on the scrubbed PATH; builtin hover documentation is omitted',
    })

    // shfmt is not resolvable: formatting must degrade to empty edits.
    await step('textDocument/formatting', {
      textDocument: { uri: mainUri },
      options: { tabSize: 2, insertSpaces: true },
    }, (result) => {
      check(Array.isArray(result) && result.length === 0, 'formatting degrades to empty edits without shfmt')
    })
    const shfmtWarning = await client.waitForNotification(
      'window/logMessage',
      (params) => typeof params?.message === 'string' && params.message.includes('Shfmt'),
    ).catch(() => null)
    check(
      shfmtWarning != null && /disabling formatting|not set|no executable/.test(shfmtWarning.params.message),
      'shfmt degradation warning was logged',
    )
    degradations.push({
      capability: 'shfmt',
      state: 'degraded',
      reason: 'shfmt executable is not available on the scrubbed PATH; formatting returned empty edits',
    })
    degradations.push({
      capability: 'explainshell',
      state: 'disabled',
      reason: 'no explainshell endpoint is configured, so no network access is attempted',
    })

    const diagnostics = client.notifications.filter(
      (message) => message.method === 'textDocument/publishDiagnostics',
    )
    check(
      diagnostics.every(
        (message) =>
          !(message.params?.diagnostics ?? []).some((diagnostic) => diagnostic.source === 'shellcheck'),
      ),
      'no ShellCheck diagnostics were published',
    )

    await step('shutdown', null, (result) => {
      check(result === null, 'shutdown responds with null')
    })
    client.notify('exit')
    debug('sent exit, waiting for server process')
    let exitTimer
    const exitCode = await Promise.race([
      childExit,
      new Promise((resolve) => {
        exitTimer = setTimeout(() => resolve('timeout'), REQUEST_TIMEOUT_MS)
      }),
    ])
    clearTimeout(exitTimer)
    debug(`server process exit: ${String(exitCode)}`)
    check(exitCode === 0, `server exited cleanly (got ${String(exitCode)})`)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    child.kill('SIGKILL')
  } finally {
    fs.rmSync(scrubbedBin, { recursive: true, force: true })
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
    const transcript = {
      workspace: 'testing/verify-workspace',
      isolatedEnvironment: {
        PATH: '<tmp>/bash-lsp-verify-bin-*',
        note: 'scrubbed PATH without shellcheck, shfmt, man, col or bash',
      },
      requests,
      degradations,
      diagnosticsNotifications: normalize(
        client.notifications.filter((message) => message.method === 'textDocument/publishDiagnostics'),
      ),
      transcript: normalize(client.transcript),
      serverStderr: normalize(client.stderr.trim().split('\n').filter(Boolean)),
    }
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'lsp-smoke.json'),
      `${JSON.stringify(transcript, null, 2)}\n`,
    )
  }

  if (failures.length > 0) {
    console.error(`\nlsp-smoke: ${failures.length} expectation(s) failed`)
    process.exit(1)
  }
  console.log(`lsp-smoke: ${requests.length} requests succeeded, transcript written to artifacts/lsp-smoke.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
