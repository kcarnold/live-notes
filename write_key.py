"""Presenting this service's shared write key to the live-notes server.

The server authorizes *devices* rather than users (see ``writeAuth.ts``): a short list of
shared keys, one of which belongs to this Proclaim machine. The key is read from
``PROCLAIM_WRITE_KEY`` — set by the installer into the LaunchAgent plist — and attached to
the two privileged calls this service makes: asking for a full Y-Sweet token, and asking
the server to translate an item.

Deliberately tolerant of an unset key: during the rollout the server runs in ``observe``
mode, where a missing key is recorded and allowed, and a service that refused to start
without one would be a worse outage than the problem it guards against.
"""

from __future__ import annotations

import os
from typing import Dict, Optional

#: Must match WRITE_KEY_HEADER in writeAuth.ts.
WRITE_KEY_HEADER = "X-Write-Key"

ENV_VAR = "PROCLAIM_WRITE_KEY"


def get_write_key(env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """The configured write key, or None when unset/blank."""
    raw = (env if env is not None else os.environ).get(ENV_VAR, "")
    return raw.strip() or None


def write_key_headers(write_key: Optional[str]) -> Dict[str, str]:
    """Headers presenting ``write_key``, or an empty dict when there is none."""
    if not write_key or not write_key.strip():
        return {}
    return {WRITE_KEY_HEADER: write_key.strip()}
