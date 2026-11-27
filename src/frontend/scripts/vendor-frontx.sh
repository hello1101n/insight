#!/usr/bin/env bash
# Copy the FrontX dashboard template into vendor/gears-frontx-templates/.
# Usage: scripts/vendor-frontx.sh <repo-url> <ref>
# Do not edit the copy. Commit a change to the fork branch, then run this script again.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <repo-url> <ref>" >&2
  exit 2
fi
repo=$1
ref=$2

frontend=$(cd "$(dirname "$0")/.." && pwd)
dest="$frontend/vendor/gears-frontx-templates"
# The widget bundle build imports template-shell/src/build/mf-gts.ts by a relative path.
paths=(
  LICENSE
  NOTICE
  template-dashboard/package.json
  template-dashboard/package-lock.json
  template-dashboard/src-app/mfe_packages/dashboard
  template-dashboard/src-app/mfe_packages/widgets
  template-shell/src/build/mf-gts.ts
)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init --quiet
git -C "$work" fetch --quiet --depth 1 "$repo" "$ref"
commit=$(git -C "$work" rev-parse FETCH_HEAD)

rm -rf "$dest"
mkdir -p "$dest"
git -C "$work" archive "$commit" -- "${paths[@]}" |
  tar -x -C "$dest" --exclude='*.test.*'

printf 'repo: %s\nref: %s\ncommit: %s\n' "$repo" "$ref" "$commit" >"$dest/SOURCE"
echo "Copied $repo $ref ($commit) to $dest. Run pnpm install to link the copy again."
