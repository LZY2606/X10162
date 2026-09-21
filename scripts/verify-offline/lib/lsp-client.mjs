import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const CRLF = '\r\n'

/**
 * Minimal JSON-RPC 2.0 client speaking LSP framing over a real child
 * process's stdin/stdout. Unlike a mocked connection this exercises the
 * compiled server binary exactly the way an editor would.
 */
export class LspClient extends EventEmitter {
  constructor({ command, args, env, cwd }) {
    super()
    this.nextId = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.proc = null
    this.command = command
    this.args = args
    this.env = env
    this.cwd = cwd
  }

  start() {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()))
    this.proc.on('exit', (code, signal) => {
      this.exit = { code, signal }
      this.emit('exit', this.exit)
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error(`language server exited (code=${code} signal=${signal})`))
      }
      this.pending.clear()
    })

    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      this.proc.once('error', onError)
      this.proc.on('spawn', () => {
        this.proc.removeListener('error', onError)
        resolve()
      })
    })
  }

  get pid() {
    return this.proc ? this.proc.pid : null
  }

  onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.parseBuffer()
  }

  parseBuffer() {
    for (;;) {
      const headerEnd = this.buffer.indexOf(`${CRLF}${CRLF}`)
      if (headerEnd === -1) return

      const headerText = this.buffer.subarray(0, headerEnd).toString()
      const contentLength = Number(
        headerText
          .split(CRLF)
          .map((line) => line.match(/^Content-Length:\s*(\d+)$/i))
          .filter(Boolean)[0]?.[1],
      )
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        throw new Error(`Invalid LSP message header: ${JSON.stringify(headerText)}`)
      }

      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + contentLength) return

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength)
      this.buffer = this.buffer.subarray(bodyStart + contentLength)

      let message
      try {
        message = JSON.parse(body.toString())
      } catch (error) {
        throw new Error(`Failed to parse LSP message body: ${error.message}`)
      }
      this.dispatch(message)
    }
  }

  dispatch(message) {
    if (
      Object.prototype.hasOwnProperty.call(message, 'id') &&
      this.pending.has(message.id)
    ) {
      const { resolve, reject, timer } = this.pending.get(message.id)
      clearTimeout(timer)
      this.pending.delete(message.id)
      if (message.error)
        reject(Object.assign(new Error(message.error.message), message.error))
      else resolve(message)
      return
    }
    this.emit('notification', message)
  }

  send(method, params) {
    const message = { jsonrpc: '2.0', method, params: params ?? null }
    this.write(message)
  }

  request(method, params, { timeoutMs = 30000 } = {}) {
    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, params: params ?? null }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(`LSP request ${method} (id=${id}) timed out after ${timeoutMs}ms`),
        )
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write(message)
    })
  }

  write(message) {
    const body = JSON.stringify(message)
    const frame = `Content-Length: ${Buffer.byteLength(body)}${CRLF}${CRLF}${body}`
    this.proc.stdin.write(frame)
  }

  async stop() {
    if (!this.proc || this.proc.killed || this.exit) return this.exit ?? null
    const exit = new Promise((resolve) => this.once('exit', resolve))
    this.proc.stdin.end()
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5000))])
    if (!this.exit) this.proc.kill('SIGKILL')
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 2000))])
    return this.exit ?? null
  }
}
