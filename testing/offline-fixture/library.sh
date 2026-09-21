#!/usr/bin/env bash

# Fixed fixture consumed by the offline LSP smoke session. Symbols defined
# here must resolve from main.sh through the `source` statement below.

greet_library() {
  echo "hello from library.sh"
}

LIBRARY_MESSAGE="greetings from the library"
