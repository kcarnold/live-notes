"""The runtime: connects a SlideFeed to the Yjs consumers and manages the session lifecycle.

``SlideSyncRuntime`` is source-agnostic — it knows nothing about Proclaim. It owns the Yjs
document lifecycle (date-based doc id, midnight rollover), the Y-Sweet connection (lazy
connect, reconnect with backoff, off-air disconnect, keepalive health ping), and the
per-cycle fan-out: one ``feed.poll()`` → ``publisher.apply`` (inline, one transaction) plus
``bus.publish`` to wake the background translator.

Because ``feed.poll()`` never raises on a source problem, the only exceptions the reconnect
loop handles are Y-Sweet/connection failures — a cleaner error boundary than the old
monolith, where a Proclaim hiccup and a websocket drop flowed through the same handler.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Callable, Optional

import anyio
import httpx
from httpx_ws import HTTPXWSException, aconnect_ws
from pycrdt import Doc, Provider
from pycrdt.websocket.websocket import HttpxWebsocket

from slide_feed import SessionInfo, SlideFeed, SnapshotBus
from slide_translator import SlideTranslator
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
    ):
        self.feed = feed
        self.publisher = publisher
        self.translator = translator
        self.ysweet_url = ysweet_url
        self.timing = timing or RuntimeTiming()
        self._report_exception = report_exception or (lambda _e: None)

        if doc_id is None:
            self.use_date_based_doc_id = True
            self.doc_id = self._get_date_based_doc_id()
            self.current_doc_date: Optional[date] = date.today()
        else:
            self.use_date_based_doc_id = False
            self.doc_id = doc_id
            self.current_doc_date = None

        # True when the doc date came from the on-air show (authoritative, no midnight roll).
        self.doc_date_from_show = False

        self.ydoc = Doc()
        self.publisher.bind(self.ydoc)
        self.translator.bind(self.ydoc)

    # -- doc id / rollover -----------------------------------------------------

    @staticmethod
    def _get_date_based_doc_id(d: Optional[date] = None) -> str:
        return f'doc-{(d or date.today()).isoformat()}'

    def _resolve_doc_for_session(self, session: Optional[SessionInfo]) -> None:
        """Point the date-based doc id at the on-air show's date before connecting.

        Uses the session's date when known, otherwise wall-clock today. Recreates the Doc
        when the id changes. No-op under an explicit doc_id override.
        """
        if not self.use_date_based_doc_id:
            return

        show_date = session.session_date if session else None
        new_date = show_date if show_date is not None else date.today()
        self.doc_date_from_show = show_date is not None
        new_doc_id = self._get_date_based_doc_id(new_date)

        if new_doc_id != self.doc_id:
            source = "show date" if show_date is not None else "today"
            logger.info(f"Resolved doc from {source}: {self.doc_id} → {new_doc_id}")
            self.doc_id = new_doc_id
            self._recreate_doc()
        self.current_doc_date = new_date

    def _check_doc_id_change(self) -> bool:
        """Advance the date-based doc id if wall-clock day changed. Returns True if it did."""
        if not self.use_date_based_doc_id or self.doc_date_from_show:
            return False
        today = date.today()
        if today != self.current_doc_date:
            old_doc_id = self.doc_id
            self.doc_id = self._get_date_based_doc_id()
            self.current_doc_date = today
            logger.info(f"Date changed: {old_doc_id} → {self.doc_id}")
            return True
        return False

    def _date_rolled_over(self) -> bool:
        """Side-effect-free check of whether the date-based doc is now stale (used mid-session)."""
        return (
            self.use_date_based_doc_id
            and not self.doc_date_from_show
            and date.today() != self.current_doc_date
        )

    def _maybe_roll_doc_date(self) -> None:
        """If the date-based doc id changed, advance to it with a fresh Doc (disconnected only)."""
        if self._check_doc_id_change():
            self._recreate_doc()

    def _recreate_doc(self) -> None:
        """Start a fresh Y.Doc so a new day doesn't inherit yesterday's slides.

        The single join point for a doc rollover: rebind both consumers to the new Doc and
        drop the feed's source-side caches, so nothing leaks across days.
        """
        self.ydoc = Doc()
        self.publisher.bind(self.ydoc)
        self.translator.bind(self.ydoc)
        self.feed.reset()
        logger.info(f"Recreated Yjs document for {self.doc_id}")

    # -- connection ------------------------------------------------------------

    async def get_ysweet_token(self) -> dict:
        """Get a Y-Sweet token for the document (bounded timeout -> fail into backoff)."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.ysweet_url}/api/ys-auth",
                json={"docId": self.doc_id, "isEditor": True},
                timeout=self.timing.ysweet_token_timeout,
            )
            response.raise_for_status()
            return response.json()

    async def run(self) -> None:
        """Main loop: wait for on air, connect, sync, reconnect on failure."""
        logger.info(f"Starting slide sync for doc: {self.doc_id}")
        logger.info(f"Y-Sweet URL: {self.ysweet_url}")

        backoff = self.timing.reconnect_backoff_initial
        while True:
            try:
                session = await self._wait_until_on_air()
                self._resolve_doc_for_session(session)
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
        Rolls the date-based doc while waiting (safe: nothing is connected).
        """
        announced = False
        while True:
            self._maybe_roll_doc_date()
            snap = await self.feed.poll()
            if snap.on_air:
                logger.info("Source is on air - connecting to Y-Sweet")
                return snap.session
            if not announced:
                logger.info("Waiting for source to go on air (no Y-Sweet connection held)")
                announced = True
            await anyio.sleep(self.timing.poll_interval_off_air)

    async def _run_session(self) -> None:
        """Open a Y-Sweet connection and sync until off air, disconnect, or date roll.

        Returns normally on an expected end (sustained off air / date roll); raises on a
        connection problem so ``run`` reconnects with backoff.
        """
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

            bus = SnapshotBus()
            async with anyio.create_task_group() as session_tg:
                session_tg.start_soon(self.translator.run, bus)
                await self._poll_until_session_end(websocket, bus)
                session_tg.cancel_scope.cancel()

    async def _poll_until_session_end(self, websocket, bus: SnapshotBus) -> None:
        """Poll the feed and fan snapshots out until the session should end.

        Returns on sustained off air or a date rollover; raises on a websocket problem.
        """
        off_air_since: Optional[float] = None
        last_ping = anyio.current_time()
        while True:
            # Don't swap the Doc while connected; end the session and let run() roll the date.
            if self._date_rolled_over():
                logger.info("Date changed - ending session to roll the document")
                return

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
