#!/usr/bin/env python3
"""
Proclaim Service - Syncs Proclaim presentation data to Yjs

This service:
1. Polls Proclaim API for current presentation and slide status
2. Parses presentation content from the Proclaim database
3. Updates Yjs shared state with presentation data (via Y-Sweet)
4. Watches for changes and updates clients in real-time
"""

import os
import sys
import json
import logging
import signal
import anyio
from typing import Optional, Dict, Any, List
from pathlib import Path
from datetime import date
import httpx
import sqlite3
from lxml import etree

from pycrdt import Doc, Map, Array
from httpx_ws import aconnect_ws
from pycrdt import Provider
from pycrdt.websocket.websocket import HttpxWebsocket

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('proclaim-service')

# Suppress INFO logging from httpx
logging.getLogger('httpx').setLevel(logging.WARNING)

# Configuration
PROCLAIM_BASE_URL = os.getenv('PROCLAIM_BASE_URL', 'http://localhost:52195')
YSWEET_URL = os.getenv('YSWEET_URL', 'http://dev8.kenarnold.org')
POLL_INTERVAL = float(os.getenv('PROCLAIM_POLL_INTERVAL', '1.0'))  # seconds


class ProclaimClient:
    """Client for Proclaim API and database"""

    def __init__(self, base_url: str = PROCLAIM_BASE_URL):
        self.base_url = base_url
        self.session_id: Optional[str] = None
        self.db_path: str = self._find_presentation_db()
        self.http_client = httpx.AsyncClient()

    @staticmethod
    def _find_presentation_db() -> str :
        """Find the most recently modified Proclaim presentation database file."""
        # Find the Proclaim data directory based on OS
        if (path := Path.home() / 'Library' / 'Application Support' / 'Proclaim' / 'Data').exists():
            proclaim_root = path
        elif (path := Path.home() / 'AppData' / 'Local' / 'Proclaim' / 'Data').exists():
            proclaim_root = path
        else:
            raise FileNotFoundError('Proclaim data directory not found.')

        # Find all PresentationManager.db files under it
        db_files = list(proclaim_root.glob('*/PresentationManager/PresentationManager.db'))
        if not db_files:
            raise FileNotFoundError('No PresentationManager.db files found.')

        # Return the most recently modified one
        return str(max(db_files, key=lambda p: p.stat().st_mtime))


    async def get_session_id(self, timeout: float = 2.0) -> str:
        """Request /onair/session and return the session id."""
        url = f"{self.base_url}/onair/session"
        r = await self.http_client.get(url, timeout=timeout)
        r.raise_for_status()
        self.session_id = r.content.decode('utf-8-sig')
        return self.session_id

    async def get_onair_presentation(self, timeout: float = 5.0) -> Dict[str, Any]:
        """Fetch /presentations/onair with the OnAirSessionId header."""
        if not self.session_id:
            await self.get_session_id()
        assert self.session_id is not None

        url = f"{self.base_url}/presentations/onair"
        headers = {'OnAirSessionId': self.session_id}
        r = await self.http_client.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.json()

    async def get_status(self, timeout: float = 5.0) -> Dict[str, Any]:
        """Fetch /onair/statusChanged with the OnAirSessionId header."""
        if not self.session_id:
            await self.get_session_id()
        assert self.session_id is not None

        url = f"{self.base_url}/onair/statusChanged"
        headers = {'OnAirSessionId': self.session_id}
        r = await self.http_client.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.json()

    def get_service_item(self, item_id: str) -> Optional[Dict[str, Any]]:
        """Get a service item by its ID from the Proclaim database."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM ServiceItems WHERE ServiceItemId = ?", (item_id,))
            row = cursor.fetchone()
            if row is None:
                return None
            return dict(zip([col[0] for col in cursor.description], row))

    def get_presentation(self, presentation_id: str) -> Optional[Dict[str, Any]]:
        """Get presentation data from the database."""
        # strip hyphens from presentation_id
        presentation_id = presentation_id.replace('-', '')

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT PresentationId, Content FROM Presentations WHERE PresentationId = ?",
                          (presentation_id,))
            row = cursor.fetchone()
            if row is None:
                return None

            return {
                'id': row[0],
                'content': json.loads(row[1])
            }

    @staticmethod
    def decode_richtext_xml(xml: str) -> str:
        """
        Decode the rich text XML from Proclaim into plain text.

        The basic XML format is:
        <Paragraph Language="en-US" Margin="0,0,0,0">
            <Run Text="I love You Lord" />
        </Paragraph>
        """
        result = ''
        root = etree.fromstring('<Song>' + xml + '</Song>', parser=None)
        for paragraph in root:
            runs = paragraph.findall('Run')
            for run in runs:
                result += run.attrib['Text'] + ' '
            result += '\n'
        return result

    @staticmethod
    def get_translation_screen_idx(presentation_content: dict) -> Optional[int]:
        """Get the index of the translation screen from VirtualScreens."""
        virtual_screens = json.loads(presentation_content.get('VirtualScreens', '[]'))

        # Filter to slide screens only
        slide_screens = [s for s in virtual_screens if s['outputKind'] in ['Slides', 'SlidesAlternateContent']]

        # Find translation screen (French or Haitian)
        for idx, screen in enumerate(slide_screens):
            if any(lang in screen['name'] for lang in ['French', 'Haitian']):
                return idx

        return None

    @staticmethod
    def split_into_slides(text: str) -> List[str]:
        """Split the text into sections based on blank lines or --."""
        sections = ['']
        for line in text.strip().split('\n'):
            line_stripped = line.strip()
            if line_stripped == '' or line_stripped == '--':
                sections.append('')
            else:
                sections[-1] += line + '\n'

        # Filter out empty sections and credits/source
        return [
            section.strip()
            for section in sections
            if section.strip() != ''
            and not (section.startswith('{Credits}') or section.startswith('{Source}'))
        ]

    @staticmethod
    def split_into_sections(text: str) -> Dict[str, List[str]]:
        """
        Split the song text into sections.
        A blank line followed by a section type marks a section:
        Verse, Chorus, Pre-chorus, Bridge, Tag, Title, Interlude
        """
        sections = {}
        current_section_label = None
        section_types = {'Verse', 'Chorus', 'Pre-chorus', 'Bridge', 'Tag', 'Title', 'Interlude', 'Ending'}
        lines = [line.strip() for line in text.splitlines()]

        for line in lines:
            # Is this a section header?
            if any(line.startswith(st) for st in section_types):
                # If it doesn't have a number, call it #1
                if not any(char.isdigit() for char in line):
                    line += ' 1'
                current_section_label = line
            elif line.startswith('{') and line.endswith('}'):
                current_section_label = line[1:-1].strip()
            else:
                sections.setdefault(current_section_label, []).append(line)

        return {
            label: ProclaimClient.split_into_slides('\n'.join(lines))
            for label, lines in sections.items()
        }

    @staticmethod
    def get_slides_in_order(slide_sections: Dict[str, List[str]], order_str: str) -> List[str]:
        """Decode the CustomOrderSequence string into the slides in order."""
        slides = []

        # Empty order: take all slides
        if order_str.strip() == '':
            for section in slide_sections.values():
                slides.extend(section)
            return slides

        for token in order_str.split(','):
            token = token.strip()

            # Handle numbers at the end
            trailing_number = ''
            while token and token[-1].isdigit():
                trailing_number = token[-1] + trailing_number
                token = token[:-1]
            token = token.strip()
            lower_token = token.lower()

            # Determine label
            if token == '':
                assert trailing_number
                label = f"Verse {trailing_number}"
            elif lower_token in ('v', 'verse'):
                label = f"Verse {trailing_number or '1'}"
            elif lower_token in ('c', 'chorus'):
                label = f"Chorus {trailing_number or '1'}"
            elif lower_token in ('p', 'pre-chorus'):
                label = f"Pre-chorus {trailing_number or '1'}"
            elif lower_token == 'b':
                # Check if "Bridge" with that number exists
                possible_label = f"Bridge {trailing_number or '1'}"
                if possible_label in slide_sections:
                    label = possible_label
                else:
                    label = "Blank"
            elif lower_token == 'bridge':
                label = f"Bridge {trailing_number or '1'}"
            elif lower_token in ('t', 'tag'):
                label = f"Tag {trailing_number or '1'}"
            elif lower_token == 'i':
                label = f"Interlude {trailing_number or '1'}"
            elif lower_token == 'ending':
                label = f"Ending {trailing_number or '1'}"
            else:
                label = token

            if label == 'Blank':
                slides.append('')
            elif label in slide_sections:
                slides.extend(slide_sections[label])
            else:
                logger.warning(f"Label '{label}' ({token}) not found in slide sections.")

        return slides

    def parse_item_translation(self, item_id: str, translation_screen_idx: int) -> Optional[Dict[str, Any]]:
        """Extract translated slides for any item type."""
        service_item = self.get_service_item(item_id.replace('-', ''))
        if not service_item:
            logger.warning(f"Service item {item_id} not found")
            return None

        try:
            content = json.loads(service_item['Content'])
            item_kind = service_item.get('ServiceItemKind', 'Unknown')
            item_title = service_item.get('Title', 'Unknown')

            # Check if this is a skipped item type - show as blank instead
            if item_title.lower() in ['blank', 'ncf slide', 'offering slide']:
                logger.info(f"Showing blank item: {item_title}")
                return {
                    'itemId': item_id,
                    'title': item_title,
                    'slides': [''],
                    'itemKind': item_kind,
                }

            # All item types use the same translation field pattern
            # Note: Using -1 offset to match validate_proclaim.py
            translation_key = f'slideOutput:{translation_screen_idx-1}:RichTextXml'

            if translation_key not in content:
                logger.warning(f"No translation found for {item_id} (key: {translation_key})")
                return None

            # Decode translation XML
            translation_xml = content[translation_key]
            translation_text = self.decode_richtext_xml(translation_xml)

            # Handle songs specially: they need section parsing and custom ordering
            if item_kind == 'SongLyrics':
                sections = self.split_into_sections(translation_text)
                order_str = content.get('CustomOrderSequence', '')
                slides = self.get_slides_in_order(sections, order_str)

                # Add title slide if present
                if title := content.get('SongDisplayTitle'):
                    slides.insert(0, title)
            else:
                # Content and BiblePassage: just split into slides
                slides = self.split_into_slides(translation_text)

            return {
                'itemId': item_id,
                'title': item_title,
                'slides': slides,
                'itemKind': item_kind,
            }
        except Exception as e:
            logger.error(f"Error parsing translation for {item_id}: {e}")
            return None


class ProclaimYjsService:
    """Service that syncs Proclaim data to Yjs via Y-Sweet"""

    def __init__(self, ysweet_url: str, doc_id: str):
        self.proclaim_client = ProclaimClient()
        self.ysweet_url = ysweet_url
        self.doc_id = doc_id

        # Yjs state
        self.ydoc = Doc()
        self.presentations_map = self.ydoc.get('proclaimPresentations', type=Map)
        self.status_map = self.ydoc.get('proclaimStatus', type=Map)

        # State tracking
        self.last_item_id = None
        self.last_slide_index = None

    async def get_ysweet_token(self) -> Dict[str, Any]:
        """Get a Y-Sweet token for the document"""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.ysweet_url}/api/ys-auth",
                json={"docId": self.doc_id, "isEditor": True}
            )
            response.raise_for_status()
            return response.json()


    def update_presentation_in_yjs(self, presentation_data: Dict[str, Any]):
        """Store full presentation data in Yjs"""
        item_id = presentation_data['itemId']

        with self.ydoc.transaction():
            self.presentations_map[item_id] = {
                'title': presentation_data['title'],
                'itemId': item_id,
                'slides': presentation_data['slides']
            }

        logger.info(f"Stored presentation {item_id} ({presentation_data['title']}) with {len(presentation_data['slides'])} slides")

    def update_status_in_yjs(self, item_id: str, slide_index: int):
        """Update current status in Yjs"""
        with self.ydoc.transaction():
            self.status_map['itemId'] = item_id
            self.status_map['slideIndex'] = slide_index

        logger.info(f"Updated status: {item_id} slide {slide_index}")


    async def poll_once(self):
        """Poll Proclaim once and update state if changed"""
        try:
            # Get current status
            status = await self.proclaim_client.get_status()
            item_id = status.get('status', {}).get('itemId')
            slide_index = status.get('status', {}).get('slideIndex', 0)
            presentation_id = status.get('presentationId')

            # Check if presentation changed
            if item_id != self.last_item_id:
                logger.info(f"Item changed to {item_id} in presentation {presentation_id}")

                # Get presentation data to extract translation screen index
                if presentation_id:
                    pres_data = self.proclaim_client.get_presentation(presentation_id)
                    if pres_data:
                        translation_screen_idx = self.proclaim_client.get_translation_screen_idx(pres_data['content'])

                        if translation_screen_idx is not None:
                            # Parse the item with translation
                            item_data = self.proclaim_client.parse_item_translation(item_id, translation_screen_idx)

                            if item_data:
                                self.update_presentation_in_yjs(item_data)
                                self.update_status_in_yjs(item_id, slide_index)
                                # Provider automatically syncs updates

                                self.last_item_id = item_id
                                self.last_slide_index = slide_index
                        else:
                            logger.warning(f"No translation screen found in presentation {presentation_id}")
                    else:
                        logger.warning(f"Presentation {presentation_id} not found in database")
                else:
                    logger.warning("No presentation ID in status response")

            # Check if slide changed
            elif slide_index != self.last_slide_index:
                logger.info(f"Slide changed to {slide_index}")
                self.update_status_in_yjs(item_id, slide_index)
                # Provider automatically syncs updates

                self.last_slide_index = slide_index

        except httpx.HTTPError as e:
            logger.error(f"Error polling Proclaim: {e}")
        except Exception as e:
            logger.error(f"Unexpected error: {e}", exc_info=True)

    async def run(self):
        """Main service loop"""
        logger.info(f"Starting Proclaim service for doc: {self.doc_id}")
        logger.info(f"Proclaim URL: {self.proclaim_client.base_url}")
        logger.info(f"Y-Sweet URL: {self.ysweet_url}")
        logger.info(f"Poll interval: {POLL_INTERVAL}s")

        try:
            # Get Y-Sweet token and build WebSocket URL
            token_data = await self.get_ysweet_token()
            ws_url = token_data['url'] + '/' + self.doc_id
            logger.info(f"Connecting to Y-Sweet: {ws_url}")
        except Exception as e:
            logger.error(f"Failed to get Y-Sweet token: {e}")
            return
        
        try:
            # Connect to Proclaim
            await self.proclaim_client.get_session_id()
            logger.info(f"Connected to Proclaim session: {self.proclaim_client.session_id}")
        except Exception as e:
            logger.error(f"Failed to connect to Proclaim: {e}")
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
                    await self.poll_once()
                    await anyio.sleep(POLL_INTERVAL)
                except Exception as e:
                    logger.error(f"Error in polling loop: {e}", exc_info=True)
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
    # Get doc ID from command line or environment
    # Default doc id is `doc-${date}`, where date is today's date
    doc_id = sys.argv[1] if len(sys.argv) > 1 else os.getenv('PROCLAIM_DOC_ID', f'doc-{date.today().isoformat()}')

    service = ProclaimYjsService(YSWEET_URL, doc_id)

    async with anyio.create_task_group() as tg:
        tg.start_soon(service.run)
        tg.start_soon(signal_handler, tg.cancel_scope)


if __name__ == '__main__':
    anyio.run(main)
