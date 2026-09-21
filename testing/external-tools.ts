import { execFileSync } from 'node:child_process'

/**
 * Test support for integration tests that spawn real external executables.
 *
 * The offline verification pipeline runs without ShellCheck, shfmt, man pages
 * and other optional tools on PATH, so tests that need them skip explicitly in
 * that environment instead of failing. CI still runs the full assertions on
 * jobs where these tools are installed.
 */
export type ExternalTool =
  | 'bash'
  | 'col'
  | 'help'
  | 'man'
  | 'ps'
  | 'rm'
  | 'shellcheck'
  | 'shfmt'

const toolProbes: Record<ExternalTool, () => boolean> = {
  bash: () => isExecutableAvailable('bash', ['--version']),
  col: () => isExecutableAvailable('col', ['-V']),
  // `help` is a builtin rather than an executable; probing it needs bash.
  help: () => {
    try {
      execFileSync('bash', ['--noprofile', '--norc', '-c', 'help echo >/dev/null'])
      return true
    } catch {
      return false
    }
  },
  man: () => isExecutableAvailable('man', ['--version']),
  ps: () => isExecutableAvailable('ps', ['-p', String(process.pid)]),
  rm: () => isExecutableAvailable('rm', ['--version']),
  shellcheck: () => isExecutableAvailable('shellcheck', ['--version']),
  shfmt: () => isExecutableAvailable('shfmt', ['--version']),
}

const cache: Partial<Record<ExternalTool, boolean>> = {}

export function isToolAvailable(tool: ExternalTool): boolean {
  const cached = cache[tool]
  if (cached !== undefined) {
    return cached
  }
  const available = toolProbes[tool]()
  cache[tool] = available
  return available
}

/**
 * Returns true (and warns once) when all given tools are unavailable, so the
 * caller can skip an integration test. Mirrors the soft-skip style already
 * used for getCommandOptions-dependent tests.
 */
export function skipIfToolsUnavailable(...tools: ExternalTool[]): boolean {
  const missing = tools.filter((tool) => !isToolAvailable(tool))
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `Skipping test as the following tool(s) are unavailable on PATH: ${missing.join(
        ', ',
      )}`,
    )
    return true
  }
  return false
}

function isExecutableAvailable(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
    return true
  } catch (error) {
    // A non-zero exit still proves the executable exists.
    return (error as { code?: string }).code !== 'ENOENT'
  }
}
