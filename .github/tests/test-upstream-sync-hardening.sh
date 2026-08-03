#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; LIB="$ROOT/.github/scripts/upstream-sync-lib.sh"; WORKFLOW="$ROOT/.github/workflows/upstream-sync.yml"; failures=0
fail() { printf 'not ok - %s\n' "$1" >&2; failures=$((failures + 1)); }; pass() { printf 'ok - %s\n' "$1"; }; contains() { grep -Fq -- "$2" <<<"$1"; }; file_contains() { grep -Fq -- "$2" "$1"; }
make_repo() { fixture_root="$(mktemp -d)"; repo="$fixture_root/repo"; origin="$fixture_root/origin.git"; mkdir -p "$repo"; git init -q "$repo"; git -C "$repo" config user.name test; git -C "$repo" config user.email test@example.invalid; git -C "$repo" checkout -q -b singbox; printf 'base\n' >"$repo/state"; git -C "$repo" add state; git -C "$repo" commit -q -m base; git init -q --bare "$origin"; git -C "$repo" remote add origin "$origin"; git -C "$repo" push -q origin HEAD:singbox; printf 'fork\n' >>"$repo/state"; git -C "$repo" add state; git -C "$repo" commit -q -m fork; git -C "$repo" checkout -q -b upstream-main HEAD~1; printf 'upstream\n' >"$repo/upstream-only"; git -C "$repo" add upstream-only; git -C "$repo" commit -q -m upstream; upstream_sha="$(git -C "$repo" rev-parse HEAD)"; git -C "$repo" checkout -q singbox; mock_bin="$fixture_root/bin"; mkdir -p "$mock_bin"; real_git="$(command -v git)"; cat >"$mock_bin/git" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = ls-remote ]; then printf '%s\trefs/tags/%s^{}\n' "$FAKE_UPSTREAM_COMMIT" "$FAKE_TAG"; exit 0; fi
if [ "${1:-}" = merge ] && [ "${2:-}" = --abort ] && [ "${FAKE_ABORT:-0}" = 1 ]; then exit 77; fi
exec "$REAL_GIT" "$@"
EOF
chmod +x "$mock_bin/git"; }
test_resolver_stable() { make_repo; cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = api ]; then
    printf '%s\n' '[{"tag_name":"3.2.0-rc.1","published_at":"2026-08-01T00:00:00Z","draft":false,"prerelease":true},{"tag_name":"3.2.0","html_url":"https://example.invalid/3.2.0","published_at":"2026-08-02T00:00:00Z","draft":false,"prerelease":false}]'
    exit 0
fi
exit 2
EOF
chmod +x "$mock_bin/gh"; output="$fixture_root/output"; result="$(cd "$repo"; PATH="$mock_bin:$PATH" GIT_BIN="$mock_bin/git" REAL_GIT="$real_git" FAKE_UPSTREAM_COMMIT="$upstream_sha" FAKE_TAG=3.2.0 UPSTREAM_REPO=remnawave/test GITHUB_OUTPUT="$output" bash "$LIB" resolve 2>&1)" || return 1; contains "$result" 'tag=3.2.0' && contains "$result" 'version=3.2.0'; }
 test_workflow_and_dual_core_contract() { file_contains "$WORKFLOW" '*/5 * * * *' || return 1; [ -z "$(awk '/^jobs:/{exit} /\$\{\{ runner\.temp \}\}/{print NR}' "$WORKFLOW")" ] || return 1; file_contains "$WORKFLOW" 'workflow_dispatch:' || return 1; file_contains "$WORKFLOW" 'cancel-in-progress: false' || return 1; file_contains "$WORKFLOW" 'WORKFLOW_TOKEN' || return 1; file_contains "$WORKFLOW" 'upstream-sync-lib.sh preflight' || return 1; file_contains "$WORKFLOW" 'upstream-sync-lib.sh package' || return 1; file_contains "$WORKFLOW" 'actions/upload-artifact@v4' || return 1; file_contains "$WORKFLOW" 'git push origin HEAD:singbox' || return 1; file_contains "$WORKFLOW" 'validate:dual-core'; preflight_line="$(grep -n -m1 'upstream-sync-lib.sh preflight' "$WORKFLOW" | cut -d: -f1)"; docker_line="$(grep -n -m1 'docker/build-push-action' "$WORKFLOW" | cut -d: -f1)"; [ "$preflight_line" -lt "$docker_line" ]; }
test_upstream_tag_fetch_is_namespaced() { file_contains "$WORKFLOW" 'git fetch --no-tags upstream main' && file_contains "$WORKFLOW" 'git fetch --no-tags upstream "refs/tags/${{ steps.release.outputs.tag }}:refs/tags/upstream-release-${{ steps.release.outputs.tag }}"'; }
test_checkout_and_readonly_resolver_use_built_in_token() { file_contains "$WORKFLOW" 'token: ${{ github.token }}' && file_contains "$WORKFLOW" 'GH_TOKEN: ${{ github.token }}' && file_contains "$WORKFLOW" 'WORKFLOW_TOKEN: ${{ secrets.WORKFLOW_TOKEN }}'; }
run_case() { if "$1"; then pass "$1"; else fail "$1"; fi; }; run_case test_resolver_stable; run_case test_workflow_and_dual_core_contract; run_case test_upstream_tag_fetch_is_namespaced; run_case test_checkout_and_readonly_resolver_use_built_in_token; [ "$failures" -eq 0 ] || exit 1; printf 'all upstream hardening tests passed\n'
