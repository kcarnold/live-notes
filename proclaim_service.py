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
from opentelemetry import logs as otel_logs
from opentelemetry.sdk.logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk.logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

from pycrdt import Doc, Map
from httpx_ws import aconnect_ws
from pycrdt import Provider
from pycrdt.websocket.websocket import HttpxWebsocket

from proclaim_lib import (
    ServiceItemWithSlides,
    ProclaimDB,
    get_translation_screen_idx,
    parse_item_translation,
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
YSWEET_URL = os.getenv('YSWEET_URL', 'https://dev8.kenarnold.org')
POLL_INTERVAL = float(os.getenv('PROCLAIM_POLL_INTERVAL', '0.5'))  # seconds
POLL_INTERVAL_OFF_AIR = float(os.getenv('PROCLAIM_POLL_INTERVAL_OFF_AIR', '10'))  # seconds

DUMP_PRESENTATION_JSON = os.getenv('DUMP_PRESENTATION_JSON', 'false').lower() == 'true'

_POSTHOG_KEY = os.getenv('POSTHOG_API_KEY', '')
_POSTHOG_HOST = os.getenv('POSTHOG_HOST', 'https://us.i.posthog.com')
DISTINCT_ID = f'proclaim-service@{socket.gethostname()}'

if _POSTHOG_KEY:
    ph = Posthog(_POSTHOG_KEY, host=_POSTHOG_HOST, enable_exception_autocapture=True)

    _logger_provider = LoggerProvider()
    otel_logs.set_logger_provider(_logger_provider)
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
            self.doc_id = doc_id
            self.current_doc_date = None

        # Yjs state
        self.ydoc: Doc = Doc()
        self.presentations_map = self.ydoc.get('proclaimPresentations', type=Map)
        self.status_map = self.ydoc.get('proclaimStatus', type=Map)

        # State tracking
        self.last_item_id: Optional[str] = None
        self.last_slide_index: Optional[int] = None
        self.current_item_slides: Optional[ServiceItemWithSlides] = None

    @staticmethod
    def _get_date_based_doc_id() -> str:
        """Generate doc ID based on current date"""
        return f'doc-{date.today().isoformat()}'

    def _check_doc_id_change(self) -> bool:
        """Check if date-based doc ID has changed. Returns True if changed."""
        if not self.use_date_based_doc_id:
            return False

        today = date.today()
        if today != self.current_doc_date:
            old_doc_id = self.doc_id
            self.doc_id = self._get_date_based_doc_id()
            self.current_doc_date = today
            logger.info(f"Date changed: {old_doc_id} → {self.doc_id}")
            return True
        return False

    async def get_ysweet_token(self) -> Dict[str, Any]:
        """Get a Y-Sweet token for the document"""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.ysweet_url}/api/ys-auth",
                json={"docId": self.doc_id, "isEditor": True}
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
        # Clip slide index to valid range
        if self.current_item_slides:
            max_index = len(self.current_item_slides.slides) - 1
            if slide_index > max_index:
                logger.warning(f"Slide index {slide_index} out of range for item {item_id}, clipping to {max_index}")
                slide_index = max_index
            if slide_index < 0:
                logger.warning(f"Slide index {slide_index} less than 0 for item {item_id}, clipping to 0")
                slide_index = 0
        with self.ydoc.transaction():
            self.status_map['itemId'] = item_id
            self.status_map['slideIndex'] = slide_index

        logger.info(f"Updated status: {item_id} slide {slide_index}")


    def _handle_item_change(self, item_id: str, slide_index: int, presentation_id: Optional[str]) -> bool:
        """Handle an item change. Returns True if state was updated."""
        if not presentation_id:
            logger.warning("No presentation ID in status response")
            return False

        pres_data = self.db.get_presentation(presentation_id)
        if not pres_data:
            logger.warning(f"Presentation {presentation_id} not found in database")
            return False

        translation_idx = get_translation_screen_idx(pres_data['content'])
        if translation_idx is None:
            logger.warning(f"No translation screen found in presentation {presentation_id}")
            return False

        item_with_slides = parse_item_translation(self.db, item_id, translation_idx)
        if not item_with_slides:
            return False

        self.update_presentation_item_in_yjs(item_with_slides)
        self.current_item_slides = item_with_slides
        self.update_status_in_yjs(item_id, slide_index)
        self.last_item_id = item_id
        self.last_slide_index = slide_index
        return True

    async def poll_once(self) -> bool:
        """Poll Proclaim once and update state if changed. Returns True if on air."""
        try:
            # Get current status
            status = await self.proclaim_client.get_status()
            if not status:
                # off air.
                return False

            item_id = status.get('status', {}).get('itemId')
            slide_index = status.get('status', {}).get('slideIndex', 0)
            presentation_id = status.get('presentationId')

            if DUMP_PRESENTATION_JSON:
                presentation = await self.proclaim_client.get_onair_presentation()
                if presentation:
                    Path('presentation.json').write_text(json.dumps(presentation, indent=2))

            # Check if item changed
            if item_id != self.last_item_id:
                logger.info(f"Item changed to {item_id} in presentation {presentation_id}")
                self._handle_item_change(item_id, slide_index, presentation_id)
                return True

            # Check if slide changed
            if slide_index != self.last_slide_index:
                logger.info(f"Slide changed to {slide_index}")
                self.update_status_in_yjs(item_id, slide_index)
                self.last_slide_index = slide_index

            return True

        except httpx.ConnectError:
            logger.debug("Proclaim not reachable (not running?)")
            return False
        except httpx.HTTPError as e:
            logger.error(f"Error polling Proclaim: {e}")
            if ph: ph.capture_exception(e, distinct_id=DISTINCT_ID)
            return False
        except Exception as e:
            logger.error(f"Unexpected error: {e}", exc_info=True)
            if ph: ph.capture_exception(e, distinct_id=DISTINCT_ID)
            return False

    async def run(self):
        """Main service loop"""
        logger.info(f"Starting Proclaim service for doc: {self.doc_id}")
        logger.info(f"Proclaim URL: {self.proclaim_client.base_url}")
        logger.info(f"Y-Sweet URL: {self.ysweet_url}")
        logger.info(f"Poll interval: {POLL_INTERVAL}s (on air), {POLL_INTERVAL_OFF_AIR}s (off air)")

        try:
            # Get Y-Sweet token and build WebSocket URL
            token_data = await self.get_ysweet_token()
            ws_url = token_data['url'] + '/' + self.doc_id
            logger.info(f"Connecting to Y-Sweet: {ws_url}")
        except Exception as e:
            logger.error(f"Failed to get Y-Sweet token: {e}")
            return

        # Connect to Y-Sweet with WebsocketProvider
        async with (
            aconnect_ws(ws_url) as websocket,
            Provider(self.ydoc, HttpxWebsocket(websocket, self.doc_id)),
        ):
            logger.info("Connected to Y-Sweet")

            # Main polling loop
            while True:
                try:
                    # Check if date changed (for date-based doc IDs)
                    if self._check_doc_id_change():
                        logger.info("Date changed, exiting for restart with new document")
                        return

                    is_on_air = await self.poll_once()
                    interval = POLL_INTERVAL if is_on_air else POLL_INTERVAL_OFF_AIR
                    await anyio.sleep(interval)
                except Exception as e:
                    logger.error(f"Error in polling loop: {e}", exc_info=True)
                    if ph: ph.capture_exception(e, distinct_id=DISTINCT_ID)
                    await anyio.sleep(POLL_INTERVAL)

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
    parser.add_argument('doc_id', nargs='?', help='Document ID (default: date-based doc-YYYY-MM-DD)')
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
