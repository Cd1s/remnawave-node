#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/sync-release.sh"
LIB="$ROOT/.github/scripts/upstream-sync-lib.sh"
MERGE_SCRIPT="$ROOT/.github/scripts/merge-upstream.sh"
VERSION_SCRIPT="$ROOT/.github/scripts/verify-package-version.sh"
WORKFLOW="$ROOT/.github/workflows/upstream-sync.yml"
failures=0
fail() { printf 'not ok - %s\n' "$1" >&2; failures=$((failures + 1)); }
pass() { printf 'ok - %s\n' "$1"; }
assert_contains() { grep -Fq -- "$2" <<<"$1"; }
assert_file_contains() { grep -Fq -- "$2" "$1"; }
make_repo() {
    fixture_root="$(mktemp -d)"; repo="$fixture_root/repo"; origin="$fixture_root/origin.git"; mkdir -p "$repo"; git init -q "$repo"; git -C "$repo" config user.name test; git -C "$repo" config user.email test@example.invalid; git -C "$repo" checkout -q -b singbox
    printf 'base\n' >"$repo/state"; git -C "$repo" add state; git -C "$repo" commit -q -m base; old_sha="$(git -C "$repo" rev-parse HEAD)"; git init -q --bare "$origin"; git -C "$repo" remote add origin "$origin"; git -C "$repo" push -q origin HEAD:singbox
    if [ "${1:-}" = historical ]; then git -C "$repo" tag 2.8.0; git -C "$repo" push -q origin refs/tags/2.8.0; fi
    printf 'adapted\n' >>"$repo/state"; git -C "$repo" add state; git -C "$repo" commit -q -m adapted; new_sha="$(git -C "$repo" rev-parse HEAD)"; git -C "$repo" push -q origin HEAD:singbox
    mock_bin="$fixture_root/bin"; call_log="$fixture_root/gh.log"; mkdir -p "$mock_bin"
    cat >"$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$GH_CALL_LOG"
if [ "${1:-}" = release ] && [ "${2:-}" = view ]; then
    if [ "${GH_BEHAVIOR:-}" = resolve ]; then printf '%s\n' '{"tagName":"3.0.0","url":"https://github.com/remnawave/node/releases/tag/3.0.0","publishedAt":"2026-08-01T00:00:00Z","isDraft":false,"isPrerelease":false}'; exit 0; fi
    case "${GH_BEHAVIOR:-}" in
        existing) printf '%s\n' '{"tagName":"2.8.0","url":"https://github.com/Cd1s/remnawave-test/releases/tag/2.8.0"}' ;;
        wrong-release-tag) printf '%s\n' '{"tagName":"wrong","url":"https://github.com/Cd1s/remnawave-test/releases/tag/wrong"}' ;;
        missing) printf '%s\n' 'release not found' >&2; exit 1 ;;
        query-error) printf '%s\n' 'permission denied' >&2; exit 1 ;;
    esac; exit 0
