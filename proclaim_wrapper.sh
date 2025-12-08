#!/bin/bash
# Wrapper script for proclaim_service.py
# Logs output and runs the service with appropriate environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="$SCRIPT_DIR/proclaim_service.py"

# Get the directory for logging
LOG_DIR="$HOME/Library/Logs/proclaim-service"
mkdir -p "$LOG_DIR"

# Run the Python service
# The service automatically detects date changes and exits cleanly for restart
exec uv run "$PYTHON_SCRIPT" \
    >> "$LOG_DIR/proclaim_service.log" 2>&1
