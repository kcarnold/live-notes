#!/bin/bash
# Launch wrapper for the Proclaim service (auto-update on launch).
#
# The LaunchAgent runs this instead of `uv run proclaim_service.py` directly, so
# every start - reboot, crash restart, midnight doc roll, manual restart - is an
# update opportunity: fast-forward the checkout to the release branch
# (`proclaim-stable` by default), sync dependencies, then run the service.
#
# The invariant this script exists to protect: **the service always starts.**
# Every update step is best-effort and bounded by a timeout; any failure is
# logged and the previously working checkout runs instead. An update that syncs
# a broken dependency set rolls the checkout back to the SHA that was running
# before. There is no path here that ends in "didn't run because the update
# failed".
#
# Environment (all optional; the generated plist sets the first four):
#   UV_BIN                     path to `uv`               (default: from PATH)
#   GIT_BIN                    path to `git`              (default: from PATH)
#   PROCLAIM_UPDATE_BRANCH     release branch to track    (default: proclaim-stable)
#   PROCLAIM_AUTO_UPDATE       0/false disables updating  (default: enabled)
#   PROCLAIM_SERVICE_SCRIPT    service entry point        (default: ./proclaim_service.py)
#   PROCLAIM_UPDATE_TIMEOUT    seconds per git step       (default: 60)
#   PROCLAIM_SYNC_TIMEOUT      seconds for `uv sync`      (default: 300)
#
# Deliberately NOT `set -e`: a failing update step must fall through to running
# the service, not abort the script.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR" || exit 1

UPDATE_BRANCH="${PROCLAIM_UPDATE_BRANCH:-proclaim-stable}"
AUTO_UPDATE="${PROCLAIM_AUTO_UPDATE:-1}"
GIT_BIN="${GIT_BIN:-$(command -v git)}"
UV_BIN="${UV_BIN:-$(command -v uv)}"
SERVICE_SCRIPT="${PROCLAIM_SERVICE_SCRIPT:-$REPO_DIR/proclaim_service.py}"
GIT_TIMEOUT="${PROCLAIM_UPDATE_TIMEOUT:-60}"
SYNC_TIMEOUT="${PROCLAIM_SYNC_TIMEOUT:-300}"

# Never let git block on credentials or a host-key prompt on an unattended Mac,
# and give ssh remotes a connect timeout of their own.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=10}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - proclaim-launcher - $*"
}

# Bounded run: macOS has no coreutils `timeout`, so poll the child and kill it if
# it overruns. A network black hole must not wedge the launch.
run_with_timeout() {
    local seconds="$1"
    shift
    "$@" &
    local pid=$!
    local waited=0
    while kill -0 "$pid" 2>/dev/null; do
        if [ "$waited" -ge "$seconds" ]; then
            log "timed out after ${seconds}s: $*"
            kill -TERM "$pid" 2>/dev/null
            sleep 2
            kill -KILL "$pid" 2>/dev/null
            wait "$pid" 2>/dev/null
            return 124
        fi
        sleep 1
        waited=$((waited + 1))
    done
    wait "$pid"
}

git_step() {
    run_with_timeout "$GIT_TIMEOUT" "$GIT_BIN" \
        -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 "$@"
}

# Quiet, non-timed git reads (no network, so they can't hang).
git_read() {
    "$GIT_BIN" "$@" 2>/dev/null
}

update_checkout() {
    local prev_sha target_sha

    prev_sha="$(git_read rev-parse HEAD)"
    if [ -z "$prev_sha" ]; then
        log "not a git checkout ($REPO_DIR); skipping update"
        return 1
    fi

    if ! git_step fetch --quiet origin "$UPDATE_BRANCH"; then
        log "fetch of origin/$UPDATE_BRANCH failed; running the current version"
        return 1
    fi

    target_sha="$(git_read rev-parse FETCH_HEAD)"
    if [ -z "$target_sha" ]; then
        log "could not resolve origin/$UPDATE_BRANCH; running the current version"
        return 1
    fi

    if [ "$prev_sha" = "$target_sha" ] && [ "$(git_read rev-parse --abbrev-ref HEAD)" = "$UPDATE_BRANCH" ]; then
        log "already up to date on $UPDATE_BRANCH at ${prev_sha:0:7}"
        return 0
    fi

    if ! git_step checkout -q "$UPDATE_BRANCH"; then
        log "checkout of $UPDATE_BRANCH failed (local changes?); running the current version"
        return 1
    fi

    # Fast-forward only: a diverged local branch keeps running what it has rather
    # than being force-moved underneath the operator.
    if ! git_step merge --ff-only --quiet "$target_sha"; then
        log "fast-forward to ${target_sha:0:7} failed (local commits on $UPDATE_BRANCH?); running the current version"
        return 1
    fi

    if [ "$(git_read rev-parse HEAD)" = "$prev_sha" ]; then
        log "already up to date on $UPDATE_BRANCH at ${prev_sha:0:7}"
        return 0
    fi

    log "updated $UPDATE_BRANCH: ${prev_sha:0:7} -> ${target_sha:0:7}"

    # New code can mean new dependencies. Sync them now so a failure is visible
    # here (and rollable-back) instead of taking the service down on launch.
    if ! run_with_timeout "$SYNC_TIMEOUT" "$UV_BIN" sync; then
        log "dependency sync failed for ${target_sha:0:7}; rolling back to ${prev_sha:0:7}"
        if git_step checkout -q --detach "$prev_sha"; then
            run_with_timeout "$SYNC_TIMEOUT" "$UV_BIN" sync >/dev/null 2>&1
            log "rolled back to ${prev_sha:0:7} (detached HEAD); next launch will retry the update"
        else
            log "rollback to ${prev_sha:0:7} failed; starting the service anyway"
        fi
        return 1
    fi

    return 0
}

if [ -z "$UV_BIN" ]; then
    log "uv not found (set UV_BIN); cannot start the service"
    exit 1
fi

if [ -z "$GIT_BIN" ]; then
    log "git not found (set GIT_BIN); skipping update"
elif [ "$AUTO_UPDATE" = "0" ] || [ "$AUTO_UPDATE" = "false" ]; then
    log "auto-update disabled (PROCLAIM_AUTO_UPDATE=$AUTO_UPDATE)"
else
    update_checkout
fi

# Hand the running version to the service so it can report it in the status map:
# the channel SHA is what `proclaim-stable` pointed at as of this launch's fetch,
# so a mismatch means "update pending - restart the service".
if [ -n "$GIT_BIN" ]; then
    export PROCLAIM_SERVICE_GIT_SHA="$(git_read rev-parse HEAD)"
    export PROCLAIM_SERVICE_GIT_BRANCH="$(git_read rev-parse --abbrev-ref HEAD)"
    export PROCLAIM_UPDATE_CHANNEL="$UPDATE_BRANCH"
    export PROCLAIM_UPDATE_CHANNEL_SHA="$(git_read rev-parse "origin/$UPDATE_BRANCH")"
fi

log "starting proclaim service (${PROCLAIM_SERVICE_GIT_SHA:0:7} on ${PROCLAIM_SERVICE_GIT_BRANCH:-unknown})"
exec "$UV_BIN" run "$SERVICE_SCRIPT" "$@"
