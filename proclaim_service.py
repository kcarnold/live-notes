#!/usr/bin/env python3
"""Proclaim Service entrypoint - syncs Proclaim presentation data to Yjs.

This is the thin wiring layer. The work is split across:
- ``proclaim_feed.ProclaimFeed`` - the slide *source* (Proclaim HTTP API + SQLite DB),
  emitting a serializable ``FeedSnapshot`` each poll.
- ``yjs_publisher.YjsSlidePublisher`` - the client consumer (writes the Yjs maps browsers read).
- ``slide_translator.SlideTranslator`` - the translation consumer (seeds ``slideTranslations``).
- ``slide_sync_runtime.SlideSyncRuntime`` - the source-agnostic lifecycle: doc rollover,
  Y-Sweet connect/reconnect, and the per-cycle fan-out to both consumers.

This module owns the environment/config, logging + telemetry, and the injected translation
HTTP call; it builds the pieces and runs the runtime.

Protocol documentation for the Proclaim local API lives in ``proclaim_feed.py``.
"""

import argparse
import logging
import os
import signal
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import anyio
import httpx
from pycrdt import Doc, Map
from posthog import Posthog
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

from proclaim_feed import DEFAULT_PROCLAIM_BASE_URL, ProclaimFeed
from slide_feed import SlideFeed
from slide_replay import RecordingSlideFeed, ReplaySlideFeed, load_records
from slide_sync_runtime import RuntimeTiming, SlideSyncRuntime
from write_key import get_write_key, write_key_headers
from slide_translator import SlideTranslator
from yjs_publisher import YjsSlidePublisher

# Configure logging (default level, can be overridden by --debug flag)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('proclaim-service')

# Suppress INFO logging from httpx
logging.getLogger('httpx').setLevel(logging.WARNING)

# Configuration
PROCLAIM_BASE_URL = os.getenv('PROCLAIM_BASE_URL', DEFAULT_PROCLAIM_BASE_URL)
YSWEET_URL = os.getenv('YSWEET_URL', '')
assert YSWEET_URL, "YSWEET_URL must be set"
# Shared key identifying this machine to the server's privileged endpoints (full Y-Sweet
# tokens, /api/translateItem). Installed into the LaunchAgent plist by
# install_proclaim_service.sh --write-key=. Optional while the server runs in observe mode.
WRITE_KEY = get_write_key()
POLL_INTERVAL = float(os.getenv('PROCLAIM_POLL_INTERVAL', '0.5'))  # seconds
POLL_INTERVAL_OFF_AIR = float(os.getenv('PROCLAIM_POLL_INTERVAL_OFF_AIR', '10'))  # seconds
# How often the feed re-reads the full on-air service order (all items + slides). Items whose
# Proclaim localRevision is unchanged are not re-parsed, so this is cheap; the interval just
# bounds how quickly a slide edited underneath us is picked up.
SERVICE_ORDER_SYNC_INTERVAL = float(os.getenv('PROCLAIM_SERVICE_ORDER_SYNC_INTERVAL', '2.0'))  # seconds
# How long the background translation worker idles when there's nothing left to translate.
TRANSLATION_SCAN_INTERVAL = float(os.getenv('PROCLAIM_TRANSLATION_SCAN_INTERVAL', '1.0'))  # seconds
# Target languages to pre-translate slides into (must match the frontend's configured
# languages). The translator asks the server to translate the active item into these and
# writes the reviewed-or-auto results into the per-day slideTranslations map.
SLIDE_TRANSLATION_LANGUAGES = [
    lang.strip()
    for lang in os.getenv('SLIDE_TRANSLATION_LANGUAGES', 'French,Haitian Creole,Spanish').split(',')
    if lang.strip()
]

# Connection robustness tuning (see slide_sync_runtime.RuntimeTiming for what these gate).
RECONNECT_BACKOFF_INITIAL = float(os.getenv('PROCLAIM_RECONNECT_BACKOFF_INITIAL', '1.0'))  # seconds
RECONNECT_BACKOFF_MAX = float(os.getenv('PROCLAIM_RECONNECT_BACKOFF_MAX', '30.0'))  # seconds
OFF_AIR_DISCONNECT_AFTER = float(os.getenv('PROCLAIM_OFF_AIR_DISCONNECT_AFTER', '60'))  # seconds
WS_PING_INTERVAL = float(os.getenv('PROCLAIM_WS_PING_INTERVAL', '15'))  # seconds
YSWEET_TOKEN_TIMEOUT = float(os.getenv('PROCLAIM_YSWEET_TOKEN_TIMEOUT', '30'))  # seconds

_POSTHOG_KEY = os.getenv('POSTHOG_API_KEY', '')
_POSTHOG_HOST = os.getenv('POSTHOG_HOST', 'https://us.i.posthog.com')
DISTINCT_ID = f'proclaim-service@{socket.gethostname()}'

ph: Optional[Posthog]
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


def report_exception(e: Exception) -> None:
    """Report an exception to PostHog (no-op when telemetry isn't configured)."""
    if ph:
        ph.capture_exception(e, distinct_id=DISTINCT_ID)


