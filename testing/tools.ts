import { accessSync, constants } from 'fs'
import { delimiter, join } from 'path'

/**
 * Whether the given executable can be found on the current PATH.
 *
 * Integration tests for optional external tools (ShellCheck, shfmt, man)
 * use this to skip themselves when the tool is not installed, so that the
 * unit test suite also passes on machines without the optional tooling.
 */
export function isExecutableAvailable(command: string): boolean {
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : ['']

  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) {
      continue
    }
    for (const extension of extensions) {
      try {
        accessSync(join(directory, `${command}${extension}`), constants.X_OK)
        return true
      } catch {
        // Not found in this directory; keep looking.
      }
    }
  }

  return false
}

export const SHELLCHECK_AVAILABLE = isExecutableAvailable('shellcheck')
export const SHFMT_AVAILABLE = isExecutableAvailable('shfmt')
export const MAN_AVAILABLE = isExecutableAvailable('man')
