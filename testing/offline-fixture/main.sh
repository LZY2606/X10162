#!/usr/bin/env bash

# Fixed workspace for `pnpm run verify:offline`. It exercises tree-sitter
# parsing, the symbol index and cross-file source resolution over real stdio.

source ./library.sh

greet_main() {
  greet_library
  echo "$LIBRARY_MESSAGE"
}

greet_main
