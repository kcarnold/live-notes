#!/usr/bin/env python3
"""
Proclaim Service - Syncs Proclaim presentation data to Yjs

This service:
1. Polls Proclaim API for current presentation and slide status
2. Parses presentation content from the Proclaim database
3. Updates Yjs shared state with presentation data (via Y-Sweet)
4. Watches for changes and updates clients in real-time

Protocol documentation:

- Proclaim API: Faithlife provides a local API for Proclaim on port 52195. Key endpoints:

    - GET /onair/session: Returns a session ID for authentication
    - GET /presentations/onair: Returns current on-air presentation data (requires OnAirSessionId header)
        - The most important thing this gives us is the `serviceItems` array, which looks like:
    {
      "id": "39510e4d-b345-4f63-abf1-8c8e6bdff9b3",
      "title": "Call to Worship",
      "notes": "",
      "kind": "Content",
      "slides": [
        {
          "localRevision": 639060998184592130,
          "index": 0
        },
        {
          "localRevision": 639060998184592130,
          "index": 1
        },
        {
          "localRevision": 639060998184592130,
          "index": 2
        }
      ]
    },

    - GET /onair/statusChanged: Returns current status of on-air presentation (requires OnAirSessionId header)
    - It seems there's also a /presentations/onair/items/{serviceItemId}/slides/{slideIndex}/image endpoint that returns the image for a given slide, but I haven't tested it, and we don't need to use it since we can get all content from the database.
"""

import os
import json
import logging
import signal
import socket
import argparse
import anyio
from typing import Optional, Dict, Any
from pathlib import Path
from datetime import date
import httpx
from posthog import Posthog
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

from pycrdt import Doc, Map
from httpx_ws import aconnect_ws, HTTPXWSException
from pycrdt import Provider
from pycrdt.websocket.websocket import HttpxWebsocket

from proclaim_lib import (
    ServiceItemWithSlides,
    ProclaimDB,
    is_blank_item,
    parse_item_original,
    service_item_signatures,
    slide_translation_key,
    slides_hash,
    get_translation_screen_idx,
    existing_translation_text,
)

# Configure logging (default level, can be overridden by --debug flag)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('proclaim-service')

# Suppress INFO logging from httpx
logging.getLogger('httpx').setLevel(logging.WARNING)

# Configuration
PROCLAIM_BASE_URL = os.getenv('PROCLAIM_BASE_URL', 'http://127.0.0.1:52195')
YSWEET_URL = os.getenv('YSWEET_URL', '')
assert YSWEET_URL, "YSWEET_URL must be set"
POLL_INTERVAL = float(os.getenv('PROCLAIM_POLL_INTERVAL', '0.5'))  # seconds
POLL_INTERVAL_OFF_AIR = float(os.getenv('PROCLAIM_POLL_INTERVAL_OFF_AIR', '10'))  # seconds
# How often to re-read the full on-air service order (all items + slides). Items whose
# Proclaim localRevision is unchanged are not re-parsed, so this is cheap; the interval
# just bounds how quickly a slide edited underneath us is picked up.
SERVICE_ORDER_SYNC_INTERVAL = float(os.getenv('PROCLAIM_SERVICE_ORDER_SYNC_INTERVAL', '2.0'))  # seconds
# How long the background translation worker idles when there's nothing left to translate.
# Translation runs off the poll loop so a slow translation never stalls status polling.
TRANSLATION_SCAN_INTERVAL = float(os.getenv('PROCLAIM_TRANSLATION_SCAN_INTERVAL', '1.0'))  # seconds
# Target languages to pre-translate slides into (must match the frontend's configured
# languages). The service asks the server to translate the active item into these and
# writes the reviewed-or-auto results into the per-day slideTranslations map.
SLIDE_TRANSLATION_LANGUAGES = [
    lang.strip()
    for lang in os.getenv('SLIDE_TRANSLATION_LANGUAGES', 'French,Haitian Creole,Spanish').split(',')
    if lang.strip()
]

