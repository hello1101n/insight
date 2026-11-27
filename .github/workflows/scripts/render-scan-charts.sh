#!/usr/bin/env bash
set -uo pipefail

out="${1:?usage: render-scan-charts.sh <output-dir>}"
mkdir -p "$out"
failed=()
for chart in src/backend/services/*/helm src/frontend/helm; do
  [ -f "$chart/Chart.yaml" ] || continue
  name="${chart%/helm}"
  name="${name##*/}"
  args=(
    --set existingSecret=dummy
    --set signingKeysSecret=dummy
    --set tlsDiscovery.issuerRef.name=dummy
    --set issuer=http://idp.invalid
    --set hostname=http://kc.invalid
    --set image.repository=ghcr.io/example/image
    --set image.tag=scan
    --set oidc.scopes=openid
  )
  if [ "$name" = keycloak ]; then
    args+=(
      --set admin.existingSecret=dummy
      --set database.host=db.example.com
      --set database.username=example
      --set database.passwordSecret.name=dummy
      --set database.passwordSecret.key=password
    )
  fi
  if ! helm template scan "$chart" "${args[@]}" > "$out/${name}.yaml"; then
    echo "::error::${chart} did not render, so the scan cannot cover it"
    rm -f "$out/${name}.yaml"
    failed+=("$chart")
  fi
done
echo "Rendered:"
find "$out" -name '*.yaml' -exec basename {} ';' | sed 's/^/  /'
[ "${#failed[@]}" -eq 0 ]
