# Image for deploying to KubeSolo (see deploy/README.md and simple-deploy/kube/backend-deploy.md).
# distroless/cc (not Alpine/musl): minimal glibc + libstdc++ + CA certificates,
# no shell/package manager — that's enough for a plain Rust/axum binary.
# Build with --provenance=false --sbom=false --platform linux/amd64, otherwise
# docker save produces a manifest list with attestations and the import into containerd will be incomplete.

# syntax=docker/dockerfile:1
FROM rust:slim-bookworm AS builder
WORKDIR /src
COPY . .
# Embedded TURN (optional, see Cargo.toml `embedded-turn` feature and
# docs/self-hosting.md, "TURN (Optional)"): empty by default, so a plain
# `docker build .` (the default, split-production image) never pulls in
# `turn-server`/`aws-lc-rs` and friends. Self-host operators who want a
# single embedded-TURN image pass `--build-arg CARGO_FEATURES=embedded-turn`.
ARG CARGO_FEATURES=""
RUN cargo build --release ${CARGO_FEATURES:+--features $CARGO_FEATURES} && cp target/release/screenshare /screenshare

FROM gcr.io/distroless/cc-debian12:nonroot
# Artifact version (standard from versioning-release.md): baked in by CI at build time,
# the app exposes it via GET /version.json (used to detect version skew in clients).
# The defaults (dev/unknown) do NOT break a local build without --build-arg — so
# `docker build .` still works without CI flags (the self-host scenario).
ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV APP_VERSION=$APP_VERSION GIT_COMMIT=$GIT_COMMIT BUILD_DATE=$BUILD_DATE
# Frontend static assets: served by the app from STATIC_DIR (see src/main.rs).
COPY --from=builder /screenshare /usr/local/bin/screenshare
COPY static/ /app/static/
ENV STATIC_DIR=/app/static
ENV PORT=8080
EXPOSE 8080
USER nonroot
# K8s (deploy/manifests/deployment.yaml) checks /healthz from the outside via
# httpGet — kubelet doesn't execute anything INSIDE the container, so no shell
# is needed there. Docker Compose can't do that: its HEALTHCHECK is an exec INSIDE
# the container, and distroless/cc is intentionally shell/curl/wget-free. So that self-hosted
# `docker compose` can show healthy/unhealthy and auto-restart a hung
# (not crashed) process, exactly one static busybox is baked in (musl, ~1 MB, no
# dependencies on the glibc distroless image) — solely for wget/sh for the healthcheck.
# It doesn't change anything else; the server itself remains the sole ENTRYPOINT.
COPY --from=busybox:musl /bin/busybox /bin/busybox
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD ["/bin/busybox", "sh", "-c", "/bin/busybox wget -q -O /dev/null http://127.0.0.1:${PORT:-8080}/healthz || exit 1"]
ENTRYPOINT ["/usr/local/bin/screenshare"]
