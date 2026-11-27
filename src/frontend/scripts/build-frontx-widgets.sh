#!/bin/sh
# Build the FrontX widget bundles with the template's own harness.
# Usage: scripts/build-frontx-widgets.sh <out-dir>
set -eu

frontend=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
# SAFETY: The script removes the out dir. Accept only a folder in dist/ or node_modules/.
case $out in
  "$frontend"/dist/?* | "$frontend"/node_modules/?*) ;;
  *)
    echo "The out dir must be in dist/ or node_modules/: $1" >&2
    exit 2
    ;;
esac
rm -rf "$out"

# INVARIANT: Do not run npm in the copy. npm ci there removes the pnpm links of the dashboard package.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -C "$frontend/vendor/gears-frontx-templates" --exclude=node_modules -cf - . | tar -C "$stage" -xf -

cd "$stage/template-dashboard"
npm ci --ignore-scripts --no-audit --no-fund
# INVARIANT: The list names each widget type that src/lib/custom/frontx-board.ts writes.
WIDGET_BUNDLES_OUT="$out" npm run build:widgets -- grid cartesian_chart metric_card pie_chart markdown_card heatmap funnel_chart treemap_chart
