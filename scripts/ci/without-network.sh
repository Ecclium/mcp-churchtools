#!/usr/bin/env bash
# Runs a command without network (ADR 0052): in a new network namespace whose
# only device is loopback, as the runner user, with the same environment and
# without capabilities. CI runs build and checks of the jobs check, compat
# and minimum through it:
#
#   bash scripts/ci/without-network.sh pnpm run ci:check
#
# Linux only. On a GitHub-hosted runner, Docker stops first: its socket
# would lead out of the namespace. Way b: on a GitHub-hosted runner, lift
# the AppArmor restriction on unprivileged user namespaces for the rest of
# the job, then build the namespace without root. Way c, if b gives no
# namespace: create it with sudo and drop back to the runner user, without
# groups and without a way to gain privileges. Without a namespace the step
# fails; the checks never run with network.
set -euo pipefail

script=$(readlink -f "$0")
root=$(dirname "$(dirname "$(dirname "$script")")")
probe="$root/scripts/ci/check-network.mts"

# Prints a line and, on GitHub, the same line as an annotation.
report() {
  printf '%s\n' "$3"
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    printf '::%s title=%s::%s\n' "$1" "$2" "${3//%/%25}"
  fi
}

# Last stage, inside the namespace: show that it has loopback only, then
# run the command. A failed probe ends the step before the checks.
if [ "${1:-}" = --inside ]; then
  shift
  node "$probe" offline
  export ECCLIUM_NETNS=loopback-only
  exec "$@"
fi

if [ "$#" -eq 0 ]; then
  echo 'Aufruf: bash scripts/ci/without-network.sh BEFEHL...' >&2
  exit 2
fi

restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
docker_socket=/var/run/docker.sock
uid=$(id -u)
gid=$(id -g)
user=$(id -un)

# Facts the first runs on hosted runners settle (ADR 0052), no addresses.
before=$(cat "$restriction" 2>/dev/null || echo 'nicht vorhanden')
if [ -w "$docker_socket" ]; then docker=erreichbar; else docker='nicht erreichbar'; fi
hosts=$(grep -E '^hosts:' /etc/nsswitch.conf 2>/dev/null || echo 'hosts: unbekannt')
if command -v setpriv >/dev/null 2>&1; then setpriv=vorhanden; else setpriv=fehlt; fi
report notice 'Netzsperre Runner' "Netzsperre: Einschränkung vorher $before; Gruppen $(id -Gn); Docker-Socket $docker; nsswitch $hosts; setpriv $setpriv"

# The job must still reach the outside here, or the probe inside would
# prove nothing.
node "$probe" online

# Docker runs outside the namespace and reaches the network for every
# process that may use its socket. The runner user may, as a member of the
# group docker, and way b keeps the groups. Nothing in the checks needs
# Docker, so on a runner of GitHub it stops for the rest of the job.
# Elsewhere the probe inside fails while the socket answers.
if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && [ -e "$docker_socket" ]; then
  if ! sudo systemctl stop docker.socket docker.service; then
    report error 'Netzsperre' 'Netzsperre: Docker lässt sich nicht stoppen, die Prüfungen laufen nicht'
    exit 1
  fi
  report notice 'Netzsperre Docker' 'Netzsperre: Docker für den Rest des Jobs gestoppt'
fi

# The commands of both ways run in a new shell, which brings up loopback and
# then runs the command it is given as the runner user; their variables
# expand there.
# shellcheck disable=SC2016
inner_b='set -e; ip link set lo up; uid=$1 gid=$2; shift 2
exec unshare --user --map-user="$uid" --map-group="$gid" -- "$@"'
# shellcheck disable=SC2016
inner_c='set -e; ip link set lo up; uid=$1 gid=$2 user=$3 path=$4 home=$5; shift 5
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- \
  env -u SUDO_COMMAND -u SUDO_USER -u SUDO_UID -u SUDO_GID \
  USER="$user" LOGNAME="$user" PATH="$path" HOME="$home" "$@"'

# Way b: lifts the restriction only on a runner of GitHub, then tries the
# namespace once with a command that does nothing. A failure is reported
# with its reason, so that a run shows why a way did not work.
way_b() {
  local out
  if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && [ "$before" = 1 ]; then
    sudo sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=0 || return 1
  fi
  if ! out=$(unshare --user --map-root-user --net -- bash -c "$inner_b" bash "$uid" "$gid" true 2>&1); then
    report warning 'Netzsperre' "Netzsperre: Weg b gescheitert: ${out//$'\n'/ }"
    return 1
  fi
}

# Way c: tries the namespace as root once, with a command that does nothing.
way_c() {
  local out
  [ "$setpriv" = vorhanden ] || return 1
  if ! out=$(sudo -E unshare --net -- bash -c "$inner_c" bash "$uid" "$gid" "$user" "$PATH" "$HOME" true 2>&1); then
    report warning 'Netzsperre' "Netzsperre: Weg c gescheitert: ${out//$'\n'/ }"
    return 1
  fi
}

if way_b; then
  report notice 'Netzsperre' 'Netzsperre: Weg b, Benutzer-Namensräume ohne Root'
  exec unshare --user --map-root-user --net -- bash -c "$inner_b" bash "$uid" "$gid" bash "$script" --inside "$@"
fi
if way_c; then
  report notice 'Netzsperre' 'Netzsperre: Weg c, Namensraum mit sudo, zurück zum Benutzer des Runners'
  exec sudo -E unshare --net -- bash -c "$inner_c" bash "$uid" "$gid" "$user" "$PATH" "$HOME" bash "$script" --inside "$@"
fi
report error 'Netzsperre' 'Netzsperre: kein Netz-Namensraum möglich, die Prüfungen laufen nicht'
exit 1
