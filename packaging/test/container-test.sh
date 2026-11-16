#!/usr/bin/env bash
# Starts the image and calls the API through Caddy. Needs Docker. Exits non-zero on the first
# failed check and prints which one. Usage:
#   bash packaging/test/container-test.sh          the container checks (builds the image unless IMAGE is set)
#   bash packaging/test/container-test.sh arm64    the arm64 smoke check under QEMU
# All logins in this test are made up here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUFFIX="$$"
NET="hm-test-net-$SUFFIX"
BROKER_IMAGE="eclipse-mosquitto:2"
CURL_IMAGE="curlimages/curl:latest"
CADDY_IMAGE="caddy:2.11.9-alpine"
INGRESS_IP="172.30.32.2"
OTHER_IP="172.30.33.5"
BROKER_IP="172.30.32.20"
HM_IP="172.30.32.10"
CONTAINERS=()
VOLUMES=()
TMP="$(mktemp -d)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok: $*"; }

check() { # check "description" command...
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "${LAST_CONTAINER:-}" ]; then
    echo "--- log of $LAST_CONTAINER ---" >&2
    docker logs "$LAST_CONTAINER" 2>&1 | tail -40 >&2 || true
  fi
  for name in "${CONTAINERS[@]:-}"; do [ -n "$name" ] && docker rm -f "$name" >/dev/null 2>&1; done
  for name in "${VOLUMES[@]:-}"; do [ -n "$name" ] && docker volume rm -f "$name" >/dev/null 2>&1; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

if [ "${1:-}" = "arm64" ]; then
  IMAGE_ARM="heatmaster:container-test-arm64"
  docker buildx build --platform linux/arm64 --load -f "$ROOT/packaging/Dockerfile" -t "$IMAGE_ARM" "$ROOT"
  out="$(docker run --rm --platform linux/arm64 --entrypoint node "$IMAGE_ARM" -p 'process.version + " " + typeof Temporal')"
  [[ "$out" == v26.*" object" ]] || fail "arm64: node is version 26 and has Temporal (got: $out)"
  pass "arm64: node starts, is version 26 and has Temporal"
  docker run --rm --platform linux/arm64 --entrypoint caddy "$IMAGE_ARM" version >/dev/null ||
    fail "arm64: caddy prints its version"
  pass "arm64: caddy prints its version"
  exit 0
fi

IMAGE="${IMAGE:-}"
if [ -z "$IMAGE" ]; then
  IMAGE="heatmaster:container-test"
  docker build -f "$ROOT/packaging/Dockerfile" -t "$IMAGE" "$ROOT"
fi

