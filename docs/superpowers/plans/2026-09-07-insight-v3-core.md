# Insight v3 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an empty, runnable `insight-v3-core` Rust microservice with a Docker image and working health endpoints.

**Architecture:** Add a gears-rust host modeled on `services/analytics`, with an empty REST-capable gear and the standard authenticated system-gear pipeline. The API gateway host owns `/health` and `/healthz`; the service adds no business routes or external dependencies.

**Tech Stack:** Rust 1.95, Tokio, gears-rust toolkit, Axum, Clap, Docker

**Spec:** `docs/superpowers/specs/2026-09-07-insight-v3-core-design.md`

## Global Constraints

- Use Rust edition 2024 and the backend workspace dependency versions.
- Use the service name `insight-v3-core`, gear name `insight-v3-core`, and HTTP port `8086`.
- Follow the analytics service's bootstrap, configuration, authentication, and Docker conventions.
- Add no business APIs, persistence, orchestration, Helm, Compose, gateway routing, or CI publication.
- Run the image as a non-root user.

---

### Task 1: Runnable gears service

**Files:**

- Create: `src/backend/services/insight-v3-core/Cargo.toml`
- Create: `src/backend/services/insight-v3-core/src/main.rs`
- Create: `src/backend/services/insight-v3-core/src/gear.rs`
- Create: `src/backend/services/insight-v3-core/config/insight.yaml`
- Create: `src/backend/services/insight-v3-core/Dockerfile`
- Create: `src/backend/services/insight-v3-core/tests/health.sh`
- Modify: `src/backend/Cargo.toml`
- Modify: `src/backend/Cargo.lock`
- Modify: sibling Rust-service Dockerfiles under `src/backend/services/`

**Interfaces:**

- Consumes: `toolkit::bootstrap::{AppConfig, run_server}`, `toolkit::{Gear, GearCtx, RestApiCapability}`, and the inventory-linked system gears used by analytics.
- Produces: the `insight-v3-core` binary, the `InsightV3CoreGear` registration, and HTTP `200` responses at `/health` and `/healthz` on port `8086`.

- [ ] **Step 1: Add the failing process smoke test**

```bash
#!/usr/bin/env bash
set -euo pipefail

service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="$(cd "$service_dir/../.." && pwd)"
port="${INSIGHT_V3_CORE_TEST_PORT:-18086}"
log_file="$(mktemp)"
pid=""

cleanup() {
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$log_file"
}
trap cleanup EXIT

APP__gears__api_gateway__config__bind_addr="127.0.0.1:$port" \
  cargo run --quiet --manifest-path "$backend_dir/Cargo.toml" \
  --package insight-v3-core -- \
  --config "$service_dir/config/insight.yaml" run >"$log_file" 2>&1 &
pid=$!

for _ in {1..120}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$log_file"
    exit 1
  fi

  if curl --fail --silent "http://127.0.0.1:$port/health" >/dev/null && \
     curl --fail --silent "http://127.0.0.1:$port/healthz" >/dev/null; then
    exit 0
  fi

  sleep 0.25
done

cat "$log_file"
exit 1
```

- [ ] **Step 2: Run the smoke test and verify it fails because the service package does not exist**

Run: `PATH="$HOME/.cargo/bin:$PATH" bash src/backend/services/insight-v3-core/tests/health.sh`

Expected: non-zero exit with Cargo reporting that package `insight-v3-core` does not exist.

- [ ] **Step 3: Implement the minimal analytics-style gears host and Docker image**

Register `services/insight-v3-core` in the workspace; add `main.rs`, an empty REST-capable `InsightV3CoreGear`, the analytics-shaped authenticated config on port `8086`, and the multi-stage Dockerfile. Update each sibling Rust-service Docker dependency-cache stage so the expanded workspace still resolves.

- [ ] **Step 4: Run the process smoke test and verify both health endpoints pass**

Run: `PATH="$HOME/.cargo/bin:$PATH" bash src/backend/services/insight-v3-core/tests/health.sh`

Expected: exit `0` after both `/health` and `/healthz` return HTTP `200`.

- [ ] **Step 5: Run package verification**

Run: `cargo fmt --all --check`

Run: `cargo test --package insight-v3-core`

Run: `cargo clippy --package insight-v3-core --all-targets -- -D warnings`

Expected: every command exits `0`.

- [ ] **Step 6: Build and smoke-test the container**

Run: `docker build -f services/insight-v3-core/Dockerfile -t insight-v3-core:dev .`

Run the image with `-p 18086:8086`, then request `/health` and `/healthz` and remove the container.

Expected: the image builds, the container stays running, and both endpoints return HTTP `200`.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/backend docs/superpowers
git commit -m "AP-0: scaffold insight v3 core service"
```
