# Offline verification workspace

This directory is a fixed in-repo workspace used by `pnpm run verify:offline`
(`scripts/verify/lsp-smoke-session.mjs`) to drive the compiled server over a real
stdio LSP connection.

The requests target well-known anchors that the harness locates by name at run
time, so keep the symbols below stable:

- `greet_library` — function defined in `lib.sh` and called from `main.sh`
  (cross-file definition, completion, document symbols and rename).
- `GREETING` — variable used in both files (cross-file rename preview).
