#!/bin/sh
# Build the FrontX widget bundles with the template's own harness.
# Usage: scripts/build-frontx-widgets.sh <out-dir>
set -eu

mkdir -p "$1"
out=$(cd "$1" && pwd)
copy="$(cd "$(dirname "$0")/.." && pwd)/vendor/gears-frontx-templates"

# INVARIANT: Do not run npm in the copy. npm ci there removes the pnpm links of the dashboard package.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -C "$copy" --exclude=node_modules -cf - . | tar -C "$stage" -xf -

cd "$stage/template-dashboard"
npm ci --ignore-scripts --no-audit --no-fund
WIDGET_BUNDLES_OUT="$out" npm run build:widgets
