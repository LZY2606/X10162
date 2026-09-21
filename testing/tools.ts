/**
 * Optional external tool detection for the test suite.
 *
 * ShellCheck, shfmt and the man page toolchain are optional runtime
 * dependencies: the server degrades gracefully when they are missing. Tests
 * that exercise the real executables (rather than mocks) skip themselves when
 * the tool is not on PATH so that the suite passes both on fully equipped
 * machines and in minimal offline environments (see `pnpm run verify:offline`).
 */
import * as fs from 'fs'
import * as path from 'path'

export function hasExecutable(name: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

export const hasShellcheck = hasExecutable('shellcheck')
export const hasShfmt = hasExecutable('shfmt')

/** Hover and completion documentation shells out to bash's help, man and col. */
export const hasShellDocumentationTools = ['bash', 'man', 'col'].every(hasExecutable)

export const describeIfShellcheck = hasShellcheck ? describe : describe.skip
export const describeIfShfmt = hasShfmt ? describe : describe.skip
export const itIfShellcheck = hasShellcheck ? it : it.skip
export const itIfShellDocumentation = hasShellDocumentationTools ? it : it.skip
