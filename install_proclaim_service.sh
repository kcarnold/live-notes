#!/bin/bash
# Install proclaim_service as a macOS LaunchAgent
# Usage: bash install_proclaim_service.sh [--uninstall]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_TEMPLATE="$SCRIPT_DIR/org.kenarnold.proclaim-service.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/org.kenarnold.proclaim-service.plist"
SERVICE_SCRIPT="$SCRIPT_DIR/proclaim_service.py"
SERVICE_LABEL="org.kenarnold.proclaim-service"

# Get current user and paths
CURRENT_USER="$(whoami)"
LOG_DIR="$HOME/Library/Logs/proclaim-service"
UV_PATH="$(which uv)"

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

generate_plist() {
    # Generate plist from template with variable substitution
    sed "s|{{SERVICE_SCRIPT}}|$SERVICE_SCRIPT|g" "$PLIST_TEMPLATE" | \
    sed "s|{{REPO_PATH}}|$SCRIPT_DIR|g" | \
    sed "s|{{LOG_DIR}}|$LOG_DIR|g" | \
    sed "s|{{USERNAME}}|$CURRENT_USER|g" | \
    sed "s|{{UV_PATH}}|$UV_PATH|g"
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

# Check for --uninstall flag
if [ "$1" = "--uninstall" ]; then
    uninstall
fi

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

if [ -z "$UV_PATH" ]; then
    log_error "uv not found in PATH. Install uv first: https://docs.astral.sh/uv/"
    exit 1
fi

# Create LaunchAgents directory if needed
mkdir -p "$HOME/Library/LaunchAgents"
log_info "LaunchAgents directory exists"

# Create log directory
mkdir -p "$LOG_DIR"
log_info "Log directory created at $LOG_DIR"

# Generate and install plist from template
generate_plist > "$PLIST_DEST"
log_info "Plist generated and installed to $PLIST_DEST"
log_info "  User: $CURRENT_USER"
log_info "  Repo: $SCRIPT_DIR"
log_info "  Logs: $LOG_DIR"
log_info "  uv:   $UV_PATH"

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
echo "  • Uninstall:          bash install_proclaim_service.sh --uninstall"
echo ""
echo "More info: See PROCLAIM_SERVICE_SETUP.md"
