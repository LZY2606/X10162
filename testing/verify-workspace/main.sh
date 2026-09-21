#!/usr/bin/env bash
# Entry point of the offline verification workspace.

source ./lib.sh

deploy_target="staging"

deploy_app() {
  local version="$1"
  greet_user "deploy-${version}"
  echo "deploying ${deploy_target}"
}

deploy_app "1.0.0"
gre
