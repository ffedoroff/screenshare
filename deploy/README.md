# Деплой в KubeSolo

IaC этого проекта. Применяется **админом** (не CI) — деплой-пользователь
из CI умеет только менять тег образа в уже созданном Deployment. Подход и
конвенции — плейбук `simple-deploy` (`kube/backend-deploy.md`).

## Порядок применения (один раз, админским kubeconfig)

```bash
kubectl apply -f deploy/manifests/namespace.yaml
kubectl apply -f deploy/manifests/pvc.yaml
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

## Как устроен CI-деплой

Push в `main` → `.github/workflows/deploy-prod.yml`:

1. Job `test`: прогоняет тесты протокола сигналинга (43 проверки; сам собирает
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
  живут в памяти одного процесса и SQLite-история — с одним писателем; см.
  комментарий в `deploy/manifests/deployment.yaml`. Практическое следствие:
  каждый деплой на несколько секунд обрывает активные трансляции.
- Миграций/`initContainer` нет — sqlx-миграции вшиты в бинарь и применяются
  сами при старте (`src/db.rs`).
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
