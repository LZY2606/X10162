#!/usr/bin/env node
/* Offline smoke session: drives the compiled server over real stdio LSP.
 *
 * The session is fully isolated from optional external tools by running the
 * server with a PATH that only contains an empty scratch directory. It
 * exercises initialize, didOpen, completion, cross-file definition,
 * document symbols, rename preparation/preview and graceful shutdown, plus
 * degradation probes (formatting without shfmt, man-page hover, diagnostics
 * without ShellCheck).
 *
 * Every request and response is recorded verbatim (then normalized by the
 * caller) into artifacts; responses must contain real payloads, not just the
 * request method names.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LspClient } from './lib/lsp-client.mjs'

const SERVER_ENTRY = 'server/out/cli.js'
const FIXTURE_FILES = ['main.sh', 'library.sh']

function fileUri(pathname) {
  let normalized = path.resolve(pathname)
  if (process.platform === 'win32') {
    normalized = normalized.replace(/\\/g, '/')
    return `file:///${normalized}`
  }
  return `file://${normalized}`
}

async function waitFor(predicate, { timeoutMs, description }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

export async function runSmokeSession({ repoRoot }) {
  const fixtureDir = path.join(repoRoot, 'testing', 'offline-fixture')
  const mainUri = fileUri(path.join(fixtureDir, 'main.sh'))
  const libraryUri = fileUri(path.join(fixtureDir, 'library.sh'))

  // An empty scratch directory on PATH means no shellcheck, shfmt, bash, man
  // or col binary is visible to the server, while PATH itself is defined.
  const emptyPathDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-offline-path-'))
  const tmpDir = os.tmpdir()
  const scratchCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-offline-cwd-'))

  // Reset proxy/network environment so no endpoint could be reached even if
  // one were configured; the default config disables explainshell regardless.
  const env = {
    PATH: emptyPathDir,
    BASH_IDE_LOG_LEVEL: 'info',
    NODE_NO_WARNINGS: '1',
  }

  const client = new LspClient({
    command: process.execPath,
    args: [path.join(repoRoot, SERVER_ENTRY), 'start'],
    env,
    cwd: scratchCwd,
  })

  const notifications = []
  const diagnosticsByUri = {}
  const logMessages = []
  const transcript = []
  const steps = []

  function record(kind, payload) {
    transcript.push({ seq: transcript.length + 1, kind, payload })
  }

  client.on('notification', (message) => {
    notifications.push(message)
    record('serverNotification', message)
    if (message.method === 'textDocument/publishDiagnostics') {
      diagnosticsByUri[message.params.uri] = message.params.diagnostics
    }
    if (message.method === 'window/logMessage') {
      logMessages.push(message.params.message)
    }
  })
  const stderrChunks = []
  client.on('stderr', (chunk) => stderrChunks.push(chunk))

  const started = Date.now()

  async function requestStep(name, method, params, options) {
    const begin = Date.now()
    const requestPayload = { jsonrpc: '2.0', id: null, method, params }
    record('request', requestPayload)
    let response = null
    let responseError = null
    try {
      response = await client.request(method, params, options)
      requestPayload.id = response.id
      record('response', response)
    } catch (err) {
      requestPayload.id = err.id ?? null
      responseError = {
        code: err.code ?? null,
        message: err.message ?? String(err),
        data: err.data ?? null,
      }
      record('responseError', {
        jsonrpc: '2.0',
        id: err.id ?? null,
        error: responseError,
      })
    }
    const durationMs = Date.now() - begin
    steps.push({ name, durationMs, error: responseError })
    return { name, request: requestPayload, response, error: responseError, durationMs }
  }

  function notifyStep(name, params) {
    client.send(name, params)
    record('notification', { jsonrpc: '2.0', method: name, params })
    steps.push({ name, durationMs: 0, error: null })
  }

  const assertions = []
  function check(name, passed, detail) {
    assertions.push({ name, passed: !!passed, detail: detail ?? null })
    if (!passed)
      throw new Error(`smoke assertion failed: ${name}${detail ? ` (${detail})` : ''}`)
  }

  try {
    await client.start()

    const initializeParams = {
      processId: process.pid,
      clientInfo: { name: 'verify-offline-smoke' },
      rootUri: fileUri(fixtureDir),
      capabilities: {},
    }
    const initialize = await requestStep('initialize', 'initialize', initializeParams)
    check(
      'initialize.advertises-core-capabilities',
      initialize.response?.result &&
        initialize.response.result.capabilities?.textDocumentSync !== undefined &&
        initialize.response.result.capabilities?.completionProvider &&
        initialize.response.result.capabilities?.definitionProvider === true &&
        initialize.response.result.capabilities?.documentSymbolProvider === true &&
        initialize.response.result.capabilities?.renameProvider?.prepareProvider === true,
    )

    notifyStep('initialized', {})

    const mainText = await fs.readFile(path.join(fixtureDir, 'main.sh'), 'utf8')
    notifyStep('textDocument/didOpen', {
      textDocument: {
        uri: mainUri,
        languageId: 'shellscript',
        version: 1,
        text: mainText,
      },
    })

    // Wait for the post-open analysis/diagnostic publication. ShellCheck is
    // absent on PATH; the first lint attempt fails with ENOENT and the server
    // publishes tree-sitter-only diagnostics (an empty list for a clean file).
    await waitFor(() => Object.prototype.hasOwnProperty.call(diagnosticsByUri, mainUri), {
      timeoutMs: 20000,
      description: 'publishDiagnostics after didOpen',
    })

    // Completion on the "$LIBRA" prefix surfaces the variable declared in the
    // cross-file `source ./library.sh`, proving sourced-file symbols feed the
    // index used by the completion handler.
    const completionParams = {
      textDocument: { uri: mainUri },
      position: { line: 9, character: 17 },
    }
    const completion = await requestStep(
      'completion',
      'textDocument/completion',
      completionParams,
    )
    const completionItems = completion.response?.result ?? []
    const completionLabels = completionItems.map((item) => item.label)
    check(
      'completion.includes-sourced-variable',
      completionLabels.includes('LIBRARY_MESSAGE'),
      completionLabels.join(','),
    )
    check(
      'completion.payload-preserved',
      completionItems.some(
        (item) => item.label === 'LIBRARY_MESSAGE' && item.kind !== undefined,
      ),
      `items=${completionLabels.join('|')}`,
    )

    // Definition on the sourced function call lands in library.sh.
    const definitionParams = {
      textDocument: { uri: mainUri },
      position: { line: 8, character: 5 },
    }
    const definition = await requestStep(
      'definition',
      'textDocument/definition',
      definitionParams,
    )
    const definitionResult = definition.response?.result
    check(
      'definition.resolves-sourced-function-across-source',
      Array.isArray(definitionResult)
        ? definitionResult.some((location) => location.uri === libraryUri)
        : definitionResult?.uri === libraryUri,
      JSON.stringify(definitionResult),
    )

    // Definition on the sourced variable lands in library.sh as well.
    const variableDefinition = await requestStep(
      'definition-variable',
      'textDocument/definition',
      {
        textDocument: { uri: mainUri },
        position: { line: 9, character: 10 },
      },
    )
    const variableDefinitionResult = variableDefinition.response?.result
    check(
      'definition.resolves-sourced-variable-across-source',
      Array.isArray(variableDefinitionResult)
        ? variableDefinitionResult.some((location) => location.uri === libraryUri)
        : variableDefinitionResult?.uri === libraryUri,
      JSON.stringify(variableDefinitionResult),
    )

    // Document symbols expose the fixture's declarations.
    const documentSymbol = await requestStep(
      'documentSymbol',
      'textDocument/documentSymbol',
      { textDocument: { uri: mainUri } },
    )
    const symbolNames = (documentSymbol.response?.result ?? []).map((s) => s.name)
    check(
      'documentSymbol.lists-local-function',
      symbolNames.includes('greet_main'),
      symbolNames.join(','),
    )

    // Rename preview: prepareRename returns the target range of greet_main.
    const prepareRename = await requestStep(
      'prepareRename',
      'textDocument/prepareRename',
      {
        textDocument: { uri: mainUri },
        position: { line: 7, character: 9 },
        newName: 'greet_renamed',
      },
    )
    check(
      'prepareRename.returns-range',
      prepareRename.response?.result?.start?.line === 7,
      JSON.stringify(prepareRename.response?.result ?? prepareRename.error),
    )

    // Rename preview (not applied; the document is never saved): the workspace
    // edit lists every occurrence inside main.sh.
    const rename = await requestStep('rename', 'textDocument/rename', {
      textDocument: { uri: mainUri },
      position: { line: 7, character: 9 },
      newName: 'greet_renamed',
    })
    const renameChanges = rename.response?.result?.changes ?? {}
    check(
      'rename.preview-covers-occurrences',
      Array.isArray(renameChanges[mainUri]) && renameChanges[mainUri].length >= 2,
      JSON.stringify(renameChanges),
    )

    // Degradation probe: shfmt is absent, formatting returns null and the
    // Degradation probe: shfmt is absent, formatting resolves to an empty
    // edit list and the request still succeeds rather than erroring the
    // session. The handler never falls back to another formatter.
    const formatting = await requestStep(
      'formatting-degraded',
      'textDocument/formatting',
      {
        textDocument: { uri: mainUri },
        options: { tabSize: 2, insertSpaces: true },
      },
    )
    check(
      'formatting-degraded.degrades-without-shfmt',
      Array.isArray(formatting.response?.result) &&
        formatting.response.result.length === 0 &&
        formatting.error === null,
      JSON.stringify(formatting.response?.result ?? formatting.error),
    )

    // Degradation probe: an external command with no bash/man/col available
    // yields a null hover rather than a hang or a network lookup.
    const hover = await requestStep('hover-degraded', 'textDocument/hover', {
      textDocument: { uri: mainUri },
      position: { line: 9, character: 3 },
    })
    check(
      'hover-degraded.degrades-without-man-pages',
      hover.response?.result === null,
      JSON.stringify(hover.response?.result ?? hover.error),
    )

    // ShellCheck is absent: no diagnostic may claim source "shellcheck".
    const diagnostics = diagnosticsByUri[mainUri] ?? []
    check(
      'diagnostics.have-no-shellcheck-source',
      diagnostics.every((diagnostic) => diagnostic.source !== 'shellcheck'),
      JSON.stringify(diagnostics),
    )
    check(
      'degradation.reported-shellcheck-and-shfmt-unavailable',
      logMessages.some((message) => message.includes('ShellCheck: disabling linting')) &&
        logMessages.some((message) => message.includes('Shfmt: disabling formatting')),
      logMessages.join(' | '),
    )

    const shutdown = await requestStep('shutdown', 'shutdown', null)
    check('shutdown.returns-null', shutdown.response?.result === null)
    notifyStep('exit', null)

    return {
      ok: true,
      serverPid: client.pid,
      fixtureDir,
      tmpDir,
      cwd: scratchCwd,
      emptyPathDir,
      totalDurationMs: Date.now() - started,
      transcript,
      steps,
      assertions,
      notifications,
      logMessages,
      stderr: stderrChunks.join(''),
      fixture: {
        uris: { main: mainUri, library: libraryUri },
        files: Object.fromEntries(
          await Promise.all(
            FIXTURE_FILES.map(async (name) => [
              name,
              await fs.readFile(path.join(fixtureDir, name), 'utf8'),
            ]),
          ),
        ),
      },
    }
  } catch (error) {
    error.smokeContext = {
      logMessages,
      stderr: stderrChunks.join(''),
      notifications: notifications.slice(-10),
    }
    throw error
  } finally {
    await client.stop()
    await fs.rm(emptyPathDir, { recursive: true, force: true })
    await fs.rm(scratchCwd, { recursive: true, force: true })
  }
}
