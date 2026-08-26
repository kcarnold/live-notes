"""Tests for the wire between the Proclaim service and the server's session endpoint (#111).

The contract being pinned down is small but load-bearing: the service sends what it *sees*
(the on-air show's date), never a doc id it decided on, and it reports back whatever the
server said — including that the server disagreed.
"""

import json

import httpx
import pytest

from session_client import ServerSessionResolver, SessionAnswer
from slide_feed import SessionInfo
from datetime import date

pytestmark = pytest.mark.anyio


def transport(handler):
    """A resolver wired to an in-memory transport, so no server is needed."""
    resolver = ServerSessionResolver("http://server", write_key="k" * 20)
    mock_transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class PatchedClient(original):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):
            kwargs['transport'] = mock_transport
            super().__init__(*args, **kwargs)

    return resolver, PatchedClient


async def test_proposes_the_show_date_and_takes_the_answer(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen['url'] = str(request.url)
        seen['body'] = json.loads(request.read())
        seen['key'] = request.headers.get('X-Write-Key')
        return httpx.Response(
            200, json={'docId': 'doc-2026-08-09', 'source': 'proposal', 'outcome': 'accepted'}
        )

    resolver, client = transport(handler)
    monkeypatch.setattr(httpx, 'AsyncClient', client)

    answer = await resolver.resolve(SessionInfo('pres-1', date(2026, 8, 9)))

    assert seen['url'] == 'http://server/api/session/propose'
    assert seen['body'] == {'sessionDate': '2026-08-09', 'setBy': 'proclaim-service'}
    assert seen['key'] == 'k' * 20
    assert answer == SessionAnswer('doc-2026-08-09', 'proposal', 'accepted')
    assert answer.followed_us


async def test_reports_a_refused_proposal_rather_than_its_own_reading(monkeypatch):
    """The #111 case. The service asked for last week; it is told today, and knows it."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={'docId': 'doc-2026-08-09', 'source': 'date', 'outcome': 'stale'}
        )

    resolver, client = transport(handler)
    monkeypatch.setattr(httpx, 'AsyncClient', client)

    answer = await resolver.resolve(SessionInfo('pres-1', date(2026, 8, 2)))

    assert answer.doc_id == 'doc-2026-08-09'
    assert answer.outcome == 'stale'
    assert not answer.followed_us


async def test_sends_a_null_date_when_the_show_has_none(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen['body'] = json.loads(request.read())
        return httpx.Response(
            200, json={'docId': 'doc-2026-08-09', 'source': 'date', 'outcome': 'no-date'}
        )

    resolver, client = transport(handler)
    monkeypatch.setattr(httpx, 'AsyncClient', client)

    await resolver.resolve(SessionInfo('pres-1', None))
    assert seen['body']['sessionDate'] is None


async def test_sends_a_null_date_when_there_is_no_session_at_all(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen['body'] = json.loads(request.read())
        return httpx.Response(200, json={'docId': 'doc-x', 'source': 'date', 'outcome': 'no-date'})

    resolver, client = transport(handler)
    monkeypatch.setattr(httpx, 'AsyncClient', client)

    await resolver.resolve(None)
    assert seen['body']['sessionDate'] is None


async def test_raises_on_a_server_error_rather_than_guessing(monkeypatch):
    """No fallback doc id lives here. An unanswerable server flows into reconnect backoff."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={'error': 'nope'})

    resolver, client = transport(handler)
    monkeypatch.setattr(httpx, 'AsyncClient', client)

    with pytest.raises(httpx.HTTPStatusError):
        await resolver.resolve(SessionInfo('pres-1', date(2026, 8, 9)))
