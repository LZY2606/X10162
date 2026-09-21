import { spawnSync } from 'child_process'

const executablePresenceCache = new Map<string, boolean>()

/**
 * Whether an executable is available on PATH. The result is cached per name.
 */
export function hasExecutable(name: string): boolean {
  let present = executablePresenceCache.get(name)
  if (present === undefined) {
    const result = spawnSync(name, ['--version'], { stdio: 'ignore' })
    present = !result.error && result.status === 0
    executablePresenceCache.set(name, present)
  }
  return present
}

/**
 * Jest helpers that skip tests requiring an optional external tool when it is
 * not installed, so that offline runs (e.g. `pnpm run verify:offline`) still
 * pass on machines without ShellCheck or shfmt. CI jobs that install the
 * tools run the full suite.
 */
export function describeIfExecutable(name: string): jest.Describe {
  return hasExecutable(name) ? describe : describe.skip
}

export function itIfExecutable(name: string): jest.It {
  return hasExecutable(name) ? it : it.skip
}
