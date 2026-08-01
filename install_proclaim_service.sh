#!/bin/bash
# Install proclaim_service as a macOS LaunchAgent
# Usage: bash install_proclaim_service.sh [--server-url=<url>] [--branch=<branch>]
#                                         [--write-key=<key>] [--no-auto-update]
#                                         [--uninstall]
#
# --write-key is the shared key this machine presents to the server's privileged
# endpoints (see docs/WRITE_KEYS.md). It is NOT fetched from the server — /api/config is
# public. Omitting it on a reinstall keeps whatever key is already installed.
#
# The LaunchAgent runs proclaim_service_launch.sh, which updates this checkout
# from the release branch on every launch before starting the service. See
# PROCLAIM_SERVICE_SETUP.md ("Automatic updates").

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_TEMPLATE="$SCRIPT_DIR/org.kenarnold.proclaim-service.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/org.kenarnold.proclaim-service.plist"
SERVICE_SCRIPT="$SCRIPT_DIR/proclaim_service.py"
LAUNCH_SCRIPT="$SCRIPT_DIR/proclaim_service_launch.sh"
SERVICE_LABEL="org.kenarnold.proclaim-service"

# Get current user and paths
CURRENT_USER="$(whoami)"
LOG_DIR="$HOME/Library/Logs/proclaim-service"
UV_PATH="$(which uv)"
GIT_PATH="$(which git || true)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

fetch_posthog_config() {
    local config
    config=$(curl -sf "$SERVER_URL/api/config") || { log_warn "Could not fetch PostHog config from $SERVER_URL (service may be down)"; return 1; }
    POSTHOG_KEY=$(echo "$config" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('posthogKey',''))")
    POSTHOG_HOST=$(echo "$config" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('posthogHost',''))")
}

# Escape a value for use as a sed replacement with | as the delimiter.
sed_escape() {
    printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# The write key already installed, if any. Lets a reinstall (or an --server-url change)
# keep the machine's key instead of silently dropping it.
read_existing_write_key() {
    [ -f "$PLIST_DEST" ] || return 1
    /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:PROCLAIM_WRITE_KEY" \
        "$PLIST_DEST" 2>/dev/null
}

generate_plist() {
    # Generate plist from template with variable substitution
    sed "s|{{SERVICE_SCRIPT}}|$SERVICE_SCRIPT|g" "$PLIST_TEMPLATE" | \
    sed "s|{{LAUNCH_SCRIPT}}|$LAUNCH_SCRIPT|g" | \
    sed "s|{{REPO_PATH}}|$SCRIPT_DIR|g" | \
    sed "s|{{LOG_DIR}}|$LOG_DIR|g" | \
    sed "s|{{USERNAME}}|$CURRENT_USER|g" | \
    sed "s|{{UV_PATH}}|$UV_PATH|g" | \
    sed "s|{{GIT_PATH}}|$GIT_PATH|g" | \
    sed "s|{{UPDATE_BRANCH}}|$UPDATE_BRANCH|g" | \
    sed "s|{{AUTO_UPDATE}}|$AUTO_UPDATE|g" | \
    sed "s|{{POSTHOG_KEY}}|$POSTHOG_KEY|g" | \
    sed "s|{{POSTHOG_HOST}}|$POSTHOG_HOST|g" | \
    sed "s|{{WRITE_KEY}}|$(sed_escape "$WRITE_KEY")|g" | \
    sed "s|{{YSWEET_URL}}|$SERVER_URL|g"
}

uninstall() {
    echo "Uninstalling proclaim service..."

    if launchctl list "$SERVICE_LABEL" &>/dev/null; then
        launchctl unload "$PLIST_DEST"
        log_info "Service unloaded"
    else
        log_warn "Service not loaded"
    fi

    if [ -f "$PLIST_DEST" ]; then
        rm "$PLIST_DEST"
        log_info "Plist file removed"
    fi

    log_info "Uninstall complete"
    exit 0
}

# Parse arguments
SERVER_URL="https://notelate.com"
POSTHOG_KEY=""
POSTHOG_HOST=""
# Release channel the launch wrapper tracks. Promotion is deliberate:
# `git push origin main:proclaim-stable`.
UPDATE_BRANCH="proclaim-stable"
AUTO_UPDATE="1"
WRITE_KEY=""
WRITE_KEY_GIVEN="0"

for arg in "$@"; do
    case "$arg" in
        --uninstall) uninstall ;;
        --server-url=*) SERVER_URL="${arg#--server-url=}" ;;
        --branch=*) UPDATE_BRANCH="${arg#--branch=}" ;;
        --write-key=*) WRITE_KEY="${arg#--write-key=}"; WRITE_KEY_GIVEN="1" ;;
        --no-auto-update) AUTO_UPDATE="0" ;;
    esac
