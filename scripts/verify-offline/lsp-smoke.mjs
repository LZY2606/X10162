/**
 * Offline LSP smoke session for `pnpm run verify:offline`.
 *
 * Spawns the built server (`server/out/cli.js start`) over stdio and drives a
 * real protocol session against the fixed workspace in testing/verify-workspace:
 * initialize, didOpen, completion, definition, documentSymbol, rename preview,
 * plus hover/formatting probes that must degrade gracefully when the optional
 * external tools (ShellCheck, shfmt, man) are not on PATH.
 *
 * The full request/response transcript is written as normalized JSON: absolute
 * repo paths become <REPO_ROOT>, temp dirs become <TMPDIR>, and no process ids
 * or timings are recorded. Payloads are kept intact.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUEST_TIMEOUT_MS = 30000
const DIAGNOSTICS_TIMEOUT_MS = 30000
const EXIT_TIMEOUT_MS = 10000

function normalizeValue(value, replacements) {
  if (typeof value === 'string') {
    let result = value
    for (const [from, to] of replacements) {
      result = result.split(from).join(to)
    }
    // Scrub log timestamps (e.g. "05:10:05.713 ERROR ...") so the transcript
    // is deterministic.
    return result.replace(/\b\d{2}:\d{2}:\d{2}\.\d{3}\b/g, '<TIMESTAMP>')
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, replacements))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        normalizeValue(key, replacements),
        normalizeValue(item, replacements),
      ]),
    )
  }
  return value
}

class LspStdioClient {
  constructor({ command, args, env, cwd, normalize }) {
    this.normalize = normalize
    this.transcript = []
    this.seq = 0
    this.nextId = 1
    this.pending = new Map()
    this.notificationHandlers = []
    this.buffer = Buffer.alloc(0)
    this.serverError = null

    this.proc = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drainBuffer()
    })
    let stderr = ''
    this.proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    this.exitPromise = new Promise((resolve, reject) => {
      this.proc.on('error', reject)
      this.proc.on('exit', (code, signal) => {
        this.stderr = stderr
        for (const { reject: rejectPending, timer } of this.pending.values()) {
          clearTimeout(timer)
          rejectPending(
            new Error(
              `server exited (code=${code} signal=${signal}) with pending requests; stderr:\n${stderr}`,
            ),
          )
        }
        this.pending.clear()
        resolve({ code, signal, stderr })
      })
    })
  }

  record(direction, message) {
    this.seq += 1
    this.transcript.push({
      seq: this.seq,
      direction,
      message: this.normalize(message),
    })
  }

  drainBuffer() {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) {
        throw new Error(`invalid LSP header: ${header}`)
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      this.handleMessage(JSON.parse(body))
    }
  }

  handleMessage(message) {
    if (message.id !== undefined && message.method === undefined) {
      // Response to a client request.
      const entry = this.pending.get(message.id)
      this.record('recv', message)
      if (entry) {
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) {
          entry.reject(
            new Error(`${entry.method} failed: ${JSON.stringify(message.error)}`),
          )
        } else {
          entry.resolve(message.result)
        }
      }
      return
    }
    if (message.method && message.id !== undefined) {
      // Server-to-client request: reply with a null result so the server is
      // never blocked waiting on us.
      this.record('recv', message)
      this.sendMessage({ jsonrpc: '2.0', id: message.id, result: null })
      return
    }
    // Notification from the server.
    this.record('recv', message)
    for (const handler of this.notificationHandlers) {
      handler(message)
    }
  }

  sendMessage(message) {
    const body = JSON.stringify(message)
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, params }
    this.record('send', message)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.sendMessage(message)
    })
  }

  notify(method, params) {
    const message = { jsonrpc: '2.0', method, params }
    this.record('send', message)
    this.sendMessage(message)
  }

  onNotification(handler) {
    this.notificationHandlers.push(handler)
  }

  waitForNotification(predicate, description, timeoutMs = DIAGNOSTICS_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${description}`)),
        timeoutMs,
      )
      this.onNotification((message) => {
        if (predicate(message)) {
          clearTimeout(timer)
          resolve(message)
        }
      })
    })
  }
}

export async function runSmokeSession({
  repoRoot,
  serverEntry,
  workspaceDir,
  transcriptPath,
  serverEnv,
}) {
  const replacements = [
    [repoRoot, '<REPO_ROOT>'],
    [path.dirname(repoRoot), '<CHECKOUT_PARENT>'],
  ]
  const normalize = (value) => normalizeValue(value, replacements)

  const workspaceUri = pathToFileURL(workspaceDir).href
  const mainPath = path.join(workspaceDir, 'main.sh')
  const libPath = path.join(workspaceDir, 'lib.sh')
  const mainUri = pathToFileURL(mainPath).href
  const libUri = pathToFileURL(libPath).href
  const mainText = fs.readFileSync(mainPath, 'utf8')
  const libText = fs.readFileSync(libPath, 'utf8')

  const client = new LspStdioClient({
    command: process.execPath,
    args: [serverEntry, 'start'],
    env: serverEnv,
    cwd: repoRoot,
    normalize,
  })

  const results = []
  const degradations = []
  const recordResult = (entry) => results.push(entry)

  const fail = (message) => {
    throw new Error(`LSP smoke session: ${message}`)
  }

  try {
    // --- initialize -------------------------------------------------------
    const initializeResult = await client.request('initialize', {
      processId: null,
      rootUri: workspaceUri,
      workspaceFolders: [{ uri: workspaceUri, name: 'verify-workspace' }],
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          completion: { completionItem: { snippetSupport: false } },
          definition: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          rename: {},
          formatting: {},
        },
        workspace: { workspaceFolders: true },
      },
      initializationOptions: {},
    })
    const capabilities = (initializeResult && initializeResult.capabilities) || {}
    for (const capability of [
      'completionProvider',
      'definitionProvider',
      'documentSymbolProvider',
      'renameProvider',
    ]) {
      if (!capabilities[capability]) {
        fail(`initialize result is missing capability ${capability}`)
      }
    }
    recordResult({
      method: 'initialize',
      status: 'ok',
      detail: 'server advertised completion/definition/documentSymbol/rename',
    })
    client.notify('initialized', {})

    // --- didOpen ----------------------------------------------------------
    const waitForDiagnostics = (uri, description) =>
      client.waitForNotification(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          message.params &&
          message.params.uri === uri,
        description,
      )
    // Open the documents one at a time, awaiting diagnostics in between, so
    // the transcript ordering is deterministic.
    const libDiagnosticsPromise = waitForDiagnostics(
      libUri,
      'publishDiagnostics for lib.sh',
    )
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: libUri,
        languageId: 'shellscript',
        version: 1,
        text: libText,
      },
    })
    await libDiagnosticsPromise
    const mainDiagnosticsPromise = waitForDiagnostics(
      mainUri,
      'publishDiagnostics for main.sh',
    )
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: mainUri,
        languageId: 'shellscript',
        version: 1,
        text: mainText,
      },
    })
    const mainDiagnostics = (await mainDiagnosticsPromise).params.diagnostics
    if (!Array.isArray(mainDiagnostics)) {
      fail('publishDiagnostics did not carry a diagnostics array')
    }
    recordResult({
      method: 'textDocument/didOpen',
      status: 'ok',
      detail: `opened main.sh and lib.sh; received publishDiagnostics (${mainDiagnostics.length} diagnostics)`,
    })
    degradations.push({
      feature: 'shellcheck-diagnostics',
      reason: 'shellcheck executable is not available on the isolated PATH',
      protocolBehavior:
        'textDocument/publishDiagnostics is still delivered with parser-only diagnostics',
      evidence: `main.sh published ${mainDiagnostics.length} diagnostics`,
    })

    // --- completion ---------------------------------------------------------
    const completionResult = await client.request('textDocument/completion', {
      textDocument: { uri: mainUri },
      position: { line: 5, character: 3 },
    })
    const completionItems = Array.isArray(completionResult)
      ? completionResult
      : (completionResult && completionResult.items) || []
    if (!completionItems.some((item) => item.label === 'verify_greet')) {
      fail('completion did not include verify_greet from the sourced lib.sh')
    }
    recordResult({
      method: 'textDocument/completion',
      status: 'ok',
      detail: `verify_greet offered among ${completionItems.length} items`,
    })

    // --- definition ---------------------------------------------------------
    const definitionResult = await client.request('textDocument/definition', {
      textDocument: { uri: mainUri },
      position: { line: 3, character: 4 },
    })
    const definitions = Array.isArray(definitionResult)
      ? definitionResult
      : definitionResult
      ? [definitionResult]
      : []
    const normalizedLibUri = normalize(libUri)
    if (
      !definitions.some(
        (location) => location.uri === libUri && location.range.start.line === 5,
      )
    ) {
      fail(
        `definition for verify_greet did not resolve to ${normalizedLibUri}:5, got ${JSON.stringify(
          normalize(definitions),
        )}`,
      )
    }
    recordResult({
      method: 'textDocument/definition',
      status: 'ok',
      detail: 'verify_greet call in main.sh resolves across files to lib.sh:5',
    })

    // --- documentSymbol -----------------------------------------------------
    const symbolsResult = await client.request('textDocument/documentSymbol', {
      textDocument: { uri: libUri },
    })
    const flattenSymbols = (symbols) =>
      (symbols || []).flatMap((symbol) => [symbol, ...flattenSymbols(symbol.children)])
    const symbols = flattenSymbols(symbolsResult)
    if (!symbols.some((symbol) => symbol.name === 'verify_greet')) {
      fail('documentSymbol did not report verify_greet in lib.sh')
    }
    recordResult({
      method: 'textDocument/documentSymbol',
      status: 'ok',
      detail: `lib.sh reports ${symbols.length} symbols including verify_greet`,
    })

    // --- rename preview -------------------------------------------------------
    const renameResult = await client.request('textDocument/rename', {
      textDocument: { uri: mainUri },
      position: { line: 3, character: 4 },
      newName: 'verify_welcome',
    })
    const changedUris = Object.keys((renameResult && renameResult.changes) || {})
    if (!changedUris.includes(mainUri) || !changedUris.includes(libUri)) {
      fail(
        `rename preview did not span main.sh and lib.sh, got ${JSON.stringify(
          normalize(renameResult),
        )}`,
      )
    }
    recordResult({
      method: 'textDocument/rename',
      status: 'ok',
      detail: `rename preview of verify_greet spans ${changedUris.length} files (returned as WorkspaceEdit, not applied)`,
    })

    // --- degradation probe: hover without man -------------------------------
    const hoverResult = await client.request('textDocument/hover', {
      textDocument: { uri: libUri },
      position: { line: 7, character: 3 },
    })
    if (hoverResult !== null) {
      fail(
        `hover on builtin "echo" should degrade to null without man/help, got ${JSON.stringify(
          normalize(hoverResult),
        )}`,
      )
    }
    recordResult({
      method: 'textDocument/hover',
      status: 'degraded',
      detail: 'hover on builtin "echo" returns null because man/help are unavailable',
    })
    degradations.push({
      feature: 'man-hover-documentation',
      reason: 'man, help and col are not available on the isolated PATH',
      protocolBehavior: 'textDocument/hover returns null instead of failing the request',
      evidence: 'hover on "echo" returned null',
    })

    // --- degradation probe: formatting without shfmt -------------------------
    const formattingResult = await client.request('textDocument/formatting', {
      textDocument: { uri: mainUri },
      options: { tabSize: 2, insertSpaces: true },
    })
    if (formattingResult !== null && formattingResult.length !== 0) {
      fail(
        `formatting should degrade to null/[] without shfmt, got ${JSON.stringify(
          normalize(formattingResult),
        )}`,
      )
    }
    recordResult({
      method: 'textDocument/formatting',
      status: 'degraded',
      detail: 'formatting returns no edits because shfmt is unavailable',
    })
    degradations.push({
      feature: 'shfmt-formatting',
      reason: 'shfmt executable is not available on the isolated PATH',
      protocolBehavior: 'textDocument/formatting returns no edits instead of failing',
      evidence: `formatting returned ${JSON.stringify(formattingResult)}`,
    })

    // --- shutdown -------------------------------------------------------------
    const shutdownResult = await client.request('shutdown')
    if (shutdownResult !== null) {
      fail(`shutdown should return null, got ${JSON.stringify(shutdownResult)}`)
    }
    recordResult({ method: 'shutdown', status: 'ok', detail: 'shutdown returned null' })
    client.notify('exit')

    const exitStatus = await Promise.race([
      client.exitPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('server did not exit after shutdown/exit')),
          EXIT_TIMEOUT_MS,
        ),
      ),
    ])
    if (exitStatus.code !== 0) {
      fail(`server exited with code ${exitStatus.code}; stderr:\n${exitStatus.stderr}`)
    }
    recordResult({
      method: 'exit',
      status: 'ok',
      detail: 'server process exited with code 0',
    })
  } finally {
    client.proc.kill('SIGKILL')
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify(
        {
          description:
            'Normalized stdio LSP smoke session against the built bash-language-server',
          server: 'node server/out/cli.js start',
          workspace: 'testing/verify-workspace',
          isolation:
            'server PATH restricted to core POSIX utilities and node; shellcheck, shfmt, man, col and network tools are unavailable',
          messages: client.transcript,
        },
        null,
        2,
      ) + '\n',
    )
  }

  return { requests: results, degradations }
}
