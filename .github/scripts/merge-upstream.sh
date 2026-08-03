#!/usr/bin/env bash
set -euo pipefail

: "${UPSTREAM_REF:?UPSTREAM_REF is required}"
: "${UPSTREAM_SYNC_REPORT_PATH:?UPSTREAM_SYNC_REPORT_PATH is required}"

write_output() {
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
        printf '%s\n' "$1" >>"$GITHUB_OUTPUT"
    fi
}

if git merge-base --is-ancestor "$UPSTREAM_REF" HEAD; then
    write_output 'updated=false'
    echo "upstream_sync=up_to_date current=$(git rev-parse HEAD) upstream=$(git rev-parse "$UPSTREAM_REF")"
    exit 0
fi

merge_log="${RUNNER_TEMP:-$(dirname "$UPSTREAM_SYNC_REPORT_PATH")}/node-upstream-merge.log"
if git merge --no-edit "$UPSTREAM_REF" >"$merge_log" 2>&1; then
    write_output 'updated=true'
    echo "upstream_sync=merged commit=$(git rev-parse HEAD) upstream=$(git rev-parse "$UPSTREAM_REF")"
    exit 0
else
    merge_rc=$?
fi

conflict_files="$(git diff --name-only --diff-filter=U || true)"
status_lines="$(git status --short || true)"
mkdir -p "$(dirname "$UPSTREAM_SYNC_REPORT_PATH")"
{
    echo '# Node upstream synchronization failed'
    echo
    echo 'The maintained branch was not pushed because the upstream merge failed.'
    echo
    echo "- maintained commit: \`$(git rev-parse HEAD)\`"
    echo "- upstream commit: \`$(git rev-parse "$UPSTREAM_REF")\`"
    echo
    echo '## Conflicting files'
    if [ -n "$conflict_files" ]; then
        while IFS= read -r file; do
            status_line="$(grep -F " $file" <<<"$status_lines" | head -n1 || true)"
            case "$status_line" in
                UD*) printf '%s\n' "- \`$file\` (deleted by them; modified by fork)" ;;
                DU*) printf '%s\n' "- \`$file\` (deleted by fork; modified by upstream)" ;;
                *) printf '%s\n' "- \`$file\`" ;;
            esac
        done <<<"$conflict_files"
    else
        echo '- none (see merge output below)'
    fi
    echo
    echo '## Git status'
    echo '```text'
    printf '%s\n' "$status_lines"
    echo '```'
    echo
    echo '## Git merge output'
    echo '```text'
    cat "$merge_log"
    echo '```'
} >"$UPSTREAM_SYNC_REPORT_PATH"

if ! git merge --abort; then
    echo 'upstream_sync=error merge_abort_failed' >&2
fi
cat "$UPSTREAM_SYNC_REPORT_PATH" >&2
echo "upstream_sync=failed report=$UPSTREAM_SYNC_REPORT_PATH" >&2
exit "$merge_rc"