done

# Carry the installed key forward when this run didn't supply one, so routine
# reinstalls and server-url changes don't quietly de-authorize the machine.
if [ "$WRITE_KEY_GIVEN" = "0" ]; then
    WRITE_KEY="$(read_existing_write_key || true)"
fi

if [ -z "$SERVER_URL" ]; then
    log_error "--server-url is required"
    echo "Usage: bash install_proclaim_service.sh --server-url=<url> [--uninstall]"
    exit 1
fi

# Normalize URL (strip trailing slash)
SERVER_URL="${SERVER_URL%/}"

echo "Installing proclaim service..."

# Check prerequisites
if [ ! -f "$PLIST_TEMPLATE" ]; then
    log_error "Plist template not found: $PLIST_TEMPLATE"
    exit 1
fi

if [ ! -f "$SERVICE_SCRIPT" ]; then
    log_error "Service script not found: $SERVICE_SCRIPT"
    exit 1
fi

if [ ! -f "$LAUNCH_SCRIPT" ]; then
    log_error "Launch wrapper not found: $LAUNCH_SCRIPT"
    exit 1
fi

if [ -z "$UV_PATH" ]; then
    log_error "uv not found in PATH. Install uv first: https://docs.astral.sh/uv/"
    exit 1
fi

if [ "$AUTO_UPDATE" = "1" ]; then
    if [ -z "$GIT_PATH" ]; then
        log_warn "git not found in PATH; the service will run but never auto-update"
        AUTO_UPDATE="0"
    elif ! git -C "$SCRIPT_DIR" rev-parse --git-dir &>/dev/null; then
        log_warn "$SCRIPT_DIR is not a git checkout; the service will run but never auto-update"
        AUTO_UPDATE="0"
    elif ! git -C "$SCRIPT_DIR" ls-remote --exit-code --heads origin "$UPDATE_BRANCH" &>/dev/null; then
        log_warn "Branch '$UPDATE_BRANCH' not found on origin (create it with: git push origin main:$UPDATE_BRANCH)"
        log_warn "Auto-update stays on; it will start working once the branch exists"
    fi
fi

# Create LaunchAgents directory if needed
mkdir -p "$HOME/Library/LaunchAgents"
log_info "LaunchAgents directory exists"

# Create log directory
mkdir -p "$LOG_DIR"
log_info "Log directory created at $LOG_DIR"

# Fetch PostHog config from the server
if fetch_posthog_config "$SERVER_URL"; then
    log_info "PostHog config fetched from $SERVER_URL"
else
    log_warn "PostHog error reporting will be disabled"
fi

# Generate and install plist from template
generate_plist > "$PLIST_DEST"
log_info "Plist generated and installed to $PLIST_DEST"
log_info "  User:   $CURRENT_USER"
log_info "  Repo:   $SCRIPT_DIR"
log_info "  Logs:   $LOG_DIR"
log_info "  uv:     $UV_PATH"
log_info "  Server: $SERVER_URL"
if [ -n "$WRITE_KEY" ]; then
    if [ "$WRITE_KEY_GIVEN" = "1" ]; then
        log_info "  Key:    installed"
    else
        log_info "  Key:    kept from the previous install"
    fi
else
    log_warn "  Key:    none — pass --write-key=<key> once the server enforces write keys"
fi
if [ "$AUTO_UPDATE" = "1" ]; then
    log_info "  Update: on every launch, from origin/$UPDATE_BRANCH"
else
    log_info "  Update: disabled (runs whatever is checked out)"
fi

# Check if already loaded
if launchctl list "$SERVICE_LABEL" &>/dev/null; then
    log_warn "Service already loaded, reloading..."
    launchctl unload "$PLIST_DEST"
    sleep 1
fi

# Load service
launchctl load "$PLIST_DEST"
log_info "Service loaded"

# Check if service started
sleep 2
if launchctl list "$SERVICE_LABEL" &>/dev/null; then
    log_info "Service is running"
else
    log_warn "Service may not be running yet (check logs)"
fi

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  • View status:        launchctl list | grep proclaim-service"
echo "  • View logs:          tail -f ~/Library/Logs/proclaim-service/*.log"
echo "  • Stop service:       launchctl stop $SERVICE_LABEL"
echo "  • Start service:      launchctl start $SERVICE_LABEL"
echo "  • Update now:         launchctl stop $SERVICE_LABEL   # restart = update"
echo "  • Promote a release:  git push origin main:$UPDATE_BRANCH   (not after Thursday)"
echo "  • Uninstall:          bash install_proclaim_service.sh --uninstall"
echo ""
echo "More info: See PROCLAIM_SERVICE_SETUP.md"