fi
if [ "${1:-}" = release ] && [ "${2:-}" = create ]; then printf 'release create %s\n' "$*" >>"$GH_CALL_LOG"; exit 0; fi
exit 2
EOF
    chmod +x "$mock_bin/gh"
}
run_sync() { run_sync_commit "$1" "$new_sha"; }
run_sync_commit() { local behavior=$1 commit=$2; ( cd "$repo"; PATH="$mock_bin:$PATH" GH_BEHAVIOR="$behavior" GH_CALL_LOG="$call_log" FORK_REPO=Cd1s/remnawave-test FORK_COMMIT="$commit" UPSTREAM_REPO=remnawave/node UPSTREAM_RELEASE_TAG=2.8.0 UPSTREAM_RELEASE_URL=https://github.com/remnawave/node/releases/tag/2.8.0 UPSTREAM_RELEASE_VERSION=2.8.0 CI_RUN_URL=https://github.com/Cd1s/remnawave-test/actions/runs/1 bash "$SCRIPT" sync ); }
make_merge_fixture() {
    fixture_root="$(mktemp -d)"; repo="$fixture_root/repo"; report="$fixture_root/report.md"; mkdir -p "$repo"; git init -q "$repo"; git -C "$repo" config user.name test; git -C "$repo" config user.email test@example.invalid; git -C "$repo" checkout -q -b singbox
    printf '{"version":"2.8.0"}\n' >"$repo/package.json"; printf 'fork webpack config\n' >"$repo/webpack.config.js"; printf 'xray\nsingbox\n' >"$repo/dual-core.contract"; git -C "$repo" add .; git -C "$repo" commit -q -m base; base_sha="$(git -C "$repo" rev-parse HEAD)"
    printf 'fork webpack adaptation\n' >"$repo/webpack.config.js"; git -C "$repo" add webpack.config.js; git -C "$repo" commit -q -m fork-adaptation
    git -C "$repo" switch -q -c upstream-work "$base_sha"; printf '{"version":"3.0.0"}\n' >"$repo/package.json"; git -C "$repo" rm -q webpack.config.js; printf 'rspack official config\n' >"$repo/rspack.config.mjs"; git -C "$repo" add package.json rspack.config.mjs; git -C "$repo" commit -q -m official-3.0.0; git -C "$repo" branch upstream-main; git -C "$repo" switch -q singbox
}
make_up_to_date_fixture() {
    fixture_root="$(mktemp -d)"; repo="$fixture_root/repo"; output_file="$fixture_root/output"; mkdir -p "$repo"; git init -q "$repo"; git -C "$repo" config user.name test; git -C "$repo" config user.email test@example.invalid; git -C "$repo" checkout -q -b singbox
    printf '{"version":"3.0.0"}\n' >"$repo/package.json"; git -C "$repo" add package.json; git -C "$repo" commit -q -m official-3.0.0; git -C "$repo" branch upstream-release
    printf 'sing-box fork adaptation\n' >"$repo/fork-adaptation"; git -C "$repo" add fork-adaptation; git -C "$repo" commit -q -m fork-adaptation
}
test_resolve() { make_repo; output_file="$fixture_root/output"; ( cd "$repo"; : >"$output_file"; PATH="$mock_bin:$PATH" GH_BEHAVIOR=resolve GH_CALL_LOG="$call_log" GITHUB_OUTPUT="$output_file" UPSTREAM_REPO=remnawave/node bash "$SCRIPT" resolve ) >/dev/null 2>&1 || return 1; assert_file_contains "$output_file" 'tag=3.0.0' && assert_file_contains "$output_file" 'version=3.0.0'; }
test_official_release_already_contained_is_noop() {
    make_up_to_date_fixture
    before_sha="$(git -C "$repo" rev-parse HEAD)"
    result="$(cd "$repo" && : >"$output_file" && GITHUB_OUTPUT="$output_file" UPSTREAM_REF=upstream-release bash "$LIB" merge 2>&1)" || return 1
    assert_file_contains "$output_file" 'updated=false' || return 1
    assert_contains "$result" 'upstream_sync=up_to_date' || return 1
    [ "$(git -C "$repo" rev-parse HEAD)" = "$before_sha" ] || return 1
    [ -z "$(git -C "$repo" status --porcelain)" ] || return 1
    [ "$(git -C "$repo" tag --list)" = '' ] || return 1
}
test_noop_workflow_skips_package_build_push_and_release() {
    gate="if: steps.sync.outcome == 'success' && steps.sync.outputs.updated == 'true'"
    for marker in \
        'Verify package version from official release commit' \
        'npm ci --no-audit --no-fund' \
        'npm run validate:dual-core' \
        'npm run build' \
        'npm run trace' \
        'npm run typecheck' \
        'npm run check' \
        'Check dual-core files' \
        'Verify write capabilities before any image build' \
        'Resolve final fork commit and version' \
        'Push tested merge' \
        'Verify pushed final commit' \
        'docker/setup-qemu-action' \
        'docker/setup-buildx-action' \
        'docker/login-action' \
        'docker/build-push-action' \
        'Sync official fork Release'; do
        step_line="$(grep -n -m1 -F -- "$marker" "$WORKFLOW" | cut -d: -f1)" || return 1
        condition="$(sed -n "${step_line},$((step_line + 8))p" "$WORKFLOW" | grep -m1 -F -- 'if:')" || return 1
        [ "$condition" = "        $gate" ] || return 1
    done
}
test_historical_skip() { make_repo historical; historical_sha="$(git -C "$repo" rev-parse refs/tags/2.8.0)"; output="$(run_sync existing 2>&1)" || return 1; assert_contains "$output" 'release_sync=skipped' || return 1; [ "$(git -C "$repo" rev-parse refs/tags/2.8.0)" = "$historical_sha" ] || return 1; ! grep -Fq 'release create' "$call_log"; }
test_create() { make_repo; output="$(run_sync missing 2>&1)" || return 1; assert_contains "$output" 'release_sync=created' || return 1; grep -Fq "release create release create 2.8.0 --repo Cd1s/remnawave-test --target $new_sha --title 2.8.0" "$call_log"; }
test_superseded_sync_is_skipped_without_release_side_effects() { make_repo; output="$(run_sync_commit missing "$old_sha" 2>&1)" || return 1; assert_contains "$output" 'release_sync=skipped reason=superseded_by_newer_sync' || return 1; [ ! -s "$call_log" ]; }
test_diverged_branch_fails_closed() { make_repo; git -C "$repo" checkout -q -b divergent "$old_sha"; printf 'diverged\n' >>"$repo/state"; git -C "$repo" add state; git -C "$repo" commit -q -m divergent; divergent_sha="$(git -C "$repo" rev-parse HEAD)"; git -C "$repo" push -q --force origin HEAD:singbox; output="$(run_sync_commit missing "$new_sha" 2>&1)" && return 1; assert_contains "$output" "release_sync=failed reason=remote_branch_not_at_final_commit expected=${new_sha} actual=${divergent_sha}"; }
test_different_tag_fails() { make_repo historical; output="$(run_sync missing 2>&1)" && return 1; assert_contains "$output" 'tag_exists_without_release_points_to_different_commit'; }
test_missing_tag_fails() { make_repo; output="$(run_sync existing 2>&1)" && return 1; assert_contains "$output" 'release_exists_but_tag_missing'; }
test_query_fails() { make_repo; output="$(run_sync query-error 2>&1)" && return 1; assert_contains "$output" 'release_query_error'; }
test_structure_fails() { make_repo; output="$(run_sync wrong-release-tag 2>&1)" && return 1; assert_contains "$output" 'release_tag_mismatch'; }
test_version_mismatch() { fixture_root="$(mktemp -d)"; printf '{"version":"2.8.0"}\n' >"$fixture_root/package.json"; output="$(EXPECTED_VERSION=3.0.0 PACKAGE_PATH="$fixture_root/package.json" bash "$VERSION_SCRIPT" 2>&1)" && return 1; assert_contains "$output" 'package_version_mismatch expected=3.0.0 actual=2.8.0'; }
test_version_match() { fixture_root="$(mktemp -d)"; printf '{"version":"3.0.0"}\n' >"$fixture_root/package.json"; output="$(EXPECTED_VERSION=3.0.0 PACKAGE_PATH="$fixture_root/package.json" bash "$VERSION_SCRIPT" 2>&1)" || return 1; assert_contains "$output" 'package_version=3.0.0'; }
test_version_match_repo_relative() { output="$(cd "$ROOT" && EXPECTED_VERSION=3.0.0 bash "$VERSION_SCRIPT" 2>&1)" || return 1; assert_contains "$output" 'package_version=3.0.0'; }
test_conflict_report_and_safe_delete() { make_merge_fixture; output="$(cd "$repo" && UPSTREAM_REF=upstream-main UPSTREAM_SYNC_REPORT_PATH="$report" bash "$MERGE_SCRIPT" 2>&1)" && return 1; assert_contains "$output" 'upstream_sync=failed'; [ -s "$report" ] || return 1; assert_file_contains "$report" 'webpack.config.js' || return 1; assert_file_contains "$report" 'deleted by them' || return 1; [ -z "$(git -C "$repo" diff --name-only --diff-filter=U)" ] || return 1; grep -Fq 'fork webpack adaptation' "$repo/webpack.config.js"; }
test_dual_core_contract() { assert_file_contains "$ROOT/Dockerfile" 'FROM golang:' || return 1; assert_file_contains "$ROOT/Dockerfile" 'AS singbox' || return 1; assert_file_contains "$ROOT/Dockerfile" 'AS xray' || return 1; assert_file_contains "$ROOT/Dockerfile" 'SINGBOX_CORE_VERSION' || return 1; assert_file_contains "$ROOT/rootfs/etc/s6-overlay/s6-rc.d/sing-box/run" 'sing-box run' || return 1; assert_file_contains "$ROOT/src/modules/core/singbox.service.ts" 'writeAndValidateConfig' || return 1; assert_file_contains "$ROOT/src/modules/xray-core/xray.service.ts" 'startXray' || return 1; }
test_workflow_contract() {
    assert_file_contains "$WORKFLOW" 'schedule:' || return 1; assert_file_contains "$WORKFLOW" '*/5 * * * *' || return 1; assert_file_contains "$WORKFLOW" 'workflow_dispatch:' || return 1; assert_file_contains "$WORKFLOW" 'UPSTREAM_SYNC_REPORT_PATH' || return 1; assert_file_contains "$WORKFLOW" 'actions/upload-artifact@v4' || return 1; assert_file_contains "$WORKFLOW" 'if: ${{ failure() }}' || return 1; assert_file_contains "$WORKFLOW" 'git push origin HEAD:singbox' || return 1; assert_file_contains "$WORKFLOW" 'Verify pushed final commit' || return 1; assert_file_contains "$WORKFLOW" 'Sync official fork Release' || return 1; assert_file_contains "$WORKFLOW" 'if: steps.sync.outcome == '\''success'\''' || return 1; assert_file_contains "$WORKFLOW" 'upstream-sync-lib.sh package' || return 1; assert_file_contains "$WORKFLOW" 'upstream-sync-lib.sh preflight' || return 1; assert_file_contains "$WORKFLOW" 'npm run typecheck' || return 1; assert_file_contains "$WORKFLOW" 'npm run validate:dual-core' || return 1; if grep -Eq '(__RW_METADATA_VERSION|RWNODE_VERSION)=[0-9]' "$WORKFLOW"; then return 1; fi
    local build_line merge_line push_line verify_line release_line; build_line="$(grep -n -m1 'docker/build-push-action' "$WORKFLOW" | cut -d: -f1)"; merge_line="$(grep -n -m1 'name: Detect and merge upstream' "$WORKFLOW" | cut -d: -f1)"; push_line="$(grep -n -m1 'git push origin HEAD:singbox' "$WORKFLOW" | cut -d: -f1)"; verify_line="$(grep -n -m1 'name: Verify pushed final commit' "$WORKFLOW" | cut -d: -f1)"; release_line="$(grep -n -m1 'name: Sync official fork Release' "$WORKFLOW" | cut -d: -f1)"; [ -n "$build_line" ] && [ -n "$merge_line" ] && [ "$merge_line" -lt "$push_line" ] && [ "$push_line" -lt "$verify_line" ] && [ "$verify_line" -lt "$build_line" ] && [ "$build_line" -lt "$release_line" ]
}
test_preflight_contract() { assert_file_contains "$WORKFLOW" 'GH_TOKEN: ${{ github.token }}' && assert_file_contains "$WORKFLOW" 'GH_TOKEN: ${{ secrets.WORKFLOW_TOKEN }}' && assert_file_contains "$WORKFLOW" 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}' && assert_file_contains "$WORKFLOW" 'WORKFLOW_TOKEN: ${{ secrets.WORKFLOW_TOKEN }}' && assert_file_contains "$WORKFLOW" 'WORKFLOW_CHANGED: ${{ steps.sync.outputs.workflow_changed }}' && assert_file_contains "$WORKFLOW" 'push_token="$GITHUB_TOKEN"' && assert_file_contains "$WORKFLOW" 'push_token="$WORKFLOW_TOKEN"' && ! grep -Fq -- 'PACKAGE_TOKEN' "$WORKFLOW" && ! grep -Fq -- 'permissions.push' "$WORKFLOW" && ! grep -Fq -- 'actions/workflows' "$ROOT/.github/scripts/upstream-sync-lib.sh" && ! grep -Fq -- 'SKIP_GIT_DRY_RUN' "$ROOT/.github/scripts/upstream-sync-lib.sh"; }
run_case() { if "$1"; then pass "$1"; else fail "$1"; fi; }
run_case test_resolve; run_case test_official_release_already_contained_is_noop; run_case test_noop_workflow_skips_package_build_push_and_release; run_case test_historical_skip; run_case test_create; run_case test_superseded_sync_is_skipped_without_release_side_effects; run_case test_diverged_branch_fails_closed; run_case test_different_tag_fails; run_case test_missing_tag_fails; run_case test_query_fails; run_case test_structure_fails; run_case test_version_mismatch; run_case test_version_match; run_case test_version_match_repo_relative; run_case test_conflict_report_and_safe_delete; run_case test_dual_core_contract; run_case test_workflow_contract; run_case test_preflight_contract
[ "$failures" -eq 0 ] || exit 1
printf 'all sync contract tests passed\n'
