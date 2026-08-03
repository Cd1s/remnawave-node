#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_VERSION:?EXPECTED_VERSION is required}"
PACKAGE_PATH="${PACKAGE_PATH:-package.json}"

package_version="$(node -p "require(require('node:path').resolve(process.argv[1])).version" "$PACKAGE_PATH")"
if [ "$package_version" != "$EXPECTED_VERSION" ]; then
    echo "release_sync=failed reason=package_version_mismatch expected=$EXPECTED_VERSION actual=$package_version" >&2
    exit 1
fi

echo "package_version=$package_version"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'version=%s\n' "$package_version" >>"$GITHUB_OUTPUT"
fi
