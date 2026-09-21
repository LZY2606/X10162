#!/usr/bin/env bash
# Greet a name, falling back to a default.

VERIFY_DEFAULT_NAME="world"

verify_greet() {
  local name="${1:-$VERIFY_DEFAULT_NAME}"
  echo "Hello, ${name}!"
}
