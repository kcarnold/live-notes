"""Tests for the service's shared write key: reading it, and presenting it on the two
privileged calls this service makes (a full Y-Sweet token, and /api/translateItem)."""

from unittest import mock

import pytest

import proclaim_service
from slide_sync_runtime import SlideSyncRuntime
from slide_translator import SlideTranslator
from write_key import WRITE_KEY_HEADER, get_write_key, write_key_headers
from yjs_publisher import YjsSlidePublisher

from helpers import fast_timing


class TestWriteKeyHelpers:
    def test_headers_present_the_key(self):
        assert write_key_headers("SECRET123") == {WRITE_KEY_HEADER: "SECRET123"}

    def test_headers_are_empty_without_a_key(self):
        assert write_key_headers(None) == {}
        assert write_key_headers("") == {}
        assert write_key_headers("   ") == {}

    def test_headers_trim_whitespace(self):
        assert write_key_headers("  SECRET123\n") == {WRITE_KEY_HEADER: "SECRET123"}

    def test_get_write_key_reads_the_env_var(self):
        assert get_write_key({"PROCLAIM_WRITE_KEY": "SECRET123"}) == "SECRET123"
        assert get_write_key({"PROCLAIM_WRITE_KEY": "  SECRET123  "}) == "SECRET123"

    def test_get_write_key_is_none_when_unset_or_blank(self):
        assert get_write_key({}) is None
        assert get_write_key({"PROCLAIM_WRITE_KEY": ""}) is None
        assert get_write_key({"PROCLAIM_WRITE_KEY": "   "}) is None


def make_runtime(write_key):
    return SlideSyncRuntime(
        mock.Mock(),
        YjsSlidePublisher(),
        SlideTranslator(mock.AsyncMock(return_value=None), ["French"], 0.001),
        "http://localhost:8000",
        doc_id="doc-test",
        timing=fast_timing(),
        write_key=write_key,
    )


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def patched_httpx_post(module, payload):
    """Patch httpx.AsyncClient in `module` and hand back the post mock to assert on."""
    post = mock.AsyncMock(return_value=FakeResponse(payload))
    client = mock.MagicMock()
    client.__aenter__ = mock.AsyncMock(return_value=mock.Mock(post=post))
    client.__aexit__ = mock.AsyncMock(return_value=False)
    return mock.patch.object(module.httpx, "AsyncClient", return_value=client), post


@pytest.mark.anyio
class TestYSweetTokenRequest:
    async def test_sends_the_write_key_when_configured(self):
        import slide_sync_runtime

        patcher, post = patched_httpx_post(slide_sync_runtime, {"url": "ws://test"})
        with patcher:
            await make_runtime("SECRET123").get_ysweet_token()

        assert post.call_args.kwargs["headers"] == {WRITE_KEY_HEADER: "SECRET123"}
        # The doc/editor contract is unchanged by the key.
        assert post.call_args.kwargs["json"] == {"docId": "doc-test", "isEditor": True}

    async def test_sends_no_key_header_when_unconfigured(self):
        import slide_sync_runtime

        patcher, post = patched_httpx_post(slide_sync_runtime, {"url": "ws://test"})
        with patcher:
            await make_runtime(None).get_ysweet_token()

        assert post.call_args.kwargs["headers"] == {}


@pytest.mark.anyio
class TestTranslateItemRequest:
    async def test_sends_the_write_key_when_configured(self):
        patcher, post = patched_httpx_post(proclaim_service, {"translations": {}})
        translate = proclaim_service.make_translate_fn(
            "http://localhost:8000", ["French"], write_key="SECRET123"
        )
        with patcher:
            await translate(["a slide"], "Psalm 23", "item-1", None, "doc-test")

        assert post.call_args.kwargs["headers"] == {WRITE_KEY_HEADER: "SECRET123"}

    async def test_sends_no_key_header_when_unconfigured(self):
        patcher, post = patched_httpx_post(proclaim_service, {"translations": {}})
        translate = proclaim_service.make_translate_fn("http://localhost:8000", ["French"])
        with patcher:
            await translate(["a slide"], "Psalm 23", "item-1", None, "doc-test")

        assert post.call_args.kwargs["headers"] == {}