rand() { head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
BROKER_USER="u$(rand)"
BROKER_PASSWORD="p$(rand)"
SUPERVISOR_TOKEN="t$(rand)"
UI_LOGIN="admin"
UI_PASSWORD="w$(rand)"

docker network create --subnet 172.30.32.0/23 "$NET" >/dev/null

# ---- helpers -------------------------------------------------------------------------------------

# curl from a throwaway container with a fixed address: from IP, then curl's arguments.
from() {
  local ip="$1"
  shift
  docker run --rm --network "$NET" --ip "$ip" "$CURL_IMAGE" "$@"
}

broker_sub() { # broker_sub timeout_seconds mosquitto_sub arguments...
  local wait="$1"
  shift
  docker exec hm-broker mosquitto_sub -h 127.0.0.1 -u "$BROKER_USER" -P "$BROKER_PASSWORD" -W "$wait" -C 1 "$@"
}

# start_hm NAME IP [docker run arguments...]: a Heatmaster container with the broker's login.
start_hm() {
  local name="$1" ip="$2"
  shift 2
  CONTAINERS+=("$name")
  LAST_CONTAINER="$name"
  docker run -d --name "$name" --network "$NET" --ip "$ip" "$@" "$IMAGE" >/dev/null
}

hm_env_broker=(-e "MQTT_URL=mqtt://$BROKER_IP:1883" -e "MQTT_USERNAME=$BROKER_USER" -e "MQTT_PASSWORD=$BROKER_PASSWORD")

wait_for() { # wait_for seconds description command...
  local seconds="$1" description="$2"
  shift 2
  local end=$((SECONDS + seconds))
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || fail "$description (not within ${seconds} s)"
    sleep 1
  done
  pass "$description"
}

health() { docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null; }
is_healthy() { [ "$(health "$1")" = "healthy" ]; }
logs_of() { docker logs "$1" 2>&1; }
log_has() {
  local text
  text="$(logs_of "$1")"
  grep -q -- "$2" <<<"$text"
}
stop_hm() { docker stop -t 30 "$1" >/dev/null; docker rm "$1" >/dev/null; }

# ---- the broker ----------------------------------------------------------------------------------

CONTAINERS+=("hm-broker")
docker run -d --name hm-broker --network "$NET" --ip "$BROKER_IP" --entrypoint sh "$BROKER_IMAGE" -c "
  mosquitto_passwd -b -c /tmp/passwd '$BROKER_USER' '$BROKER_PASSWORD' && chown mosquitto /tmp/passwd &&
  printf 'listener 1883\nallow_anonymous false\npassword_file /tmp/passwd\n' >/tmp/mosquitto.conf &&
  exec mosquitto -c /tmp/mosquitto.conf" >/dev/null
wait_for 30 "the broker answers" docker exec hm-broker mosquitto_sub -h 127.0.0.1 -u "$BROKER_USER" -P "$BROKER_PASSWORD" -t '$SYS/broker/version' -C 1 -W 2

# ---- plain container -----------------------------------------------------------------------------

start_hm hm-main "$HM_IP" "${hm_env_broker[@]}"
wait_for 60 "within 60 s the container is healthy" is_healthy hm-main
status_is() { [ "$(broker_sub 5 -t heatmaster/status)" = "$1" ]; }
exec_out() { local name="$1"; shift; docker exec "$name" "$@"; }
node_info() { exec_out hm-main node -p 'process.version + " " + typeof Temporal' | grep -q '^v26\..* object$'; }
server_cmdline() {
  exec_out hm-main sh -c 'for p in /proc/[0-9]*; do tr "\0" " " <$p/cmdline 2>/dev/null; echo; done' |
    grep -x 'node /opt/heatmaster/packages/server/src/main.ts *' >/dev/null
}
core_path() {
  docker exec -w /opt/heatmaster/packages/server hm-main node --input-type=module \
    -e 'console.log(import.meta.resolve("@heatmaster/core"))' |
    grep -qx 'file:///opt/heatmaster/packages/core/src/index.ts'
}
wait_for 20 "heatmaster/status on the broker reads online" status_is online
check "node in the image is version 26 and has Temporal" node_info
check "the server process is node running /opt/heatmaster/packages/server/src/main.ts" server_cmdline
check "@heatmaster/core resolves to /opt/heatmaster/packages/core/src/index.ts, outside every node_modules folder" core_path

[ "$(from "$INGRESS_IP" -fsS "http://$HM_IP:8099/api/health" | docker exec -i hm-main jq -r .status)" = ok ] ||
  fail "from 172.30.32.2 on port 8099 GET /api/health answers 200 with status ok"
pass "from 172.30.32.2 on port 8099 GET /api/health answers 200 with status ok"
from "$INGRESS_IP" -fsS "http://$HM_IP:8099/api/state" | docker exec -i hm-main jq -e '.links | has("ha") | not' >/dev/null ||
  fail "GET /api/state answers 200 and its links has no ha key"
pass "GET /api/state answers 200 and its links has no ha key"
INDEX="$(from "$INGRESS_IP" -fsS "http://$HM_IP:8099/")"
echo "$INDEX" | grep -q "<html" || fail "GET / answers the page"
pass "GET / answers the page"
ASSETS="$(echo "$INDEX" | grep -oE '(src|href)="[^"]*assets/[^"]+"' | sed -E 's/^[a-z]+="(\.\/)?//; s/"$//')"
[ -n "$ASSETS" ] || fail "the page names no script and no style"
for asset in $ASSETS; do
  from "$INGRESS_IP" -fsS -o /dev/null "http://$HM_IP:8099/$asset" || fail "the asset $asset loads"
done
pass "its script and style load"
[ "$(from "$INGRESS_IP" -s -o /dev/null -w '%{http_code}' "http://$HM_IP:8099/some/deep/path")" = 404 ] ||
  fail "GET /some/deep/path answers 404"
pass "GET /some/deep/path answers 404"
UPGRADE="$(from "$INGRESS_IP" -s -i -m 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://$HM_IP:8099/api/events" || true)"
echo "$UPGRADE" | head -1 | grep -q " 101" || fail "an upgrade request to /api/events answers 101"
pass "an upgrade request to /api/events answers 101"

status=0
from "$OTHER_IP" -sS -m 5 "http://$HM_IP:8099/api/health" >/dev/null 2>&1 || status=$?
[ "$status" -eq 52 ] || fail "from another address on port 8099 the connection is closed without an answer (curl exit $status)"
pass "from another address on port 8099 the connection is closed without an answer"
status=0
from "$OTHER_IP" -sS -m 5 "http://$HM_IP:3000/api/health" >/dev/null 2>&1 || status=$?
[ "$status" -eq 7 ] || fail "from outside the container on port 3000 the connection is refused (curl exit $status)"
pass "from outside the container on port 3000 the connection is refused"
status=0
from "$OTHER_IP" -sS -m 5 "http://$HM_IP:8080/" >/dev/null 2>&1 || status=$?
[ "$status" -eq 7 ] || fail "without UI_USER and UI_PASSWORD_HASH nothing listens on port 8080 (curl exit $status)"
pass "without UI_USER and UI_PASSWORD_HASH nothing listens on port 8080"
! log_has hm-main "$BROKER_PASSWORD" || fail "the log holds the broker password"

START=$SECONDS
docker stop -t 30 hm-main >/dev/null
TOOK=$((SECONDS - START))
[ "$TOOK" -le 15 ] || fail "stopped with a 30 s grace time it ends within 15 s (took $TOOK s)"
[ "$(docker inspect -f '{{.State.ExitCode}}' hm-main)" = 0 ] || fail "it ends with exit code 0 (got $(docker inspect -f '{{.State.ExitCode}}' hm-main))"
pass "stopped with a 30 s grace time it ends within 15 s with exit code 0"
status_is offline || fail "heatmaster/status reads offline"
pass "heatmaster/status reads offline"
docker rm hm-main >/dev/null

# ---- the password listener -----------------------------------------------------------------------

HASH="$(docker run --rm "$CADDY_IMAGE" caddy hash-password --plaintext "$UI_PASSWORD")"
start_hm hm-pw "$HM_IP" "${hm_env_broker[@]}" -e "UI_USER=$UI_LOGIN" -e "UI_PASSWORD_HASH=$HASH"
wait_for 60 "with both set, the container is healthy" is_healthy hm-pw
code() { from "$OTHER_IP" -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "http://$HM_IP:8080/api/health")" = 401 ] || fail "port 8080 answers 401 without a login"
[ "$(code -u "$UI_LOGIN:$UI_PASSWORD" "http://$HM_IP:8080/api/health")" = 200 ] || fail "port 8080 answers 200 with the right login"
pass "port 8080 answers 401 without a login and 200 with the right one"
[ "$(code -u "$UI_LOGIN:wrong-$UI_PASSWORD" "http://$HM_IP:8080/api/health")" = 401 ] || fail "a wrong password answers 401"
pass "a wrong password answers 401"
stop_hm hm-pw

start_hm hm-half "$HM_IP" "${hm_env_broker[@]}" -e "UI_USER=$UI_LOGIN"
wait_for 60 "with only UI_USER set, the container is healthy" is_healthy hm-half
status=0
from "$OTHER_IP" -sS -m 5 "http://$HM_IP:8080/" >/dev/null 2>&1 || status=$?
[ "$status" -eq 7 ] || fail "with only UI_USER set nothing listens on port 8080 (curl exit $status)"
log_has hm-half "UI_USER and UI_PASSWORD_HASH must both be set" || fail "the log holds the warning"
pass "with only UI_USER set nothing listens on port 8080 and the log holds the warning"
stop_hm hm-half

# ---- a broker that is down at boot ---------------------------------------------------------------

start_hm hm-nobroker "$HM_IP" -e "MQTT_URL=mqtt://172.30.32.99:1883"
probe() {
  local body
  body="$(docker exec hm-nobroker curl -s http://127.0.0.1:3000/api/health)"
  grep -q '"reason":"mqtt_unavailable"' <<<"$body"
}
wait_for 60 "with no broker the API answers 503 with reason mqtt_unavailable" probe
docker exec hm-nobroker /usr/local/bin/heatmaster-healthcheck ||
  fail "a broker that is down does not make the health check fail (a watchdog would restart in a loop)"
pass "a broker that is down at boot does not make the health check fail"
[ "$(docker inspect -f '{{.RestartCount}}' hm-nobroker)" = 0 ] || fail "the container was not restarted"
stop_hm hm-nobroker

# ---- bad options ---------------------------------------------------------------------------------

start_hm hm-bad "$HM_IP"
code_bad="$(timeout 90 docker wait hm-bad)" || fail "with MQTT_URL not set the container stops"
[ "$code_bad" = 78 ] || fail "with MQTT_URL not set the container stops with exit code 78 (got $code_bad)"
log_has hm-bad "MQTT_URL" || fail "the log names MQTT_URL"
pass "with MQTT_URL not set the log names MQTT_URL and the container stops with exit code 78"
docker rm hm-bad >/dev/null

# ---- the restart limit ---------------------------------------------------------------------------

# A stand-in for main.ts, bound over it. It counts its starts in /data/count.
cat >"$TMP/always-exit.ts" <<'TS'
console.log("stand-in server started");
process.exit(1);
TS
cat >"$TMP/exit-four-times.ts" <<'TS'
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = "/data/count";
const count = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
writeFileSync(file, String(count));
console.log(`stand-in server started, start ${count}`);
if (count <= 4) process.exit(1);
setInterval(() => undefined, 1000);
TS
MAIN_TS=/opt/heatmaster/packages/server/src/main.ts
started_lines() { docker logs "$1" 2>&1 | grep -c "stand-in server started" || true; }

start_hm hm-limit "$HM_IP" "${hm_env_broker[@]}" -v "$TMP/always-exit.ts:$MAIN_TS:ro"
code_limit="$(timeout 120 docker wait hm-limit)" || fail "with a server that always exits with code 1 the container halts"
[ "$code_limit" = 1 ] || fail "the container halts with exit code 1 (got $code_limit)"
[ "$(started_lines hm-limit)" = 5 ] || fail "the server is started five times (got $(started_lines hm-limit))"
log_has hm-limit "started five times" || fail "the log holds the started five times line"
pass "a server that always exits with code 1 is started five times; the sixth start halts the container with exit code 1"
docker start hm-limit >/dev/null
code_again="$(timeout 60 docker wait hm-limit)" || fail "the halted container started again halts again"
[ "$code_again" = 1 ] || fail "started again it halts again with exit code 1 (got $code_again)"
[ "$(started_lines hm-limit)" = 5 ] || fail "started again it does not start the server (now $(started_lines hm-limit))"
pass "the halted container started again at once halts again without starting the server"
docker rm hm-limit >/dev/null

start_hm hm-four "$HM_IP" "${hm_env_broker[@]}" -v "$TMP/exit-four-times.ts:$MAIN_TS:ro"
wait_for 60 "a server that exits four times and then stays up is started again each time" \
  bash -c "[ \"\$(docker logs hm-four 2>&1 | grep -c 'stand-in server started, start 5')\" = 1 ]"
[ "$(docker inspect -f '{{.State.Running}}' hm-four)" = true ] || fail "the container is still running after the fifth start"
docker rm -f hm-four >/dev/null

# ---- app mode with a stand-in Supervisor ---------------------------------------------------------

OPTIONS_VOLUME="hm-data-$SUFFIX"
VOLUMES+=("$OPTIONS_VOLUME")
docker volume create "$OPTIONS_VOLUME" >/dev/null
docker run --rm -v "$OPTIONS_VOLUME:/data" --entrypoint sh "$IMAGE" -c \
  "echo '{\"z2m_base_topic\":\"z2m-test\",\"discovery_prefix\":\"ha-test\"}' >/data/options.json"
start_hm hm-app "$HM_IP" -e "SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN" -v "$OPTIONS_VOLUME:/data"
wait_for 60 "with the stand-in not answering at first, the log holds the no MQTT broker line" log_has hm-app "no MQTT broker"
# The answer of research item 2, with the test broker's login in data.
cat >"$TMP/Caddyfile" <<CADDYFILE
{
	admin off
}
http://:80 {
	header Content-Type application/json
	respond \`{"result":"ok","data":{"addon":"core_mosquitto","host":"$BROKER_IP","port":1883,"ssl":false,"protocol":"3.1.1","username":"$BROKER_USER","password":"$BROKER_PASSWORD"}}\` 200
}
CADDYFILE
CONTAINERS+=("hm-supervisor")
docker run -d --name hm-supervisor --network "$NET" --ip 172.30.32.30 --network-alias supervisor \
  -v "$TMP/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null
wait_for 90 "the server starts once the stand-in answers: heatmaster/status reads online (the login was used)" \
  bash -c "[ \"\$(docker exec hm-broker mosquitto_sub -h 127.0.0.1 -u '$BROKER_USER' -P '$BROKER_PASSWORD' -W 3 -C 1 -t heatmaster/status)\" = online ]"
wait_for 60 "the container is healthy in app mode" is_healthy hm-app
from "$INGRESS_IP" -fsS "http://$HM_IP:8099/api/state" | docker exec -i hm-app jq -e '.links | has("ha")' >/dev/null ||
  fail "GET /api/state from 172.30.32.2 has a ha key in links"
pass "GET /api/state from 172.30.32.2 has a ha key in links"
wait_for 30 "the system device's config is retained under the prefix from options.json" \
  broker_sub 3 -t 'ha-test/device/+/system/config'
! log_has hm-app "$BROKER_PASSWORD" || fail "the log holds the broker password"
! log_has hm-app "$SUPERVISOR_TOKEN" || fail "the log holds the token"
pass "the log holds neither the broker password nor the token"
stop_hm hm-app

echo "all container checks passed"
