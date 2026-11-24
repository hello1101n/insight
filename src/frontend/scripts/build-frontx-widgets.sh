#!/bin/sh
# Build the FrontX widget bundles with the template's own harness.
# Usage: scripts/build-frontx-widgets.sh <out-dir>
set -eu

mkdir -p "$1"
out=$(cd "$1" && pwd)

cd "$(dirname "$0")/../vendor/gears-frontx-templates/template-dashboard"
npm ci --no-audit --no-fund
WIDGET_BUNDLES_OUT="$out" npm run build:widgets
