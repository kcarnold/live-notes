"""The runtime: connects a SlideFeed to the Yjs consumers and manages the session lifecycle.

``SlideSyncRuntime`` is source-agnostic — it knows nothing about Proclaim. It owns the Yjs
document lifecycle, the Y-Sweet connection (lazy connect, reconnect with backoff, off-air
disconnect, keepalive health ping), and the per-cycle fan-out: one ``feed.poll()`` →
``publisher.apply`` (inline, one transaction) plus ``bus.publish`` to wake the background
translator.

What it no longer owns is *which doc* (issue #111). It used to compute that from the on-air
show's date, with a midnight-rollover rule bolted on — handling a day change that never
happens mid-service while missing the one that easily does, an older deck being opened
first. Now it proposes what it sees to the server before each session and connects to
whatever it is told, once, at the point of connecting.

Because ``feed.poll()`` never raises on a source problem, the only exceptions the reconnect
loop handles are Y-Sweet/connection failures — a cleaner error boundary than the old
monolith, where a Proclaim hiccup and a websocket drop flowed through the same handler.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional

import anyio
import httpx
from httpx_ws import HTTPXWSException, aconnect_ws
from pycrdt import Doc, Provider
from pycrdt.websocket.websocket import HttpxWebsocket

from session_client import ServerSessionResolver, SessionAnswer, SessionResolver
from slide_feed import SessionInfo, SlideFeed, SnapshotBus
from slide_translator import SlideTranslator
from write_key import write_key_headers
from yjs_publisher import YjsSlidePublisher

logger = logging.getLogger(__name__)


@dataclass
class RuntimeTiming:
    """Connection/lifecycle timing (the source's own cadences live on the feed/translator)."""

    poll_interval: float = 0.5              # on-air poll cadence
    poll_interval_off_air: float = 10.0     # off-air poll cadence
    off_air_disconnect_after: float = 60.0  # grace before dropping the connection
    reconnect_backoff_initial: float = 1.0
    reconnect_backoff_max: float = 30.0
    ws_ping_interval: float = 15.0          # keepalive + silent-drop health ping
    ysweet_token_timeout: float = 30.0


class SlideSyncRuntime:
    def __init__(
        self,
        feed: SlideFeed,
        publisher: YjsSlidePublisher,
        translator: SlideTranslator,
        ysweet_url: str,
        doc_id: Optional[str] = None,
        timing: Optional[RuntimeTiming] = None,
        report_exception: Optional[Callable[[Exception], None]] = None,
        on_session_start: Optional[Callable[[Doc, str], None]] = None,
        write_key: Optional[str] = None,
        resolver: Optional[SessionResolver] = None,
    ):
        self.feed = feed
        self.publisher = publisher
        self.translator = translator
        self.ysweet_url = ysweet_url
        # Shared key identifying this device to the server when asking for a *full*
        # (writable) Y-Sweet token. Optional: while the server runs in observe mode a
        # keyless request is recorded and still served.
        self.write_key = write_key
        self.timing = timing or RuntimeTiming()
        self._report_exception = report_exception or (lambda _e: None)
        # Called with the freshly connected Doc and the doc id at the start of every
        # session — the seam the entrypoint uses to announce itself into the shared
        # `status` map (#73). Per-session, not per-process: a doc change makes a new Doc
        # that needs its own announcement. The id is passed because the announcement says
        # which doc this service is writing to, which is the whole point of #111.
        self._on_session_start = on_session_start or (lambda _doc, _doc_id: None)

        # An explicit doc id is an override and is never resolved away: it is how the
        # replay harness targets a throwaway doc, and the escape hatch when the server's
        # answer is wrong. Otherwise the server names the doc, and until it has, we have
        # no doc id at all — which is the honest state and the one the old code lied about.
        self.override_doc_id = doc_id
        self.doc_id: Optional[str] = doc_id
        self.resolver: SessionResolver = resolver or ServerSessionResolver(
            ysweet_url, write_key=write_key
        )

        self.ydoc: Doc = Doc()
        self.publisher.bind(self.ydoc)
        self.translator.bind(self.ydoc, self.doc_id)

    # -- doc id ----------------------------------------------------------------

    async def _resolve_doc_for_session(self, session: Optional[SessionInfo]) -> None:
        """Ask the server which doc this session belongs to, and point at its answer.

        Called once per session, immediately before connecting — the only moment the doc
        can change, and the moment where being wrong is cheapest to notice. Recreates the
        Doc when the id changes so a new session never inherits the last one's slides.

        Under an explicit doc_id override this is a no-op: an operator (or the replay
        harness) who named a doc outranks the server, same as ``?doc=`` in a browser.

        Raises on an unreachable server rather than falling back to a guess. The caller's
        reconnect loop handles that, and it is the correct outcome: the server that can't
        answer this is the server that issues the token needed to write anything at all.
        """
        if self.override_doc_id is not None:
            return

        answer: SessionAnswer = await self.resolver.resolve(session)
        show_date = session.session_date if session else None
        if not answer.followed_us:
            # The interesting line, and the one whose absence made #111 invisible: we
            # proposed something and were told otherwise. Log the disagreement, not the
            # proposal.
            logger.info(
                f"Proposed {show_date or 'no date'}; server says {answer.doc_id} "
                f"({answer.source}, proposal {answer.outcome})"
            )
        if answer.doc_id != self.doc_id:
            logger.info(f"Session doc: {self.doc_id or 'none'} → {answer.doc_id}")
            self.doc_id = answer.doc_id
            self._recreate_doc()

    def _recreate_doc(self) -> None:
        """Start a fresh Y.Doc so a new session doesn't inherit the last one's slides.

        The single join point for a doc change: rebind both consumers to the new Doc and
        drop the feed's source-side caches, so nothing leaks between sessions.
        """
        self.ydoc = Doc()
        self.publisher.bind(self.ydoc)
        self.translator.bind(self.ydoc, self.doc_id)
        self.feed.reset()
        logger.info(f"Recreated Yjs document for {self.doc_id}")

    # -- connection ------------------------------------------------------------

    async def get_ysweet_token(self) -> dict:
        """Get a Y-Sweet token for the document (bounded timeout -> fail into backoff)."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.ysweet_url}/api/ys-auth",
                json={"docId": self.doc_id, "isEditor": True},
                headers=write_key_headers(self.write_key),
                timeout=self.timing.ysweet_token_timeout,
            )
            response.raise_for_status()
            return response.json()

    async def run(self) -> None:
        """Main loop: wait for on air, connect, sync, reconnect on failure."""
        # Deliberately does NOT name a doc. #111's first symptom was this line announcing
        # a doc the service then didn't use; the doc is logged when it is actually resolved.
        if self.override_doc_id:
            logger.info(f"Starting slide sync, doc overridden to: {self.override_doc_id}")
        else:
            logger.info("Starting slide sync; the server names the doc when a show goes on air")
        logger.info(f"Y-Sweet URL: {self.ysweet_url}")

        backoff = self.timing.reconnect_backoff_initial
        while True:
            try:
                session = await self._wait_until_on_air()
                await self._resolve_doc_for_session(session)
                await self._run_session()
                backoff = self.timing.reconnect_backoff_initial
            except (HTTPXWSException, httpx.HTTPError, OSError) as e:
                logger.warning(
                    f"Y-Sweet connection problem ({type(e).__name__}: {e}); "
                    f"reconnecting in {backoff:.0f}s"
                )
                await anyio.sleep(backoff)
                backoff = min(backoff * 2, self.timing.reconnect_backoff_max)
            except Exception as e:
                logger.error(f"Unexpected error in service loop: {e}", exc_info=True)
                self._report_exception(e)
                await anyio.sleep(backoff)
                backoff = min(backoff * 2, self.timing.reconnect_backoff_max)

    async def _wait_until_on_air(self) -> Optional[SessionInfo]:
        """Poll the feed until it reports on air, holding NO Y-Sweet connection.

        Returns the on-air session so the caller can resolve the doc before connecting.
        """
        announced = False
        while True:
            snap = await self.feed.poll()
            if snap.on_air:
                logger.info("Source is on air - connecting to Y-Sweet")
                return snap.session
            if not announced:
                logger.info("Waiting for source to go on air (no Y-Sweet connection held)")
                announced = True
            await anyio.sleep(self.timing.poll_interval_off_air)

    async def _run_session(self) -> None:
        """Open a Y-Sweet connection and sync until off air.

        Returns normally on an expected end (sustained off air); raises on a connection
        problem so ``run`` reconnects with backoff.
        """
        assert self.doc_id is not None, "doc must be resolved before connecting"
        token_data = await self.get_ysweet_token()
        ws_url = token_data['url'] + '/' + self.doc_id
        logger.info(f"Connecting to Y-Sweet: {ws_url}")

        async with (
            aconnect_ws(ws_url, keepalive_ping_interval_seconds=self.timing.ws_ping_interval) as websocket,
            Provider(self.ydoc, HttpxWebsocket(websocket, self.doc_id)),
        ):
            logger.info("Connected to Y-Sweet")
            # Force a full re-push of current state onto the freshly connected server.
            self.publisher.bind(self.ydoc)
            self._on_session_start(self.ydoc, self.doc_id)

            bus = SnapshotBus()
            async with anyio.create_task_group() as session_tg:
                session_tg.start_soon(self.translator.run, bus)
                await self._poll_until_session_end(websocket, bus)
                session_tg.cancel_scope.cancel()

    async def _poll_until_session_end(self, websocket: Any, bus: SnapshotBus) -> None:
        """Poll the feed and fan snapshots out until the session should end.

        Returns on sustained off air; raises on a websocket problem. Going off air is now
        the only way a session ends, which is also the only moment the doc is re-resolved
        — the server's answer is never swapped in underneath a live connection.
        """
        off_air_since: Optional[float] = None
        last_ping = anyio.current_time()
        while True:
            snap = await self.feed.poll()
            if not snap.on_air:
                now = anyio.current_time()
                if off_air_since is None:
                    off_air_since = now
                    logger.info("Off air - will disconnect from Y-Sweet if it persists")
                elif now - off_air_since >= self.timing.off_air_disconnect_after:
                    logger.info("Off air long enough - disconnecting from Y-Sweet")
                    return
                await anyio.sleep(self.timing.poll_interval_off_air)
                continue

            off_air_since = None
            self.publisher.apply(snap)   # inline, one transaction (fixes #67)
            bus.publish(snap)            # wake the translator

            # Health check (throttled). The keepalive task detects a silent drop but reports
            # it only through recv() (which the Provider swallows), so we ping here too: once
            # the socket is closed this raises into our scope and reaches run()'s reconnect.
            now = anyio.current_time()
            if now - last_ping >= self.timing.ws_ping_interval:
                await websocket.ping()
                last_ping = now
            await anyio.sleep(self.timing.poll_interval)
