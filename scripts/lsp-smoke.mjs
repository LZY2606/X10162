#!/usr/bin/env node
/**
 * Drives a real stdio LSP smoke session against the compiled server
 * (server/out/cli.js) using the fixed workspace in testing/verify-workspace.
 *
 * The server is spawned with an isolated, empty PATH so that the optional
 * external tools (ShellCheck, shfmt, man pages) are unavailable and the
 * protocol-level degradation can be verified: those capabilities must
 * degrade gracefully while the remaining requests keep succeeding.
 *
 * The normalized transcript and per-request results are written to
 * artifacts/lsp-smoke.json. URIs, temporary directories, process ids and
 * elapsed times are normalized so the artifact is stable across machines.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = join(REPO_ROOT, 'testing', 'verify-workspace')
const WORKSPACE_URI = pathToFileURL(WORKSPACE).href
const REPO_URI = pathToFileURL(REPO_ROOT).href
const SERVER_CLI = join(REPO_ROOT, 'server', 'out', 'cli.js')
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts')
const TRANSCRIPT_PATH = join(ARTIFACTS_DIR, 'lsp-smoke.json')

const MAIN_DOCUMENT = join(WORKSPACE, 'main.sh')
const MAIN_DOCUMENT_URI = pathToFileURL(MAIN_DOCUMENT).href

const NOTIFICATION_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000

function normalize(value) {
  if (typeof value === 'string') {
    return value
      .split(WORKSPACE_URI)
      .join('file://<workspace>')
      .split(WORKSPACE)
      .join('<workspace>')
      .split(REPO_URI)
      .join('file://<repo>')
      .split(REPO_ROOT)
      .join('<repo>')
      .replace(/^\d{2}:\d{2}:\d{2}\.\d{3} /, '') // log line timestamp
      .replace(/\d+(\.\d+)? seconds/g, '<elapsed> seconds')
  }
  if (Array.isArray(value)) {
    return value.map(normalize)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, normalize(v)]))
  }
  return value
}

class LspClient {
  constructor(process_) {
    this.process = process_
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.waiters = []
    process_.stdout.on('data', (chunk) => this.handleData(chunk))
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) {
        throw new Error(`Invalid LSP header: ${header}`)
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const message = JSON.parse(this.buffer.subarray(start, start + length).toString('utf8'))
      this.buffer = this.buffer.subarray(start + length)
      this.dispatch(message)
    }
  }

  dispatch(message) {
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (entry) {
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.settle(message)
      }
      return
    }
    if (message.id !== undefined && message.method !== undefined) {
      // A server -> client request. The smoke client declares no dynamic
      // capabilities, so answer everything with a null result.
      this.send({ jsonrpc: '2.0', id: message.id, result: null })
      return
    }
    this.notifications.push(message)
    this.waiters = this.waiters.filter((waiter) => !waiter.tryResolve(message))
  }

  send(message) {
    const json = JSON.stringify(message)
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
  }

  request(method, params) {
    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, params }
    this.send(message)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for the response to ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        settle: (response) => {
          if (response.error) {
            reject(
              new Error(`${method} failed: ${response.error.code} ${response.error.message}`),
            )
          } else {
            resolve({ request: message, response })
          }
        },
        timer,
      })
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  waitForNotification(predicate, description) {
    const existing = this.notifications.find(predicate)
    if (existing) {
      return Promise.resolve(existing)
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for notification: ${description}`))
      }, NOTIFICATION_TIMEOUT_MS)
      this.waiters.push({
        tryResolve: (message) => {
          if (predicate(message)) {
            clearTimeout(timer)
            resolvePromise(message)
            return true
          }
          return false
        },
      })
    })
  }
}

function fail(message) {
  throw new Error(message)
}

async function main() {
  if (!existsSync(SERVER_CLI)) {
    fail('Compiled server not found at server/out/cli.js. Run "pnpm compile" first.')
  }

  // An empty directory as PATH guarantees that shellcheck, shfmt, man and
  // friends cannot be picked up from the host, no matter what is installed.
  const isolatedPath = mkdtempSync(join(tmpdir(), 'bash-lsp-verify-path-'))
  const isolatedEnv = { PATH: isolatedPath }
  if (process.platform === 'win32') {
    isolatedEnv.SYSTEMROOT = process.env.SYSTEMROOT
  }

  const server = spawn(process.execPath, [SERVER_CLI, 'start'], {
    env: isolatedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  server.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const client = new LspClient(server)
  const exchanges = []
  const results = []
  const degradations = []

  const record = (direction, message) => {
    exchanges.push(normalize({ direction, ...message }))
  }

  const request = async (method, params, expect) => {
    const { request: sent, response } = await client.request(method, params)
    record('client -> server', sent)
    record('server -> client', response)
    if (expect) {
      expect(response.result)
    }
    results.push({ method, status: 'ok' })
    return response.result
  }

  const notify = (method, params) => {
    client.notify(method, params)
    record('client -> server', { jsonrpc: '2.0', method, params })
    results.push({ method, status: 'ok' })
  }

  try {
    await request(
      'initialize',
      {
        processId: null,
        rootUri: WORKSPACE_URI,
        capabilities: {},
        workspaceFolders: [{ uri: WORKSPACE_URI, name: 'verify-workspace' }],
        initializationOptions: {},
      },
      (result) => {
        if (!result?.capabilities?.completionProvider) {
          fail('initialize did not return the expected server capabilities')
        }
      },
    )

    notify('initialized', {})

    notify('textDocument/didOpen', {
      textDocument: {
        uri: MAIN_DOCUMENT_URI,
        languageId: 'shellscript',
        version: 1,
        text: readFileSync(MAIN_DOCUMENT, 'utf8'),
      },
    })

    // The analysis diagnostics and the background analysis must still
    // complete, and ShellCheck must report its protocol-level degradation.
    const [diagnostics, shellcheckWarning, backgroundCompleted] = await Promise.all([
      client.waitForNotification(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          message.params?.uri === MAIN_DOCUMENT_URI,
        'textDocument/publishDiagnostics for main.sh',
      ),
      client.waitForNotification(
        (message) =>
          message.method === 'window/logMessage' &&
          /ShellCheck: disabling linting/.test(message.params?.message ?? ''),
        'ShellCheck degradation warning',
      ),
      client.waitForNotification(
        (message) =>
          message.method === 'window/logMessage' &&
          /BackgroundAnalysis: Completed/.test(message.params?.message ?? ''),
        'background analysis completion',
      ),
    ])
    void backgroundCompleted

    if (!Array.isArray(diagnostics.params.diagnostics)) {
      fail('publishDiagnostics did not carry a diagnostics array')
    }
    degradations.push({
      capability: 'shellcheck',
      status: 'degraded',
      reason: 'no shellcheck executable on the isolated PATH',
      evidence: normalize(shellcheckWarning.params.message),
    })

    await request(
      'textDocument/completion',
      {
        textDocument: { uri: MAIN_DOCUMENT_URI },
        position: { line: 14, character: 3 }, // after `gre`
      },
      (result) => {
        const labels = (result ?? []).map((item) => item.label)
        if (!labels.includes('greet_user')) {
          fail(`completion did not offer greet_user from the sourced lib.sh: ${labels}`)
        }
      },
    )

    await request(
      'textDocument/definition',
      {
        textDocument: { uri: MAIN_DOCUMENT_URI },
        position: { line: 9, character: 4 }, // greet_user call site
      },
      (result) => {
        const locations = Array.isArray(result) ? result : result ? [result] : []
        if (!locations.some((location) => location.uri?.endsWith('/lib.sh'))) {
          fail('definition did not resolve greet_user into lib.sh')
        }
      },
    )

    await request(
      'textDocument/documentSymbol',
      { textDocument: { uri: MAIN_DOCUMENT_URI } },
      (result) => {
        if (!JSON.stringify(result).includes('deploy_app')) {
          fail('documentSymbol did not report deploy_app')
        }
      },
    )

    await request(
      'textDocument/prepareRename',
      {
        textDocument: { uri: MAIN_DOCUMENT_URI },
        position: { line: 13, character: 3 }, // deploy_app call site
      },
      (result) => {
        if (!result?.range && !result?.start) {
          fail('prepareRename did not return a rename preview range')
        }
      },
    )

    // Optional capabilities that must degrade per protocol: hover over the
    // echo builtin needs help/man, formatting needs shfmt. Both return null.
    const hover = await request('textDocument/hover', {
      textDocument: { uri: MAIN_DOCUMENT_URI },
      position: { line: 10, character: 3 }, // echo
    })
    if (hover !== null) {
      fail('expected hover to degrade to null without man pages on the isolated PATH')
    }
    degradations.push({
      capability: 'man-pages',
      status: 'degraded',
      reason: 'no man, col or bash executables on the isolated PATH',
      evidence: 'textDocument/hover returned null for the echo builtin',
    })

    const formatting = await request('textDocument/formatting', {
      textDocument: { uri: MAIN_DOCUMENT_URI },
      options: { tabSize: 2, insertSpaces: true },
    })
    if (!Array.isArray(formatting) || formatting.length !== 0) {
      fail('expected formatting to degrade to an empty edit list without shfmt')
    }
    const shfmtWarning = await client.waitForNotification(
      (message) =>
        message.method === 'window/logMessage' &&
        /Shfmt: disabling formatting/.test(message.params?.message ?? ''),
      'Shfmt degradation warning',
    )
    degradations.push({
      capability: 'shfmt',
      status: 'degraded',
      reason: 'no shfmt executable on the isolated PATH',
      evidence: normalize(shfmtWarning.params.message),
    })

    degradations.push({
      capability: 'explainshell',
      status: 'disabled',
      reason: 'explainshellEndpoint is not configured; no network access is required',
      evidence: 'initializationOptions did not set explainshellEndpoint',
    })

    await request('shutdown', null, (result) => {
      if (result !== null) {
        fail('shutdown did not return null')
      }
    })
    notify('exit')

    const exitCode = await new Promise((resolveExit) => {
      server.once('exit', (code) => resolveExit(code))
      setTimeout(() => resolveExit('timeout'), REQUEST_TIMEOUT_MS)
    })
    if (exitCode !== 0) {
      fail(`server exited with code ${exitCode}. stderr:\n${stderr}`)
    }

    const serverNotifications = client.notifications
      .map((message) => normalize(message))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    writeFileSync(
      TRANSCRIPT_PATH,
      `${JSON.stringify(
        {
          workspace: 'testing/verify-workspace',
          server: 'server/out/cli.js',
          environment: {
            PATH: '<isolated empty directory>',
            note: 'the server is spawned with an empty PATH so optional external tools are unavailable',
          },
          exchanges,
          serverNotifications,
          results,
          degradations,
        },
        null,
        2,
      )}\n`,
    )

    console.log(
      `LSP smoke session passed: ${results.length} requests, ` +
        `${degradations.length} verified degradations. ` +
        'Transcript: artifacts/lsp-smoke.json',
    )
  } finally {
    server.kill('SIGKILL')
    rmSync(isolatedPath, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`LSP smoke session failed: ${error.message ?? error}`)
  process.exit(1)
})
