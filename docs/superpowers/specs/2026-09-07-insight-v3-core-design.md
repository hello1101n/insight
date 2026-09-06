# Insight v3 Core Design

## Goal

Introduce `insight-v3-core` as an empty but runnable Rust microservice that follows the same gears-rust host pattern as the analytics service.

## Architecture

`insight-v3-core` is a member of the existing backend Cargo workspace. Its binary loads the standard gears configuration and starts `toolkit::bootstrap::run_server`. An `InsightV3CoreGear` registers the service with the toolkit and initially contributes no business routes or state.

The host links the same API gateway and authentication pipeline gears as analytics. This preserves the expected service shape for later authenticated APIs without inventing a second runtime pattern.

## Runtime contract

The API gateway host listens on port `8086` and owns the public `/health` and `/healthz` endpoints. Both endpoints must return HTTP `200` when the process is ready. There are no databases, queues, external services, migrations, or background tasks in this initial version.

Configuration lives in `services/insight-v3-core/config/insight.yaml`. Invalid host or toolkit configuration prevents startup and returns a non-zero process exit. Logging and graceful shutdown are provided by the toolkit bootstrap.

## Container

The service ships as a multi-stage Debian-based image built from the backend workspace context. The runtime contains only the compiled binary, service configuration, shared entrypoint, and required certificates. It runs as the existing non-root `appuser` convention and exposes port `8086`.

Adding the workspace member requires the dependency-cache stages of sibling Rust-service Dockerfiles to copy and stub the new manifest, keeping their existing image builds valid.

## Verification

A process-level smoke test starts the real binary with a test-only port override and checks `/health` and `/healthz`. Verification also runs the service package tests, Clippy with warnings denied, a Docker build, and health requests against the running container.

## Out of scope

Docker Compose, Helm, platform-gateway routing, CI image publication, OpenAPI business paths, persistence, and domain behavior are deferred until the service has its first responsibility.