# Connection robustness tuning.
# We don't hold a Y-Sweet connection while off air; when we do connect (and if the
# connection drops), we retry with exponential backoff so a slow/cold Y-Sweet server
# - e.g. one that scaled to zero - doesn't permanently kill the service.
RECONNECT_BACKOFF_INITIAL = float(os.getenv('PROCLAIM_RECONNECT_BACKOFF_INITIAL', '1.0'))  # seconds
RECONNECT_BACKOFF_MAX = float(os.getenv('PROCLAIM_RECONNECT_BACKOFF_MAX', '30.0'))  # seconds
# How long Proclaim must stay off air before we drop the Y-Sweet connection. A short
# grace period avoids churn when switching between presentations.
OFF_AIR_DISCONNECT_AFTER = float(os.getenv('PROCLAIM_OFF_AIR_DISCONNECT_AFTER', '60'))  # seconds
# Keepalive ping interval for the Y-Sweet websocket. We also actively ping each poll to
# detect a silently-dropped connection (httpx_ws swallows the disconnect on recv).
WS_PING_INTERVAL = float(os.getenv('PROCLAIM_WS_PING_INTERVAL', '15'))  # seconds
# Timeout for fetching a Y-Sweet token; generous enough to let a cold server wake up,
# but bounded so we fall back to retry-with-backoff instead of hanging forever.
YSWEET_TOKEN_TIMEOUT = float(os.getenv('PROCLAIM_YSWEET_TOKEN_TIMEOUT', '30'))  # seconds

DUMP_PRESENTATION_JSON = os.getenv('DUMP_PRESENTATION_JSON', 'false').lower() == 'true'

_POSTHOG_KEY = os.getenv('POSTHOG_API_KEY', '')
_POSTHOG_HOST = os.getenv('POSTHOG_HOST', 'https://us.i.posthog.com')
DISTINCT_ID = f'proclaim-service@{socket.gethostname()}'

if _POSTHOG_KEY:
    ph = Posthog(_POSTHOG_KEY, host=_POSTHOG_HOST, enable_exception_autocapture=True)

    _logger_provider = LoggerProvider()
    set_logger_provider(_logger_provider)
    _logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(
            OTLPLogExporter(
                endpoint=f"{_POSTHOG_HOST}/i/v1/logs",
                headers={"Authorization": f"Bearer {_POSTHOG_KEY}"}
            )
        )
    )
    logging.getLogger().addHandler(LoggingHandler(logger_provider=_logger_provider))
else:
    ph = None


class ProclaimClient:
    """Client for Proclaim API (HTTP endpoints)"""

    def __init__(self, base_url: str = PROCLAIM_BASE_URL):
        self.base_url = base_url
        self.session_id: Optional[str] = None
        self.http_client = httpx.AsyncClient()

    async def get_session_id(self, timeout: float = 2.0) -> str:
        """Request /onair/session and return the session id."""
        url = f"{self.base_url}/onair/session"
        r = await self.http_client.get(url, timeout=timeout)
        r.raise_for_status()
        self.session_id = r.content.decode('utf-8-sig')
        return self.session_id

    async def get_onair_presentation(self, timeout: float = 5.0) -> Dict[str, Any]:
        """Fetch /presentations/onair with the OnAirSessionId header."""
        await self.get_session_id()
        assert self.session_id is not None

        url = f"{self.base_url}/presentations/onair"
        headers = {'OnAirSessionId': self.session_id}
        r = await self.http_client.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.json()

    async def get_status(self, timeout: float = 5.0) -> Dict[str, Any]:
        """Fetch /onair/statusChanged with the OnAirSessionId header."""
        await self.get_session_id()
        assert self.session_id is not None

        url = f"{self.base_url}/onair/statusChanged"
        headers = {'OnAirSessionId': self.session_id}
        r = await self.http_client.get(url, headers=headers, timeout=timeout)
        # 404 just means that the presentation is off air, so return empty status instead of raising
        if r.status_code == 404:
            logging.info("Presentation is currently off air")
            return {}
        r.raise_for_status()
        status = r.json()
        logger.debug(f"Proclaim status: {status}")
        return status


