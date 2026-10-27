#!/usr/bin/env bash
#
# Re-apply the Google Android AAS patch to an opencode checkout.
#
# Designed to survive pulling upstream sst/opencode:
#   * idempotent - a second run is a no-op
#   * all-or-nothing - `git apply --3way` is not atomic, so the three-way path
#     runs in a throwaway git worktree and only reaches your tree once every
#     file has merged
#   * refuses to run on a tree that already has unrelated edits to the files
#     the patch owns
#
#   ./apply.sh            apply the patch (no-op if already applied)
#   ./apply.sh --check    only report whether it would apply
#   ./apply.sh --verify   apply, then run the patch's tests
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/google-aas.patch"

# Default to the checkout that holds this script, so the dir works wherever it
# lives. OC_REPO overrides, which is what CI and a detached patch dir need.
REPO="${OC_REPO:-$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)}"

MODE="apply"
case "${1:-}" in
	--verify) MODE="verify" ;;
	--check) MODE="check" ;;
	"") ;;
	*) echo "usage: $(basename "$0") [--check|--verify]" >&2; exit 2 ;;
esac

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

run_tests() {
	echo
	echo "running patch tests..."
	cd "$REPO/packages/core"
	bun test test/plugin/provider-google-aas.test.ts
}

report_and_finish() {
	note ""
	note "next:"
	note "  cd $REPO"
	note "  bun install --ignore-scripts    # only if node_modules is stale"
	note "  bun run check"
	note ""
	note "then sign in with:  opencode auth login (or /models auth) for google, choose the Android AAS method, paste the master token"
	if [ "$MODE" = "verify" ]; then run_tests; fi
}

[ -f "$PATCH_FILE" ] || die "patch not found: $PATCH_FILE"
if [ -z "$REPO" ]; then
	die "no git checkout next to this script; set OC_REPO=/path/to/opencode"
fi
git -C "$REPO" rev-parse --show-toplevel >/dev/null 2>&1 || die "not a git repository: $REPO (override with OC_REPO=/path/to/opencode)"

cd "$REPO"

# Split the patch's file list into paths it modifies and paths it creates.
# Classification is by presence in HEAD, not by numstat: a pure-addition hunk to
# an existing file also reports zero removals.
MODIFIED=()
CREATED=()
while IFS=$(printf '\t') read -r _added _removed path; do
	if git cat-file -e "HEAD:$path" 2>/dev/null; then
		MODIFIED+=("$path")
	else
		CREATED+=("$path")
	fi
done < <(git apply --numstat "$PATCH_FILE" 2>/dev/null || true)
[ "${#MODIFIED[@]}" -gt 0 ] || die "cannot read $PATCH_FILE; is it a valid git patch?"

# guard: bash 3.2 treats an empty array as unset under `set -u`.
PATCH_FILES=("${MODIFIED[@]}" "${CREATED[@]+"${CREATED[@]}"}")

note "repo    : $REPO"
note "patch   : $PATCH_FILE"
note "touches : ${#PATCH_FILES[@]} files (${#MODIFIED[@]} modified, ${#CREATED[@]} new)"

# Already-applied is checked first: an applied patch *is* a dirty tree, so the
# clobber guard below would otherwise reject every repeat run.
if git apply --reverse --check "$PATCH_FILE" 2>/dev/null; then
	note "state   : already applied, nothing to do"
	[ "$MODE" = "verify" ] && run_tests
	exit 0
fi

DIRTY="$(git status --porcelain -- "${PATCH_FILES[@]}")"
if [ -n "$DIRTY" ]; then
	printf 'error: these files already have uncommitted changes:\n%s\n' "$DIRTY" >&2
	die "commit or stash them first so the patch cannot clobber your work"
fi

# ---------------------------------------------------------------- fast path --
# A plain context apply is non-destructive: it either fully succeeds or does
# nothing. Try it first so the common case never needs a worktree.
if git apply --check "$PATCH_FILE" 2>/dev/null; then
	if [ "$MODE" = "check" ]; then
		note "state   : will apply cleanly"
		exit 0
	fi
	note "state   : not applied, applying (direct)"
	git apply "$PATCH_FILE"
	note "applied : clean (direct)"
	report_and_finish
	exit 0
fi

if [ "$MODE" = "check" ]; then
	note "state   : context moved upstream, needs a three-way merge"
	note "          run without --check to attempt it"
	exit 0
fi

# -------------------------------------------------------------- three-way ----
note "state   : context moved upstream, merging three-way in a scratch worktree"

SCRATCH="${TMPDIR:-/tmp}/opencode-google-aas-apply.$$"
cleanup() {
	cd "$REPO" 2>/dev/null || true
	git worktree remove --force "$SCRATCH" >/dev/null 2>&1 || true
	rm -rf "$SCRATCH"
}
trap cleanup EXIT

git worktree add --detach --quiet "$SCRATCH" HEAD

if ! (cd "$SCRATCH" && git apply --3way "$PATCH_FILE" >/dev/null 2>&1); then
	note ""
	note "state   : CONFLICT"
	git worktree remove --force "$SCRATCH" >/dev/null 2>&1 || true
	trap - EXIT
	cat >&2 <<EOF

Your working tree is untouched. Upstream rewrote code the patch depends on, so
it cannot be merged automatically. Check upstream for these pieces first:

  1. packages/core/src/plugin/provider.ts
     the ProviderPlugins registry still lacks the GooglePlugin entry the patch adds.

  2. packages/core/src/model-resolver.ts
     nativeCredentialSettings() still has no 'aas:true' metadata branch handing
     the credential to the google packages as Auth.bearer.

  3. packages/ai/src/providers/google.ts
     the settings no longer thread an explicit auth definition, or the
     Authorization-header bearer path was removed.

The files this patch adds are also on disk, ready to copy:
  $SCRIPT_DIR/files/

EOF
	exit 1
fi

# Every file merged in the scratch worktree; now it is safe to touch the real one.
for path in "${MODIFIED[@]}"; do
	cp "$SCRATCH/$path" "$REPO/$path"
done
for path in "${CREATED[@]}"; do
	cp "$SCRATCH/$path" "$REPO/$path"
done
note "applied : clean (three-way)"

report_and_finish
