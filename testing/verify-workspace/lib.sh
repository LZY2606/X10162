#!/usr/bin/env bash
# Shared helpers for the offline verification workspace.

# Print a greeting for the given name.
greet_user() {
  local name="$1"
  echo "hello ${name}"
}