class ProclaimYjsService:
    """Service that syncs Proclaim data to Yjs via Y-Sweet"""

    def __init__(self, ysweet_url: str, doc_id: Optional[str] = None):
        self.proclaim_client = ProclaimClient()
        self.db = ProclaimDB()
        self.ysweet_url = ysweet_url

        # If no doc_id provided, use date-based doc_id
        if doc_id is None:
            self.use_date_based_doc_id = True
            self.doc_id = self._get_date_based_doc_id()
            self.current_doc_date = date.today()
        else:
            self.use_date_based_doc_id = False
            self.doc_id = doc_id
            self.current_doc_date = None

        # Whether current_doc_date came from the on-air show's DateGiven (authoritative,
        # set per session) rather than wall-clock today. When the date is anchored to a
        # show we don't roll the doc at midnight - the show's date is the source of truth,
        # so a service started the night before for a future-dated show targets the right
        # doc. Only the wall-clock fallback rolls over at midnight.
        self.doc_date_from_show = False

        # Yjs state
        self.ydoc: Doc = Doc()
        self.presentations_map = self.ydoc.get('proclaimPresentations', type=Map)
        self.status_map = self.ydoc.get('proclaimStatus', type=Map)
        # Full service order, stored as a plain list value under a single key (the
        # service is the sole writer and replaces it wholesale, so no Y.Array needed).
        self.service_order_map = self.ydoc.get('proclaimServiceOrder', type=Map)
        # Content-addressed translations for the current service (reviewed entries from
        # the server library + auto fallbacks), keyed `${language}:${normalized text}`.
        self.slide_translations_map = self.ydoc.get('slideTranslations', type=Map)

        # State tracking
        self.last_item_id: Optional[str] = None
        self.last_slide_index: Optional[int] = None
        self.current_item_slides: Optional[ServiceItemWithSlides] = None
        # Parsed original-language slides per item, and the localRevision signature we
        # last parsed them at, so we only re-read the DB when an item actually changes.
        self.items_by_id: Dict[str, ServiceItemWithSlides] = {}
        self.item_revisions: Dict[str, str] = {}
        # Slides-content hash we last attempted to translate each item at. Lets the worker
        # translate each content version once (and re-attempt when slides change underneath
        # us) without re-hitting the server on every scan.
        self.translated_hashes: Dict[str, str] = {}
        # Current presentation id (from status) and the translation-screen index we computed
        # for it, so the worker can pull each item's existing translation as grounding without
        # recomputing the screen index every time.
        self.current_presentation_id: Optional[str] = None
        self._translation_screen_pres_id: Optional[str] = None
        self._translation_screen_idx: Optional[int] = None

    @staticmethod
    def _get_date_based_doc_id(d: Optional[date] = None) -> str:
        """Generate doc ID based on a date (defaults to today)."""
        return f'doc-{(d or date.today()).isoformat()}'

    @staticmethod
    def _parse_date_given(raw: Any) -> Optional[date]:
        """Parse a Proclaim ``DateGiven`` value (e.g. ``"2025-03-02"``) into a date.

        Returns None when the value is missing or not a parseable ISO date, so the
        caller can fall back to wall-clock today.
        """
        if not isinstance(raw, str):
            return None
        # DateGiven is a date string but tolerate an accidental time component.
        token = raw.strip().replace('T', ' ').split(' ')[0]
        try:
            return date.fromisoformat(token)
        except ValueError:
            return None

    def _read_show_date(self, presentation_id: Optional[str]) -> Optional[date]:
        """Read the on-air presentation's DateGiven as a date, or None if unavailable.

        Tolerates a missing row (DB trailing the live API) or any DB/parse problem by
        returning None; the caller then falls back to today's date.
        """
        if not presentation_id:
            return None
        try:
            pres = self.db.get_presentation(presentation_id)
        except Exception as e:
            logger.warning(f"Could not read date for presentation {presentation_id}: {e}")
            return None
        if not pres:
            return None
        return self._parse_date_given(pres.get('date_given'))

    def _resolve_doc_for_session(self, presentation_id: Optional[str]) -> None:
        """Point the (date-based) doc id at the on-air show's date before connecting.

        Uses the presentation's ``DateGiven`` when available, otherwise wall-clock today.
        Recreates the Doc when the id changes so a new target doesn't inherit the prior
        session's slides. No-op when an explicit doc_id override is in effect.
        """
        if not self.use_date_based_doc_id:
            return

        show_date = self._read_show_date(presentation_id)
        new_date = show_date if show_date is not None else date.today()
        self.doc_date_from_show = show_date is not None
        new_doc_id = self._get_date_based_doc_id(new_date)

        if new_doc_id != self.doc_id:
            source = "show DateGiven" if show_date is not None else "today"
            logger.info(f"Resolved doc from {source}: {self.doc_id} → {new_doc_id}")
            self.doc_id = new_doc_id
            self._recreate_doc()
        self.current_doc_date = new_date

    def _check_doc_id_change(self) -> bool:
        """Check if date-based doc ID has changed. Returns True if changed."""
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
        """Cheap, side-effect-free check of whether the date-based doc is now stale.

        Used inside a live session (where we must not swap the Doc out from under an
        active Provider) to decide we should end the session and roll over.
        """
        return (
            self.use_date_based_doc_id
            and not self.doc_date_from_show
            and date.today() != self.current_doc_date
        )

    def _recreate_doc(self) -> None:
        """Start a fresh Y.Doc so a new day's document doesn't inherit yesterday's slides."""
        self.ydoc = Doc()
        self.presentations_map = self.ydoc.get('proclaimPresentations', type=Map)
        self.status_map = self.ydoc.get('proclaimStatus', type=Map)
        self.service_order_map = self.ydoc.get('proclaimServiceOrder', type=Map)
        self.slide_translations_map = self.ydoc.get('slideTranslations', type=Map)
        self.last_item_id = None
        self.last_slide_index = None
        self.current_item_slides = None
        self.items_by_id = {}
        self.item_revisions = {}
        self.translated_hashes = {}
        self.current_presentation_id = None
        self._translation_screen_pres_id = None
        self._translation_screen_idx = None
        logger.info(f"Recreated Yjs document for {self.doc_id}")

    def _maybe_roll_doc_date(self) -> None:
        """If the date-based doc id changed, advance to it with a fresh Doc.

        Only safe to call while NOT connected (it replaces self.ydoc).
        """
        if self._check_doc_id_change():
            self._recreate_doc()

    async def get_ysweet_token(self) -> Dict[str, Any]:
        """Get a Y-Sweet token for the document.

        Uses a bounded timeout so a cold/slow Y-Sweet server fails fast into the
        reconnect-with-backoff loop rather than hanging the service indefinitely.
        """
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.ysweet_url}/api/ys-auth",
                json={"docId": self.doc_id, "isEditor": True},
                timeout=YSWEET_TOKEN_TIMEOUT,
            )
            response.raise_for_status()
            return response.json()


    def update_presentation_item_in_yjs(self, presentation_data: ServiceItemWithSlides):
        """Store full presentation data in Yjs"""
        item_id = presentation_data.itemId

        with self.ydoc.transaction():
            self.presentations_map[item_id] = {
                'title': presentation_data.title,
                'itemId': item_id,
                'slides': presentation_data.slides
            }

        logger.info(f"Stored service item {item_id} ({presentation_data.title}) with {len(presentation_data.slides)} slides")

    def update_status_in_yjs(self, item_id: str, slide_index: int):
        """Update current status in Yjs"""
        # Clip slide index to valid range. Blank items (image slideshows, offering,
        # etc.) collapse to a single blank slide, but Proclaim keeps reporting the
        # slideshow's own advancing index as it loops — that's expected, not an
        # anomaly, so clip it quietly for those.
        if self.current_item_slides:
            item = self.current_item_slides
            blank = is_blank_item(item.itemKind, item.title)
            clip_log = logger.debug if blank else logger.warning
            max_index = len(item.slides) - 1
            if slide_index > max_index:
                clip_log(f"Slide index {slide_index} out of range for item {item_id}, clipping to {max_index}")
                slide_index = max_index
            if slide_index < 0:
                clip_log(f"Slide index {slide_index} less than 0 for item {item_id}, clipping to 0")
                slide_index = 0
        with self.ydoc.transaction():
            self.status_map['itemId'] = item_id
            self.status_map['slideIndex'] = slide_index

        logger.info(f"Updated status: {item_id} slide {slide_index}")


    def _sync_service_order(self, presentation: Dict[str, Any]) -> None:
        """Push the full on-air service order (all items + original slides) into Yjs.

        For each item we compare Proclaim's per-slide ``localRevision`` signature with
        what we last parsed; only changed (or not-yet-seen) items are re-read from the
        DB. This is what keeps us in sync when slide text changes underneath us within
        the same item. A DB/parse problem for one item is logged and skipped (its
        revision is left uncached so we retry next sync) rather than dropped on the
        whole order.
        """
        signatures = service_item_signatures(presentation)
        order = [sig['id'] for sig in signatures if sig['id']]

        with self.ydoc.transaction():
            for sig in signatures:
                item_id = sig['id']
                if not item_id:
                    continue
                unchanged = (
                    self.item_revisions.get(item_id) == sig['revision']
                    and item_id in self.items_by_id
                )
                if unchanged:
                    continue

                try:
                    parsed = parse_item_original(self.db, item_id)
                except Exception as e:
                    logger.warning(f"Failed to parse item {item_id} from Proclaim DB: {e}; will retry")
                    continue
                if not parsed:
                    continue

                self.items_by_id[item_id] = parsed
                self.item_revisions[item_id] = sig['revision']
                self.presentations_map[item_id] = {
                    'title': parsed.title,
                    'itemId': item_id,
                    'slides': parsed.slides,
                    'itemKind': parsed.itemKind,
                    'slidesHash': slides_hash(parsed.slides),
                }
                logger.info(
                    f"Synced item {item_id} ({parsed.title}) with {len(parsed.slides)} original slides"
                )

            self.service_order_map['order'] = order

    def _apply_status(self, status: Dict[str, Any]) -> None:
        """Push the current item/slide pointer into Yjs (presentations come from sync)."""
        item_id = status.get('status', {}).get('itemId')
        slide_index = status.get('status', {}).get('slideIndex') or 0

        if item_id != self.last_item_id:
            logger.info(f"Item changed to {item_id}")
            self.current_item_slides = self.items_by_id.get(item_id)
            self.update_status_in_yjs(item_id, slide_index)
            self.last_item_id = item_id
            self.last_slide_index = slide_index
        elif slide_index != self.last_slide_index:
            # Blank items (image slideshows, offering, etc.) render as a single
            # blank slide, but Proclaim keeps advancing its own slide index as the
            # slideshow loops. Ignore those slide-only changes so we don't churn
            # logs and redundant Yjs writes for a view that never changes.
            item = self.current_item_slides
            if item and is_blank_item(item.itemKind, item.title):
                self.last_slide_index = slide_index
                return
            logger.info(f"Slide changed to {slide_index}")
            self.update_status_in_yjs(item_id, slide_index)
            self.last_slide_index = slide_index

    async def _fetch_status(self) -> Optional[Dict[str, Any]]:
        """Fetch current Proclaim status.

        Returns the status dict when on air, or None when off air / Proclaim is
        unreachable. Polling Proclaim is a local HTTP call and needs no Y-Sweet
        connection, so this is safe to call while disconnected. Expected
        connectivity hiccups are swallowed (returns None); they don't raise.
        """
        try:
            status = await self.proclaim_client.get_status()
            return status or None
        except httpx.ConnectError:
            logger.debug("Proclaim not reachable (not running?)")
            return None
        except httpx.HTTPError as e:
            logger.error(f"Error polling Proclaim: {e}")
            if ph: ph.capture_exception(e, distinct_id=DISTINCT_ID)
            return None

    async def _fetch_onair_presentation(self) -> Optional[Dict[str, Any]]:
        """Fetch the full on-air presentation (the service order), or None on failure.

        Like ``_fetch_status``, this is a local Proclaim call; failures are swallowed
        so a Proclaim hiccup never drops the healthy Y-Sweet connection.
        """
        try:
            return await self.proclaim_client.get_onair_presentation()
        except httpx.HTTPError as e:
            logger.warning(f"Could not fetch on-air presentation: {e}")
            return None

    async def _translate_item(
        self,
        slides: list,
        item_title: Optional[str] = None,
        item_id: Optional[str] = None,
        existing_translation: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Ask the server to translate an item's slides into all target languages.

        Returns the ``{language: [{text, status, provenance}, ...]}`` map, or None on
        failure (translation is best-effort; a failure must not drop the session).
        ``item_title`` is forwarded as a lookup cue: for a Bible reading the title is the
        citation (e.g. "Psalm 23") and is usually absent from the slide text, so it's the
        model's only hint to fetch the passage. ``item_id`` keys the agent conversation
        server-side so the review screen can pull it up by item. ``existing_translation`` is
        any translation already present in Proclaim's translation screen — passed as
        grounding the model can keep where good and correct where not (it may itself be
        machine-generated).
        """
        if not slides or not SLIDE_TRANSLATION_LANGUAGES:
            return None
        # docId names the per-day doc the server writes the agent conversation into (the
        # same doc this service is connected to).
        body: Dict[str, Any] = {
            "slides": slides,
            "languages": SLIDE_TRANSLATION_LANGUAGES,
            "docId": self.doc_id,
        }
        if item_title and item_title != "Unknown":
            body["itemTitle"] = item_title
        if item_id:
            body["itemId"] = item_id
        if existing_translation:
            body["existingTranslation"] = existing_translation
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.ysweet_url}/api/translateItem",
                    json=body,
                    timeout=3 * 60.0,
                )
                response.raise_for_status()
                return response.json().get('translations')
        except (httpx.HTTPError, ValueError) as e:
            # Timeout exceptions (ReadTimeout/ConnectTimeout/...) stringify to '', so log
            # repr(e) to preserve the exception type. Include item context so we know which
            # slide failed.
            logger.warning(
                f"Slide translation request failed for item {item_id} "
                f"({item_title!r}, {len(slides)} slides): {e!r}"
            )
            if ph:
                ph.capture_exception(
                    e,
                    distinct_id=DISTINCT_ID,
                    properties={
                        "item_id": item_id,
                        "item_title": item_title,
                        "num_slides": len(slides),
                        "languages": SLIDE_TRANSLATION_LANGUAGES,
                    },
                )
            return None

    def _store_translations(self, slides: list, translations: Dict[str, Any]) -> None:
        """Seed per-slide translation results into the slideTranslations map.

        The Yjs map is the source of truth for the live session; this service only
        *seeds* it (warms a fresh per-day doc from the library, fills in `auto`
        fallbacks). It must never clobber a `reviewed` entry — those are written live
        from the review screen and POSTed back to the library for persistence, so a
        re-derived value here would only ever downgrade a human edit. Fresh keys and
        prior `auto` entries are (re)filled.
        """
        with self.ydoc.transaction():
            for language, per_slide in translations.items():
                for slide, entry in zip(slides, per_slide):
                    if not slide.strip() or not entry:
                        continue
                    key = slide_translation_key(language, slide)
                    existing = self.slide_translations_map[key] if key in self.slide_translations_map else None
                    if existing is not None and existing.get('status') == 'reviewed':
                        continue
                    self.slide_translations_map[key] = {
                        'text': entry.get('text', ''),
                        'status': entry.get('status', 'auto'),
                        'provenance': entry.get('provenance', 'llm'),
                    }

    def _existing_translation_for(self, item_id: str) -> Optional[str]:
        """Proclaim's own translation-screen text for an item, joined, or None.

        The translation-screen index is a presentation-level property, so we compute it once
        per presentation and cache it. Best-effort: any DB/parse problem yields None (the
        item is just translated without this grounding).
        """
        presentation_id = self.current_presentation_id
        if not presentation_id:
            return None
        try:
            if self._translation_screen_pres_id != presentation_id:
                presentation = self.db.get_presentation(presentation_id)
                content = presentation.get('content') if presentation else None
                self._translation_screen_idx = (
                    get_translation_screen_idx(content) if content else None
                )
                self._translation_screen_pres_id = presentation_id
            if self._translation_screen_idx is None:
                return None
            return existing_translation_text(self.db, item_id, self._translation_screen_idx)
        except Exception as e:
            logger.debug(f"No existing translation for {item_id}: {e}")
            return None

    def _item_has_missing_translation(self, item: ServiceItemWithSlides) -> bool:
        """True if any non-empty slide lacks a translation in any target language.

        Content-addressed: a slide whose text changed underneath us is a fresh key and so
        a miss, which is how a mid-show edit gets re-translated.
        """
        for language in SLIDE_TRANSLATION_LANGUAGES:
            for slide in item.slides:
                if not slide.strip():
                    continue
                if slide_translation_key(language, slide) not in self.slide_translations_map:
                    return True
        return False

    def _translation_scan_order(self) -> list:
        """Item ids to consider translating, active item first, then upcoming, then past.

        Rotating the service order so the active item leads means a newly on-air item is
        picked up on the next scan even while we were working ahead on later items.
        """
        order = list(self.service_order_map['order']) if 'order' in self.service_order_map else []
        active = self.status_map['itemId'] if 'itemId' in self.status_map else None
        if active and active in order:
            i = order.index(active)
            return order[i:] + order[:i]
        return order

    async def _translate_pending_items(self) -> bool:
        """Translate one item that still has missing translations, if any.

        Scans the service order (active first); the first item whose current slide content
        we haven't yet attempted and that has a cache miss is translated and stored. Returns
        True if it did a unit of work (so the caller re-scans immediately), False when
        everything reachable is already covered. Each content version is attempted once —
        recorded by slides hash — so a failed or partial translation doesn't spin.
        """
        for item_id in self._translation_scan_order():
            item = self.items_by_id.get(item_id)
            if not item or not item.slides:
                continue
            current_hash = slides_hash(item.slides)
            if self.translated_hashes.get(item_id) == current_hash:
                continue  # already handled this content version
            if not self._item_has_missing_translation(item):
                # Fully covered already (e.g. warm-started from the library) — mark and skip.
                self.translated_hashes[item_id] = current_hash
                continue

            existing = self._existing_translation_for(item_id)
            translations = await self._translate_item(item.slides, item.title, item_id, existing)
            # Mark attempted even on failure so we don't hammer the same content; a real
            # content change produces a new hash and another attempt.
            self.translated_hashes[item_id] = current_hash
            if translations:
                self._store_translations(item.slides, translations)
                logger.info(f"Translated item {item_id} ({item.title})")
            return True
        return False

    async def _translation_worker(self) -> None:
        """Background loop that pre-translates items off the poll loop.

        Runs for the life of a session. Keeps translating pending items back-to-back, then
        idles when there's nothing left. Errors are reported but never end the worker.
        """
        while True:
            try:
                did_work = await self._translate_pending_items()
            except Exception as e:  # best-effort: never let a translation kill the worker
                logger.warning(f"Translation worker error: {e}")
                if ph: ph.capture_exception(e, distinct_id=DISTINCT_ID)
                did_work = False
            await anyio.sleep(0 if did_work else TRANSLATION_SCAN_INTERVAL)

    async def _wait_until_on_air(self) -> Dict[str, Any]:
        """Poll Proclaim until it reports on air, holding NO Y-Sweet connection.

        Returns the first on-air status (so the caller can resolve the doc from the
        show before connecting). We don't open (or keep) a Y-Sweet connection while
        nothing is happening, so we never depend on a connection that was established
        long before it was needed.
        """
        announced = False
        while True:
            self._maybe_roll_doc_date()
            status = await self._fetch_status()
            if status is not None:
                logger.info("Proclaim is on air - connecting to Y-Sweet")
                return status
            if not announced:
                logger.info("Waiting for Proclaim to go on air (no Y-Sweet connection held)")
                announced = True
            await anyio.sleep(POLL_INTERVAL_OFF_AIR)

    async def _run_session(self) -> None:
        """Open a Y-Sweet connection and sync until off air, disconnect, or date roll.

        Returns normally when the session ends for an expected reason (sustained
        off air or a date rollover). Raises on connection problems so the caller
        can reconnect with backoff.
        """
        token_data = await self.get_ysweet_token()
        ws_url = token_data['url'] + '/' + self.doc_id
        logger.info(f"Connecting to Y-Sweet: {ws_url}")

        async with (
            aconnect_ws(ws_url, keepalive_ping_interval_seconds=WS_PING_INTERVAL) as websocket,
            Provider(self.ydoc, HttpxWebsocket(websocket, self.doc_id)),
        ):
            logger.info("Connected to Y-Sweet")
            # Force a re-push of the current state onto the freshly connected server.
            self.last_item_id = None
            self.last_slide_index = None

            # Run translation off the poll loop: a slow translation must never stall status
            # polling (which is what caused us to miss fast-changing items). The worker is
            # scoped to this session and torn down when the poll loop ends or raises.
            async with anyio.create_task_group() as session_tg:
                session_tg.start_soon(self._translation_worker)
                await self._poll_until_session_end(websocket)
                session_tg.cancel_scope.cancel()

    async def _poll_until_session_end(self, websocket) -> None:
        """Poll Proclaim and push status/order to Yjs until the session should end.

        Returns on a sustained off-air period or a date rollover; raises on a websocket
        problem (so run() reconnects). Translation runs in the background worker, so a slow
        translation can't delay polling.
        """
        off_air_since: Optional[float] = None
        last_ping = anyio.current_time()
        last_order_sync = float('-inf')  # force an immediate sync on connect
        while True:
            # Don't swap the Doc while connected; end the session and let the
            # caller roll the date with a fresh Doc, then reconnect.
            if self._date_rolled_over():
                logger.info("Date changed - ending session to roll the document")
                return

            status = await self._fetch_status()
            if status is None:
                now = anyio.current_time()
                if off_air_since is None:
                    off_air_since = now
                    logger.info("Off air - will disconnect from Y-Sweet if it persists")
                elif now - off_air_since >= OFF_AIR_DISCONNECT_AFTER:
                    logger.info("Off air long enough - disconnecting from Y-Sweet")
                    return
                await anyio.sleep(POLL_INTERVAL_OFF_AIR)
                continue

            off_air_since = None

            # Remember the current presentation so the translation worker can locate the
            # right translation screen for existing-translation grounding.
            self.current_presentation_id = status.get('presentationId') or self.current_presentation_id

            # Refresh the full service order periodically, or immediately when the
            # active item isn't in our cache yet (e.g. right after connecting).
            now = anyio.current_time()
            active_item = status.get('status', {}).get('itemId')
            if (
                now - last_order_sync >= SERVICE_ORDER_SYNC_INTERVAL
                or (active_item and active_item not in self.items_by_id)
            ):
                presentation = await self._fetch_onair_presentation()
                if presentation:
                    if DUMP_PRESENTATION_JSON:
                        Path('presentation.json').write_text(json.dumps(presentation, indent=2))
                    self._sync_service_order(presentation)
                last_order_sync = now

            self._apply_status(status)

            # Health check (throttled to WS_PING_INTERVAL, separate from the
            # faster slide-poll cadence). The keepalive task is what actually
            # detects a silent/half-open drop - it waits for the pong and closes
            # the socket on timeout - but it reports that only through recv(),
            # which the Provider swallows. So we send here too: once the socket
            # is closed, this raises in our scope and reaches the reconnect loop
            # in run(). (Our send doesn't await a pong, so on its own it can't
            # spot a half-open connection - hence the dependency on keepalive.)
            now = anyio.current_time()
            if now - last_ping >= WS_PING_INTERVAL:
                await websocket.ping()
                last_ping = now
            await anyio.sleep(POLL_INTERVAL)

    async def run(self):
        """Main service loop: wait for on air, connect, sync, reconnect on failure."""
        logger.info(f"Starting Proclaim service for doc: {self.doc_id}")
        logger.info(f"Proclaim URL: {self.proclaim_client.base_url}")
        logger.info(f"Y-Sweet URL: {self.ysweet_url}")
        logger.info(f"Poll interval: {POLL_INTERVAL}s (on air), {POLL_INTERVAL_OFF_AIR}s (off air)")

        backoff = RECONNECT_BACKOFF_INITIAL
        while True:
            try:
                # Phase 1: no connection held until Proclaim is actually on air.
                on_air_status = await self._wait_until_on_air()
                # Anchor the date-based doc to the on-air show's date before connecting.
                self._resolve_doc_for_session(on_air_status.get('presentationId'))
                # Phase 2: connect and sync until off air / date roll / disconnect.
                await self._run_session()
                # Clean end of a session - reset backoff for the next connect.
                backoff = RECONNECT_BACKOFF_INITIAL
            except (HTTPXWSException, httpx.HTTPError, OSError) as e:
                logger.warning(
                    f"Y-Sweet connection problem ({type(e).__name__}: {e}); "
                    f"reconnecting in {backoff:.0f}s"
                )
                await anyio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)
            except Exception as e:
                # Unexpected - report it, but keep the service alive and retry.
                logger.error(f"Unexpected error in service loop: {e}", exc_info=True)
                if ph: ph.capture_exception(e, distinct_id=DISTINCT_ID)
                await anyio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

async def signal_handler(cancel_scope: anyio.CancelScope):
    with anyio.open_signal_receiver(signal.SIGINT, signal.SIGTERM) as signals:
        async for signum in signals:
            signal_name = signal.strsignal(signum) or str(signum)
            logger.info(f"Received {signal_name}, shutting down...")
            cancel_scope.cancel()
            return

async def main():
    """Entry point with signal handling"""
    # Parse command line arguments
    parser = argparse.ArgumentParser(description='Proclaim Service - Syncs Proclaim to Yjs')
    parser.add_argument(
        'doc_id',
        nargs='?',
        help="Document ID override. Default: doc-YYYY-MM-DD from the on-air show's "
             "DateGiven (falling back to today's date).",
    )
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    args = parser.parse_args()

    # Set logging level
    if args.debug:
        logger.setLevel(logging.DEBUG)
        logger.debug("Debug logging enabled")

    # Get doc ID from arguments or environment
    # If neither provided, service will use date-based doc_id (default)
    doc_id = args.doc_id or os.getenv('PROCLAIM_DOC_ID')

    service = ProclaimYjsService(YSWEET_URL, doc_id)

    async with anyio.create_task_group() as tg:
        tg.start_soon(service.run)
        tg.start_soon(signal_handler, tg.cancel_scope)


if __name__ == '__main__':
    anyio.run(main)