REPO_DIR = Path(__file__).resolve().parent


def _git_output(*args: str) -> str:
    """Run a read-only git command in the repo, returning '' on any problem."""
    try:
        result = subprocess.run(
            ['git', '-C', str(REPO_DIR), *args],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception as e:  # git missing, not a checkout, hung, ...
        logger.debug(f"git {' '.join(args)} failed: {e}")
        return ''
    if result.returncode != 0:
        return ''
    return result.stdout.strip()


def service_version_info(env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Which version of the service is running, and is a newer one waiting?

    The launch wrapper (``proclaim_service_launch.sh``) exports what it resolved
    at launch, and that is the authoritative answer for an installed service: the
    channel SHA is what the release branch pointed at when this process started.
    Running by hand there's no wrapper, so fall back to asking git directly.

    ``updatePending`` means the release branch has moved past the running SHA —
    the status view turns that into "update pending: restart the service".
    """
    env = os.environ if env is None else env

    sha = env.get('PROCLAIM_SERVICE_GIT_SHA') or _git_output('rev-parse', 'HEAD')
    branch = env.get('PROCLAIM_SERVICE_GIT_BRANCH') or _git_output('rev-parse', '--abbrev-ref', 'HEAD')
    channel = env.get('PROCLAIM_UPDATE_CHANNEL', 'proclaim-stable')
    channel_sha = env.get('PROCLAIM_UPDATE_CHANNEL_SHA')
    if channel_sha is None:
        # Local remote-tracking ref only — never fetches, so this can't block startup.
        channel_sha = _git_output('rev-parse', f'origin/{channel}')

    return {
        'gitSha': sha,
        'gitShaShort': sha[:7],
        'gitBranch': branch,
        'updateChannel': channel,
        'channelSha': channel_sha,
        # Only claim "pending" when both sides are actually known.
        'updatePending': bool(sha and channel_sha and sha != channel_sha),
    }


def make_status_announcer(
    version_info: Optional[Dict[str, Any]] = None,
) -> Callable[[Doc], None]:
    """Build the runtime's per-session announcement into the shared `status` map (#72/#73).

    The version is resolved once, at startup: the launch wrapper's fetch is what makes
    `channelSha` meaningful, and that happened before this process existed. The runtime
    calls the returned function on every fresh connection (a doc rollover creates a new
    Doc, so each session needs its own announcement). The clientId lets a delta recorder
    attribute updates to this writer; the version fields drive the status view's
    "update pending: restart the service" flag.
    """
    info = service_version_info() if version_info is None else version_info
    started_at = datetime.now(timezone.utc).isoformat()

    def announce(doc: Doc) -> None:
        entry = {
            **info,
            'role': 'proclaim-service',
            'clientId': doc.client_id,
            'host': socket.gethostname(),
            'startedAt': started_at,
            'connectedAt': datetime.now(timezone.utc).isoformat(),
        }
        with doc.transaction():
            doc.get('status', type=Map)['proclaimService'] = entry

        pending = ' (update pending — restart to pick it up)' if entry['updatePending'] else ''
        logger.info(
            f"Reporting version {entry['gitShaShort'] or 'unknown'} "
            f"on {entry['gitBranch'] or 'unknown'}{pending}"
        )

    return announce


def make_translate_fn(ysweet_url: str, languages: List[str], write_key: Optional[str] = None):
    """Build the translation call the SlideTranslator injects: POST /api/translateItem.

    Returns the ``{language: [{text, status, provenance}, ...]}`` map, or None on failure
    (translation is best-effort; a failure must not drop the session).
    """
    async def translate(
        slides: List[str],
        item_title: Optional[str],
        item_id: Optional[str],
        existing_translation: Optional[str],
        doc_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        if not slides or not languages:
            return None
        body: Dict[str, Any] = {"slides": slides, "languages": languages}
        # docId names the per-day doc the server writes the agent conversation into (the
        # same doc this session is connected to).
        if doc_id:
            body["docId"] = doc_id
        if item_title and item_title != "Unknown":
            body["itemTitle"] = item_title
        if item_id:
            body["itemId"] = item_id
        if existing_translation:
            body["existingTranslation"] = existing_translation
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{ysweet_url}/api/translateItem",
                    json=body,
                    headers=write_key_headers(write_key),
                    timeout=3 * 60.0,
                )
                response.raise_for_status()
                return response.json().get('translations')
        except (httpx.HTTPError, ValueError) as e:
            # Timeout exceptions stringify to '', so log repr(e) to preserve the type.
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
                        "languages": languages,
                    },
                )
            return None

    return translate


def _build_feed(
    *,
    record_path: Optional[str],
    replay_path: Optional[str],
    replay_speed: float,
) -> SlideFeed:
    """Build the slide source: a live ``ProclaimFeed``, a ``ReplaySlideFeed`` (``--replay``),
    or a live feed wrapped in a ``RecordingSlideFeed`` (``--record``)."""
    if replay_path:
        records = load_records(replay_path)
        # speed > 0 scales real time (2x => half the delays); speed <= 0 replays instantly.
        time_scale = (1.0 / replay_speed) if replay_speed > 0 else 0.0
        logger.info(
            f"Replaying {len(records)} recorded snapshots from {replay_path} "
            f"(speed {replay_speed}x)"
        )
        return ReplaySlideFeed(records, time_scale=time_scale)

    feed: SlideFeed = ProclaimFeed(
        proclaim_base_url=PROCLAIM_BASE_URL,
        order_sync_interval=SERVICE_ORDER_SYNC_INTERVAL,
        report_exception=report_exception,
    )
    if record_path:
        feed = RecordingSlideFeed(feed, record_path)
    return feed


def build_runtime(
    doc_id: Optional[str],
    *,
    record_path: Optional[str] = None,
    replay_path: Optional[str] = None,
    replay_speed: float = 1.0,
) -> SlideSyncRuntime:
    """Wire the feed + consumers into a runtime from the module configuration."""
    feed = _build_feed(
        record_path=record_path, replay_path=replay_path, replay_speed=replay_speed
    )
    publisher = YjsSlidePublisher()
    translator = SlideTranslator(
        translate_fn=make_translate_fn(
            YSWEET_URL, SLIDE_TRANSLATION_LANGUAGES, write_key=WRITE_KEY
        ),
        languages=SLIDE_TRANSLATION_LANGUAGES,
        scan_interval=TRANSLATION_SCAN_INTERVAL,
        report_exception=report_exception,
    )
    timing = RuntimeTiming(
        # In replay mode the feed owns the cadence (it honors recorded timing), so don't add
        # the live on-air poll delay on top of it.
        poll_interval=0.0 if replay_path else POLL_INTERVAL,
        poll_interval_off_air=POLL_INTERVAL_OFF_AIR,
        off_air_disconnect_after=OFF_AIR_DISCONNECT_AFTER,
        reconnect_backoff_initial=RECONNECT_BACKOFF_INITIAL,
        reconnect_backoff_max=RECONNECT_BACKOFF_MAX,
        ws_ping_interval=WS_PING_INTERVAL,
        ysweet_token_timeout=YSWEET_TOKEN_TIMEOUT,
    )
    return SlideSyncRuntime(
        feed, publisher, translator, YSWEET_URL,
        doc_id=doc_id, timing=timing, report_exception=report_exception,
        on_session_start=make_status_announcer(),
        write_key=WRITE_KEY,
    )


async def signal_handler(cancel_scope: anyio.CancelScope):
    with anyio.open_signal_receiver(signal.SIGINT, signal.SIGTERM) as signals:
        async for signum in signals:
            signal_name = signal.strsignal(signum) or str(signum)
            logger.info(f"Received {signal_name}, shutting down...")
            cancel_scope.cancel()
            return


async def main():
    """Entry point with signal handling."""
    parser = argparse.ArgumentParser(description='Proclaim Service - Syncs Proclaim to Yjs')
    parser.add_argument(
        'doc_id',
        nargs='?',
        help="Document ID override. Default: doc-YYYY-MM-DD from the on-air show's "
             "DateGiven (falling back to today's date).",
    )
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    parser.add_argument(
        '--record', metavar='PATH',
        help="Record the slide feed's FeedSnapshot stream to PATH (JSONL) while running live, "
             "for later replay (issue #70).",
    )
    parser.add_argument(
        '--replay', metavar='PATH',
        help="Replay a recorded FeedSnapshot stream (JSONL) instead of polling Proclaim. "
             "Defaults to a fresh doc-test-<epoch> document so it never clobbers real data.",
    )
    parser.add_argument(
        '--replay-speed', type=float, default=1.0,
        help="Replay speed multiplier (2 = twice as fast); <= 0 replays as fast as possible.",
    )
    args = parser.parse_args()

    if args.debug:
        logger.setLevel(logging.DEBUG)
        logger.debug("Debug logging enabled")

    if args.record and args.replay:
        parser.error("--record and --replay are mutually exclusive")

    doc_id = args.doc_id or os.getenv('PROCLAIM_DOC_ID')
    if args.replay and not doc_id:
        doc_id = f'doc-test-{int(time.time())}'

    logger.info(f"Proclaim URL: {PROCLAIM_BASE_URL}")
    logger.info(f"Poll interval: {POLL_INTERVAL}s (on air), {POLL_INTERVAL_OFF_AIR}s (off air)")
    # Says whether a key is configured, never what it is. Worth a line: once the server
    # enforces keys, "no write key configured" is the whole explanation for a service that
    # connects but silently can't write.
    logger.info(f"Write key: {'configured' if WRITE_KEY else 'NOT configured'}")
    version_info = service_version_info()
    logger.info(
        f"Version: {version_info['gitShaShort'] or 'unknown'} "
        f"on {version_info['gitBranch'] or 'unknown'} "
        f"(channel {version_info['updateChannel']})"
    )

    runtime = build_runtime(
        doc_id,
        record_path=args.record,
        replay_path=args.replay,
        replay_speed=args.replay_speed,
    )

    async with anyio.create_task_group() as tg:
        tg.start_soon(runtime.run)
        tg.start_soon(signal_handler, tg.cancel_scope)


if __name__ == '__main__':
    anyio.run(main)
