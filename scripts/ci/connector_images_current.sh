#!/usr/bin/env bash
# Fails when a connector descriptor pins an image built from a commit older than
# the connector's own sources. Reconcile compares only the image tag, so such a
# descriptor ships the old extraction however its `version:` reads.
#
# A build tag is `YYYY.MM.DD.HH.MM-<sha7>[.<branch>]` (build-images.yml), built
# from the connector directory at <sha7>; any later change there but the
# descriptor makes build-images rebuild it (discover-image-matrix.py). Run from
# the repository root with full history. Not for pull requests: there the image
# cannot exist yet.
set -euo pipefail

status=0
while IFS= read -r descriptor; do
  dir="$(dirname "$descriptor")"
  while IFS= read -r sha; do
    if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
      echo "::error file=${descriptor}::image built from ${sha}, which is not in this history"
      status=1
    elif changed="$(git log --format='%h %s' "${sha}..HEAD" -- "$dir" ":(exclude)${descriptor}")" && [[ -n "$changed" ]]; then
      echo "::error file=${descriptor}::image built from ${sha}, but ${dir} changed since:"
      sed 's/^/  /' <<<"$changed"
      status=1
    fi
  done < <(sed -nE 's/^ +image: *"?[^"[:space:]]+:[0-9]{4}(\.[0-9]{2}){4}-([0-9a-f]{7,40}).*/\2/p' "$descriptor")
done < <(git ls-files 'src/ingestion/connectors/*/descriptor.yaml')
exit "$status"
