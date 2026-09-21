#!/usr/bin/env node
/**
 * Offline stdio LSP smoke session for bash-language-server.
 *
 * Spawns the compiled server (server/out/cli.js) over stdio with an isolated
 * PATH (only `node` is resolvable), so optional external tools — ShellCheck,
 * shfmt, man/col — are unavailable and the server must degrade gracefully
 * while the core requests keep working.
 *
 * Every request/response pair is written to the output directory as
 * normalized JSON (stable key order, workspace/tmp paths replaced by
 * placeholders). A machine-readable `summary.json` is produced for the
 * verify-offline manifest.
 *
 * Usage: node scripts/verify-offline-lsp-smoke.mjs [--out-dir DIR]
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_DIR = path.join(REPO_ROOT, 'testing', 'fixtures')
const DOCUMENT_PATH = path.join(WORKSPACE_DIR, 'sourcing.sh')
const SERVER_CLI = path.join(REPO_ROOT, 'server', 'out', 'cli.js')
const REQUEST_TIMEOUT_MS = 30_000

function parseArgs(argv) {
  const args = { outDir: path.join(REPO_ROOT, 'artifacts', 'lsp-smoke') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir') {
      args.outDir = path.resolve(argv[i + 1])
      i += 1
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

/** Create a directory containing only a `node` symlink for PATH isolation. */
function makeIsolatedPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bls-offline-path-'))
  fs.symlinkSync(process.execPath, path.join(dir, 'node'))
  return dir
}

/** Deterministic JSON: recursively sorted object keys, 2-space indent. */
function stableStringify(value) {
  const sortValue = (input) => {
    if (Array.isArray(input)) {
      return input.map(sortValue)
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sortValue(input[key])]),
      )
    }
    return input
  }
  return `${JSON.stringify(sortValue(value), null, 2)}\n`
}

function normalizePayload(value, replacements) {
  const normalize = (input) => {
    if (typeof input === 'string') {
      return replacements
        .reduce((text, [from, to]) => text.split(from).join(to), input)
        .replace(/\d{2}:\d{2}:\d{2}\.\d{3}/g, '<time>')
    }
    if (Array.isArray(input)) {
      return input.map(normalize)
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input).map(([key, val]) => [normalize(key), normalize(val)]),
      )
    }
    return input
  }
  return normalize(value)
}

class LspClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.buffer = Buffer.alloc(0)
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Server exited (code=${code} signal=${signal})`))
      }
      this.pending.clear()
    })
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) throw new Error(`Invalid LSP header: ${header}`)
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      this.#onMessage(JSON.parse(body))
    }
  }

  #onMessage(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
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
    } else if (message.method) {
      this.notifications.push(message)
    }
  }

  send(message) {
    const body = JSON.stringify(message)
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  request(method, params) {
    const id = this.nextId
    this.nextId += 1
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${method}`)),
        REQUEST_TIMEOUT_MS,
      )
      this.pending.set(id, { resolve, reject, timer, method })
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return { id, result }
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async waitForNotification(method, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.notifications.find(
        (n) => n.method === method && (!predicate || predicate(n)),
      )
      if (found) return found
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${method} notification`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2))
  fs.mkdirSync(outDir, { recursive: true })

  if (!fs.existsSync(SERVER_CLI)) {
    throw new Error(`Compiled server not found at ${SERVER_CLI}; run "pnpm compile" first`)
  }

  const isolatedBin = makeIsolatedPath()
  const workspaceUri = pathToFileURL(WORKSPACE_DIR).href
  const documentUri = pathToFileURL(DOCUMENT_PATH).href
  const documentText = fs.readFileSync(DOCUMENT_PATH, 'utf8')

  const replacements = [
    [workspaceUri, 'file:///<workspace>'],
    [WORKSPACE_DIR, '<workspace>'],
    [REPO_ROOT, '<repo>'],
    [os.tmpdir(), '<tmp>'],
  ]

  const child = spawn(process.execPath, [SERVER_CLI, 'start'], {
    env: {
      PATH: isolatedBin,
      LANG: 'C.UTF-8',
      BASH_IDE_LOG_LEVEL: 'warning',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const client = new LspClient(child)

  const requests = []
  const failures = []
  let sequence = 0
  let diagnostics = []
  let completionItems = []
  let shellcheckDegraded = false
  let shfmtDegraded = false

  async function step(method, params, check) {
    sequence += 1
    const label = `${String(sequence).padStart(2, '0')}-${method.replace(/\//g, '_')}`
    const { result } = client.request(method, params)
    let response
    let error = null
    try {
      response = await result
    } catch (err) {
      error = err
    }
    fs.writeFileSync(
      path.join(outDir, `${label}.request.json`),
      stableStringify(normalizePayload({ jsonrpc: '2.0', method, params }, replacements)),
    )
    fs.writeFileSync(
      path.join(outDir, `${label}.response.json`),
      stableStringify(
        normalizePayload(
          error ? { error: String(error) } : { jsonrpc: '2.0', result: response ?? null },
          replacements,
        ),
      ),
    )
    let status = error ? 'failed' : 'ok'
    let detail = error ? String(error) : undefined
    if (!error && check) {
      try {
        check(response)
      } catch (err) {
        status = 'failed'
        detail = String(err && err.message ? err.message : err)
      }
    }
    if (status === 'failed') failures.push(`${method}: ${detail}`)
    requests.push({ seq: sequence, method, status, ...(detail ? { detail } : {}) })
    return response
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  try {
    await step(
      'initialize',
      {
        processId: null,
        rootUri: workspaceUri,
        capabilities: {},
        workspaceFolders: [{ uri: workspaceUri, name: 'fixtures' }],
        initializationOptions: { backgroundAnalysisMaxFiles: 0 },
      },
      (result) => {
        assert(result && result.capabilities, 'initialize returned no capabilities')
        assert(result.capabilities.completionProvider, 'missing completionProvider')
        assert(result.capabilities.definitionProvider, 'missing definitionProvider')
        assert(result.capabilities.renameProvider, 'missing renameProvider')
      },
    )

    client.notify('initialized', {})

    client.notify('textDocument/didOpen', {
      textDocument: {
        uri: documentUri,
        languageId: 'shellscript',
        version: 1,
        text: documentText,
      },
    })
    requests.push({ seq: ++sequence, method: 'textDocument/didOpen', status: 'ok' })

    // Linting degrades when ShellCheck is missing: diagnostics must still be
    // published (empty), never shellcheck-sourced.
    const diagnosticsNotification = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (n) => n.params && n.params.uri === documentUri,
      REQUEST_TIMEOUT_MS,
    )
    diagnostics = diagnosticsNotification.params.diagnostics
    const shellcheckDiagnostics = diagnostics.filter((d) => d.source === 'shellcheck')
    shellcheckDegraded = shellcheckDiagnostics.length === 0
    if (!shellcheckDegraded) {
      failures.push('publishDiagnostics: unexpected shellcheck diagnostics without shellcheck')
    }

    // `echo $BLU` (line 6): complete at end of the word.
    const completion = await step(
      'textDocument/completion',
      {
        textDocument: { uri: documentUri },
        position: { line: 6, character: 9 },
      },
      (result) => {
        const items = Array.isArray(result) ? result : result && result.items
        assert(Array.isArray(items) && items.length > 0, 'completion returned no items')
      },
    )
    completionItems = Array.isArray(completion) ? completion : completion.items

    // `echo $RED` (line 4): RED is defined in the sourced extension.inc.
    await step(
      'textDocument/definition',
      {
        textDocument: { uri: documentUri },
        position: { line: 4, character: 7 },
      },
      (result) => {
        const locations = Array.isArray(result) ? result : [result]
        assert(
          locations.some((loc) => loc && loc.uri && loc.uri.endsWith('extension.inc')),
          'definition did not resolve into sourced extension.inc',
        )
      },
    )

    await step(
      'textDocument/documentSymbol',
      { textDocument: { uri: documentUri } },
      (result) => {
        assert(Array.isArray(result) && result.length > 0, 'documentSymbol returned nothing')
      },
    )

    // Rename preview: resolve the renameable range, then compute (but do not
    // apply) the workspace edit for renaming RED to CRIMSON.
    await step(
      'textDocument/prepareRename',
      {
        textDocument: { uri: documentUri },
        position: { line: 4, character: 7 },
      },
      (result) => {
        // The result may be a bare Range or { range, placeholder }.
        const range = result && (result.range || result)
        assert(range && range.start && range.end, 'prepareRename returned no range')
      },
    )

    await step(
      'textDocument/rename',
      {
        textDocument: { uri: documentUri },
        position: { line: 4, character: 7 },
        newName: 'CRIMSON',
      },
      (result) => {
        const files = Object.keys((result && result.changes) || {})
        assert(
          files.some((uri) => uri.endsWith('sourcing.sh')) &&
            files.some((uri) => uri.endsWith('extension.inc')),
          'rename edit did not span sourcing.sh and extension.inc',
        )
      },
    )

    // shfmt is unavailable in the isolated environment: formatting must
    // degrade to an empty edit list instead of an error.
    const formatting = await step(
      'textDocument/formatting',
      {
        textDocument: { uri: documentUri },
        options: { tabSize: 2, insertSpaces: true },
      },
      (result) => {
        assert(Array.isArray(result), 'formatting did not return an edit array')
      },
    )
    shfmtDegraded = Array.isArray(formatting) && formatting.length === 0
    if (!shfmtDegraded) {
      failures.push('formatting: expected degraded (empty) result without shfmt')
    }

    await step('shutdown', null)
    client.notify('exit')
  } finally {
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(null)
      }, 5000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    if (exitCode !== 0) {
      failures.push(`server exited with code ${exitCode}`)
    }
    fs.rmSync(isolatedBin, { recursive: true, force: true })
  }

  fs.writeFileSync(
    path.join(outDir, 'notifications.json'),
    stableStringify(normalizePayload(client.notifications, replacements)),
  )

  const degradations = [
    {
      capability: 'shellcheckDiagnostics',
      reason: 'shellcheck executable not on PATH (isolated environment)',
      degraded: shellcheckDegraded,
    },
    {
      capability: 'shfmtFormatting',
      reason: 'shfmt executable not on PATH (isolated environment)',
      degraded: shfmtDegraded,
    },
    {
      capability: 'externalDocumentation',
      reason: 'man/col executables not on PATH (isolated environment)',
      degraded: true,
    },
    {
      capability: 'explainshellHover',
      reason: 'explainshellEndpoint unset; no network access used',
      degraded: true,
    },
  ]

  const summary = {
    workspace: 'testing/fixtures',
    document: 'testing/fixtures/sourcing.sh',
    requests,
    degradations,
    diagnosticsReceived: diagnostics.length,
    completionItems: completionItems.length,
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), stableStringify(summary))

  if (failures.length > 0) {
    console.error(`LSP smoke session failed:\n - ${failures.join('\n - ')}`)
    process.exit(1)
  }
  console.log(`LSP smoke session passed (${requests.length} requests, artifacts in ${outDir})`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
