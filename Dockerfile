# Образ для деплоя в KubeSolo (см. deploy/README.md и simple-deploy/kube/backend-deploy.md).
# distroless/cc (не Alpine/musl): минимальный glibc + libstdc++ + CA-сертификаты,
# без shell/пакетного менеджера — этого достаточно для чистого Rust/axum-бинаря.
# Собирать с --provenance=false --sbom=false --platform linux/amd64, иначе
# docker save даёт manifest-list с attestation и импорт в containerd будет неполным.

# syntax=docker/dockerfile:1
FROM rust:slim-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release && cp target/release/screenshare /screenshare

FROM gcr.io/distroless/cc-debian12:nonroot
# Версия артефакта (стандарт versioning-release.md): впекается CI при сборке,
# приложение отдаёт её в GET /version.json (детект version-skew у клиентов).
ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV APP_VERSION=$APP_VERSION GIT_COMMIT=$GIT_COMMIT BUILD_DATE=$BUILD_DATE
# Статика фронтенда: раздаётся приложением из STATIC_DIR (см. src/main.rs).
COPY --from=builder /screenshare /usr/local/bin/screenshare
COPY static/ /app/static/
ENV STATIC_DIR=/app/static
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/screenshare"]
