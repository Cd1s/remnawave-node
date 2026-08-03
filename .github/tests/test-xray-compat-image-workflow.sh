#!/usr/bin/env bash
set -euo pipefail

workflow="${1:-.github/workflows/xray-compat-image.yml}"
[[ -f "$workflow" ]] || { echo "missing workflow: $workflow" >&2; exit 1; }

require() {
  grep -Fq -- "$1" "$workflow" || { echo "missing required contract: $1" >&2; exit 1; }
}
forbid_text() {
  if grep -Fq -- "$1" "$workflow"; then
    echo "forbidden contract violation: $1" >&2
    exit 1
  fi
}
forbid_event() {
  if grep -Eq "^  $1:$" "$workflow"; then
    echo "forbidden event trigger: $1" >&2
    exit 1
  fi
}

require "workflow_dispatch:"
forbid_event "pull_request"
forbid_event "push"
forbid_event "schedule"
require "xray_core_version:"
require "image_tag:"
require "required: true"
require "invalid Xray core version"
require "invalid or reserved image tag"
require 'if [[ ! "$image_tag" =~ ^xray-v[0-9]+'
require '-us-compat-[0-9]{8}$ ]]'
require "linux/amd64,linux/arm64"
require "actions/setup-go@v5"
require "github.com/sagernet/sing-box/cmd/sing-box@v1.13.14"
require 'SINGBOX_BIN=$(go env GOPATH)/bin/sing-box'
require "RWNODE_VERSION=3.0.0"
require 'XRAY_CORE_VERSION=${{ inputs.xray_core_version }}'
require '${{ env.IMAGE }}:${{ inputs.image_tag }}'
require "steps.build.outputs.digest"
forbid_text '${{ env.IMAGE }}:singbox'
forbid_text '${{ env.IMAGE }}:latest'

echo "xray compatibility image workflow contract: PASS"
