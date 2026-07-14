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
# Дефолты (dev/unknown) НЕ ломают локальную сборку без --build-arg — так что
# `docker build .` без флагов CI по-прежнему работает (self-host сценарий).
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
# K8s (deploy/manifests/deployment.yaml) проверяет /healthz снаружи через
# httpGet — kubelet ничего не исполняет ВНУТРИ контейнера, поэтому там shell
# не нужен. Docker Compose так не умеет: его HEALTHCHECK — это exec ВНУТРИ
# контейнера, а distroless/cc намеренно без shell/curl/wget. Чтобы self-host
# `docker compose` показывал healthy/unhealthy и авто-перезапускал зависший
# (не упавший) процесс, впаян ровно один статический busybox (musl, ~1 МБ, без
# зависимостей от glibc distroless-образа) — только ради wget/sh для healthcheck.
# Больше он ничего не меняет; сам сервер по-прежнему единственный ENTRYPOINT.
COPY --from=busybox:musl /bin/busybox /bin/busybox
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD ["/bin/busybox", "sh", "-c", "/bin/busybox wget -q -O /dev/null http://127.0.0.1:${PORT:-8080}/healthz || exit 1"]
ENTRYPOINT ["/usr/local/bin/screenshare"]
