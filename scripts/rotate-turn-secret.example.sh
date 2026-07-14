#!/usr/bin/env bash
#
# rotate-turn-secret.example.sh — EXAMPLE, ADAPT TO YOUR DEPLOYMENT.
#
# Rotates the shared secret used for this project's TURN REST API-style
# credential scheme (see docs/security.md §3 and docs/self-hosting.md §5.1).
#
# Why this exists: the TTL embedded in a TURN credential's username is NOT
# enforced by the TURN server itself (it only checks the HMAC). The only
# real way to bound how long a leaked credential stays usable is to rotate
# the shared secret periodically, in BOTH places that must agree:
#
#   1. Your TURN server's static-auth-secret setting (e.g. coturn's
#      use-auth-secret/static-auth-secret, or turn-rs's static-auth-secret).
#   2. This project's TURN_STATIC_SECRET environment variable.
#
# ...and then restart both, since this application only reads
# TURN_STATIC_SECRET at process start.
#
# This script is deliberately NOT plug-and-play: it generates a new secret
# and shows you, with placeholders, where it needs to go. It does not know
# how your TURN server is configured or how your application is deployed
# (bare process? docker compose? an orchestrator?), so it stops short of
# applying the secret for you. Fill in the two "APPLY" sections below with
# commands appropriate to your own infrastructure, then this becomes a real
# rotation script you can run by hand or from a scheduler (cron, a
# Kubernetes CronJob, a systemd timer — whatever your deployment already
# uses). See docs/self-hosting.md §8 for why it's a good idea to keep that
# scheduling/deployment glue in your own private infra rather than this
# public repo.
#
# Usage:
#   ./scripts/rotate-turn-secret.example.sh
#
set -euo pipefail

echo "== TURN shared-secret rotation (example) =="

# --- 1. Generate a new high-entropy secret --------------------------------
NEW_SECRET="$(openssl rand -hex 32)"
echo "Generated new secret (store it in your own secret manager, don't just leave it in shell history):"
echo "  ${NEW_SECRET}"
echo

# --- 2a. APPLY to your TURN server -----------------------------------------
#
# Update your TURN server's static-auth-secret setting to NEW_SECRET, then
# reload/restart it so the change takes effect. This is entirely dependent
# on how you run your TURN server, so this script only shows placeholders.
#
# Example if you manage coturn's config file directly and reload via systemd:
#   sed -i "s/^static-auth-secret=.*/static-auth-secret=${NEW_SECRET}/" /etc/turnserver.conf
#   systemctl restart coturn
#
# Example if your TURN server runs via docker compose (adjust service name):
#   sed -i "s/^STATIC_AUTH_SECRET=.*/STATIC_AUTH_SECRET=${NEW_SECRET}/" turn.env
#   docker compose restart turn
#
echo "TODO: apply NEW_SECRET to your TURN server's static-auth-secret setting,"
echo "      then restart/reload your TURN server. (See commented examples in this script.)"
echo

# --- 2b. APPLY to this project's application -------------------------------
#
# Update TURN_STATIC_SECRET to the SAME NEW_SECRET value wherever your
# application reads its environment from, then restart the application
# process so it picks up the new value (it's only read at startup).
#
# Example if you run this project via docker compose (see docker-compose.yml):
#   sed -i "s/^TURN_STATIC_SECRET=.*/TURN_STATIC_SECRET=${NEW_SECRET}/" app.env
#   docker compose up -d chat   # recreates the container with the new env
#
# Example if you manage the app via a generic orchestrator/secret store:
#   your-secret-manager set TURN_STATIC_SECRET "${NEW_SECRET}"
#   your-orchestrator restart chat
#
echo "TODO: apply the SAME NEW_SECRET to this project's TURN_STATIC_SECRET env var,"
echo "      then restart the application. (See commented examples in this script.)"
echo

echo "== Reminder =="
echo "Both updates above must use the SAME secret value and both services must"
echo "be restarted for the rotation to take effect. Expect a brief interruption"
echo "of the TURN relay only (direct peer-to-peer connections are unaffected)."
echo "Schedule this periodically (e.g. weekly/monthly) via cron / a Kubernetes"
echo "CronJob / a systemd timer in your own infrastructure — see"
echo "docs/self-hosting.md §5.1 and §8."
