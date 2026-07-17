# Deploy to KubeSolo

IaC for this project. Applied by an **admin** (not CI) — the deploy user
from CI can only change the image tag on an already-created Deployment. The
approach and conventions come from the `simple-deploy` playbook
(`kube/backend-deploy.md`).

This is the **split** production topology (this project's own instance) —
`deployment.yaml` for the app plus `manifests/turn.yaml` for a separate
TURN deployment. For a simpler, single-binary self-host alternative (TURN
embedded in the app container, no separate TURN deployment at all), see
[`examples/docker-compose.embedded.yml`](examples/docker-compose.embedded.yml)
and [`../docs/self-hosting.md` §5.2](../docs/self-hosting.md#52-embedded-turn-single-binary).

## Order of application (once, with the admin kubeconfig)

```bash
kubectl apply -f deploy/manifests/namespace.yaml
kubectl apply -f deploy/manifests/rbac.yaml
kubectl apply -f deploy/manifests/deployment.yaml   # image: chat:PLACEHOLDER — the pod won't come up
                                                     # until CI deploys the first real tag
kubectl apply -f deploy/manifests/service.yaml
kubectl apply -f deploy/manifests/ingress.yaml
```

`rbac.yaml` sets up a Role+RoleBinding in the `chat-prod` namespace for the
already-existing `ServiceAccount deployer` (ns `deploy`, shared across all
projects on the server — see `simple-deploy/artifacts/server/rbac.yaml`).

`ingress.yaml` assumes the `cloudflare-tunnel-ingress-controller` is already
deployed on the cluster (see `simple-deploy/cloudflare/tunnel.md`,
"Option 2") — nothing needs to be set up separately in the Cloudflare
dashboard; the controller creates the DNS and tunnel from the `Ingress`
itself.

## Metrics (Prometheus + Grafana)

`deployment.yaml` (applied in the steps above) already carries everything
needed for scraping — a second port `mgmt` (8081, `/metrics`) and
`prometheus.io/scrape|port|path` annotations on the pod (the same pattern as
`code-ranker-backend`, see `src/main.rs::spawn_metrics_server`,
`simple-deploy/standards/observability/metrics.md`). Nothing extra needs to
be applied for this — Prometheus (`kubernetes_sd_config`, role `pod`) picks
up the new pod on its own, without editing its own config.

The Grafana dashboard is a separate ConfigMap, NOT part of the list above,
and is applied the same way, manually, by an admin:

```bash
kubectl apply -f deploy/monitoring/grafana-dashboard-chat.yaml
```

This single `apply` is NOT enough on its own for the dashboard to show up in
Grafana: the `grafana` pod itself (ns `monitoring`) mounts dashboards via a
`projected volume` (a `ConfigMap` per dashboard — see
`grafana-dashboard-code-ranker`, `grafana-dashboard-store`), whose list of
sources today is defined ONLY in the `grafana` Deployment itself, not in this
repo's manifests (the monitoring stack isn't part of `chat` at all — it's
shared across the whole cluster). So after the `apply` above you ALSO need
to, by hand, add `configMap.name: grafana-dashboard-chat` to
`spec.template.spec.volumes[].projected.sources` on the `grafana` Deployment
(ns `monitoring`), for example:

```bash
kubectl -n monitoring edit deployment grafana
# in volumes: - name: dashboards -> projected.sources: add
#   - configMap: { name: grafana-dashboard-chat }
kubectl -n monitoring rollout restart deployment grafana
```

The provisioning sidecar (`grafana-dashboards-provider`,
`updateIntervalSeconds: 30`) picks up the file on its own after that —
recreating the pod again for every future update to the JSON inside
`grafana-dashboard-chat` (unlike adding the source the first time) is no
longer required.

## How the CI deploy works

Push to `main` → `.github/workflows/deploy-prod.yml`:

1. Job `test`: runs the signaling protocol tests (65 checks; builds
   `cargo build` itself). Failing tests block the deploy.
2. Job `deploy` (`needs: test`): builds the image (`docker buildx build
   --provenance=false --sbom=false --platform linux/amd64`, GHA cache),
   immutable tag **`prod-<short-sha>`** of exactly the commit that was
   pushed; `APP_VERSION`/`GIT_COMMIT`/`BUILD_DATE` are baked into the image
   (see `/version.json`).
3. Delivers it to the server directly over SSH (no registry):
   `docker save | gzip | ssh … "prod <tag>"`.
4. The server-side script (`deployer`, forced command) imports the image
   into containerd, runs `kubectl set image deployment/chat '*=chat:<tag>'`,
   and waits for `rollout status`.

CI knows nothing about the manifests above — they aren't recreated on every
deploy, only the image tag on the already-existing Deployment changes.

## Notable characteristics of this Deployment (important)

- **`replicas: 1` + `strategy.type: Recreate`**, not the usual
  zero-downtime template (`replicas: 2` + `RollingUpdate`). Reason — rooms
  live in the memory of a single process (`src/state.rs`); see the comment
  in `deploy/manifests/deployment.yaml`. Practical consequence: every deploy
  cuts off active broadcasts for a few seconds.
- **No storage on disk whatsoever.** The application is fully ephemeral:
  chat history and room state live only in the process's memory and die
  along with the room (TTL reaper) or with a pod restart. That's why the
  manifests deliberately have no PVC/volume — they were removed along with
  SQLite leaving the application; there's nothing left to write to disk.
- The application needs no secrets (TURN, if it's ever needed, would go
  through a `Secret` + `envFrom`, the same as other projects on the server).

## Rollback

The main path (as with the other projects on the server) is to rerun the
previous commit's run: `gh run rerun <id>` (rebuilds and re-imports the same
`prod-<sha>`; this is also what saves you after a kubesolo restart, when
local images are gone). A quick local rollback, while the old image is still
in containerd:

```bash
kubectl -n chat-prod rollout undo deployment/chat
# or to a specific tag:
kubectl -n chat-prod set image deployment/chat '*=chat:prod-<old_sha>'
```
