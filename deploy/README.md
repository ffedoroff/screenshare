# Деплой в KubeSolo

IaC этого проекта. Применяется **админом** (не CI) — деплой-пользователь
из CI умеет только менять тег образа в уже созданном Deployment. Подход и
конвенции — плейбук `simple-deploy` (`kube/backend-deploy.md`).

## Порядок применения (один раз, админским kubeconfig)

```bash
kubectl apply -f deploy/manifests/namespace.yaml
kubectl apply -f deploy/manifests/rbac.yaml
kubectl apply -f deploy/manifests/deployment.yaml   # image: chat:PLACEHOLDER — под не поднимется,
                                                     # пока CI не задеплоит первый реальный тег
kubectl apply -f deploy/manifests/service.yaml
kubectl apply -f deploy/manifests/ingress.yaml
```

`rbac.yaml` заводит Role+RoleBinding в неймспейсе `chat-prod` для уже
существующего `ServiceAccount deployer` (ns `deploy`, общий на все проекты
сервера — см. `simple-deploy/artifacts/server/rbac.yaml`).

`ingress.yaml` рассчитан на уже развёрнутый на кластере
`cloudflare-tunnel-ingress-controller` (см. `simple-deploy/cloudflare/tunnel.md`,
«Вариант 2») — отдельно ничего в дашборде Cloudflare заводить не нужно, DNS и
туннель контроллер создаёт по самому `Ingress`.

## Метрики (Prometheus + Grafana)

`deployment.yaml` (применённый по шагам выше) уже несёт всё нужное для
скрейпа — второй порт `mgmt` (8081, `/metrics`) и аннотации
`prometheus.io/scrape|port|path` на поде (тот же паттерн, что у
`code-ranker-backend`, см. `src/main.rs::spawn_metrics_server`,
`simple-deploy/standards/observability/metrics.md`). Отдельно применять
для этого ничего не нужно — Prometheus (`kubernetes_sd_config`, роль `pod`)
подхватывает новый под сам, без правки своего конфига.

Grafana-дашборд — отдельный ConfigMap, НЕ входит в список выше и применяется
так же вручную, админом:

```bash
kubectl apply -f deploy/monitoring/grafana-dashboard-chat.yaml
```

Этого одного `apply` НЕДОСТАТОЧНО, чтобы дашборд появился в Grafana: сам под
`grafana` (ns `monitoring`) монтирует дашборды через `projected volume`
(`ConfigMap` на каждый дашборд — см. `grafana-dashboard-code-ranker`,
`grafana-dashboard-store`), список источников которого сегодня прописан ТОЛЬКО
в самом Deployment `grafana`, не в манифесте этого репозитория (монитор в
принципе не входит в состав `chat` — общий для всего кластера). Значит, после
`apply` выше нужно ЕЩЁ РАЗ, руками, добавить
`configMap.name: grafana-dashboard-chat` в
`spec.template.spec.volumes[].projected.sources` Deployment'а `grafana` (ns
`monitoring`), например:

```bash
kubectl -n monitoring edit deployment grafana
# в volumes: - name: dashboards -> projected.sources: добавить
#   - configMap: { name: grafana-dashboard-chat }
kubectl -n monitoring rollout restart deployment grafana
```

Провижининг-сайдкар (`grafana-dashboards-provider`, `updateIntervalSeconds:
30`) сам подхватывает файл после этого — пересоздавать под ещё раз для
каждого будущего обновления самого JSON внутри `grafana-dashboard-chat`
(в отличие от первого добавления источника) уже не требуется.

## Как устроен CI-деплой

Push в `main` → `.github/workflows/deploy-prod.yml`:

1. Job `test`: прогоняет тесты протокола сигналинга (65 проверок; сам собирает
   `cargo build`). Красные тесты не пускают деплой.
2. Job `deploy` (`needs: test`): собирает образ (`docker buildx build
   --provenance=false --sbom=false --platform linux/amd64`, кэш GHA),
   иммутабельный тег **`prod-<short-sha>`** ровно того коммита, что запушен;
   в образ впекаются `APP_VERSION`/`GIT_COMMIT`/`BUILD_DATE` (см. `/version.json`).
3. Доставляет его на сервер напрямую по SSH (без реестра):
   `docker save | gzip | ssh … "prod <tag>"`.
4. Серверный скрипт (`deployer`, forced command) импортирует образ в
   containerd, выполняет `kubectl set image deployment/chat '*=chat:<tag>'` и
   ждёт `rollout status`.

CI ничего не знает про манифесты выше — они не пересоздаются при каждом
деплое, меняется только тег образа в уже существующем Deployment.

## Особенности этого Deployment (важно)

- **`replicas: 1` + `strategy.type: Recreate`**, не обычный
  zero-downtime-шаблон (`replicas: 2` + `RollingUpdate`). Причина — комнаты
  живут в памяти одного процесса (`src/state.rs`); см. комментарий в
  `deploy/manifests/deployment.yaml`. Практическое следствие: каждый деплой
  на несколько секунд обрывает активные трансляции.
- **Никакого хранилища на диске.** Приложение полностью эфемерно: история
  чата и состояние комнат живут только в памяти процесса и умирают вместе с
  комнатой (реапер TTL) или с рестартом пода. Поэтому в манифестах
  сознательно нет PVC/volume — их удалили вместе с уходом SQLite из
  приложения, писать на диск больше нечего.
- Секретов приложению не нужно (TURN, если понадобится, — через `Secret` +
  `envFrom`, аналогично другим проектам сервера).

## Откат

Основной путь (как в остальных проектах сервера) — перезапустить run
предыдущего коммита: `gh run rerun <id>` (пересоберёт и переимпортирует тот же
`prod-<sha>`; это же спасает после рестарта kubesolo, когда локальные образы
пропали). Быстрый локальный откат, пока старый образ ещё в containerd:

```bash
kubectl -n chat-prod rollout undo deployment/chat
# или к конкретному тегу:
kubectl -n chat-prod set image deployment/chat '*=chat:prod-<старый_sha>'
```
