"""Asking the server which doc to write to (issue #111).

The service used to *decide* this itself: it read the on-air show's ``DateGiven``, pointed
itself at that day's doc, and logged the doc it had intended to use at startup. One Sunday
last week's deck was opened first, the service silently retargeted itself at last week's
doc, and every log it printed said otherwise. The disagreement was visible only in the
server's auth log.

So the service no longer decides. It reports what it sees on air and is *told* which doc to
use — and it logs the answer it got, including when that differs from what it proposed.
The server-side policy lives in ``sessionRegistry.ts``; this module is only the wire.

There is no local fallback here on purpose. The same server issues the Y-Sweet token this
service needs to write anything at all, so a proposal that fails is a server that is
unreachable, which the runtime already handles: it flows into the reconnect backoff and is
retried. Guessing a doc id in that moment is the original bug.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Optional, Protocol

import httpx

from slide_feed import SessionInfo
from write_key import write_key_headers

logger = logging.getLogger(__name__)


class SessionResolutionError(RuntimeError):
    """The server answered, but not with a usable session.

    Its own class so it can join the runtime's reconnect-backoff bucket. Without it a
    proxy returning an HTML error page with a 200 — or any answer missing ``docId`` —
    escapes the reconnect loop as a bare ``ValueError``/``KeyError`` and takes the whole
    service down until someone notices. The launch wrapper's invariant is "runs last
    version", never "doesn't run"; this keeps that true for the doc lookup too.
    """


@dataclass(frozen=True)
class SessionAnswer:
    """What the server said. ``outcome`` explains *why* this doc, not just which."""

    doc_id: str
    #: 'pin' | 'proposal' | 'date' — where the current doc came from.
    source: str
    #: 'accepted' | 'pinned' | 'stale' | 'no-date' — what became of our proposal.
    outcome: str

    @property
    def followed_us(self) -> bool:
        return self.outcome == 'accepted'


class SessionResolver(Protocol):
    """The seam the runtime resolves its doc through (a fake stands in for tests)."""

    async def resolve(self, session: Optional[SessionInfo]) -> SessionAnswer: ...


class ServerSessionResolver:
    """Proposes what's on air to ``POST /api/session/propose`` and takes the answer."""

    def __init__(
        self,
        ysweet_url: str,
        write_key: Optional[str] = None,
        set_by: str = 'proclaim-service',
        timeout: float = 30.0,
    ):
        self.ysweet_url = ysweet_url
        self.write_key = write_key
        self.set_by = set_by
        self.timeout = timeout

    async def resolve(self, session: Optional[SessionInfo]) -> SessionAnswer:
        show_date: Optional[date] = session.session_date if session else None
        payload = {
            'sessionDate': show_date.isoformat() if show_date else None,
            'setBy': self.set_by,
        }
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.ysweet_url}/api/session/propose",
                json=payload,
                headers=write_key_headers(self.write_key),
                timeout=self.timeout,
            )
            response.raise_for_status()
            try:
                data = response.json()
            except ValueError as e:
                raise SessionResolutionError(
                    f"{self.ysweet_url} answered /api/session/propose with something "
                    f"that isn't JSON"
                ) from e
        doc_id = data.get('docId') if isinstance(data, dict) else None
        if not isinstance(doc_id, str) or not doc_id:
            raise SessionResolutionError(f"No docId in the answer from {self.ysweet_url}")
        return SessionAnswer(
            doc_id=doc_id,
            source=data.get('source', 'unknown'),
            outcome=data.get('outcome', 'unknown'),
        )
