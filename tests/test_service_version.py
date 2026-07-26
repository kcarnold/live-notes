"""Tests for the service's self-reported version (#73).

``proclaim_service.service_version_info`` answers "which version am I, and has the
release branch moved past me?", and ``make_status_announcer`` turns that into the
``status.proclaimService`` entry the status view reads. Neither needs Proclaim,
Y-Sweet, or a real checkout: the environment and git are both injected/patched.
"""

from unittest import mock

from pycrdt import Doc, Map

import proclaim_service as ps


def test_version_info_prefers_the_launch_wrappers_environment():
    """The wrapper resolved the SHAs at launch; that beats asking git now."""
    info = ps.service_version_info({
        "PROCLAIM_SERVICE_GIT_SHA": "a" * 40,
        "PROCLAIM_SERVICE_GIT_BRANCH": "proclaim-stable",
        "PROCLAIM_UPDATE_CHANNEL": "proclaim-stable",
        "PROCLAIM_UPDATE_CHANNEL_SHA": "a" * 40,
    })

    assert info["gitSha"] == "a" * 40
    assert info["gitShaShort"] == "aaaaaaa"
    assert info["gitBranch"] == "proclaim-stable"
    assert info["updateChannel"] == "proclaim-stable"
    assert info["updatePending"] is False


def test_version_info_flags_a_pending_update():
    """A release branch that has moved past the running SHA means "restart me"."""
    info = ps.service_version_info({
        "PROCLAIM_SERVICE_GIT_SHA": "a" * 40,
        "PROCLAIM_SERVICE_GIT_BRANCH": "proclaim-stable",
        "PROCLAIM_UPDATE_CHANNEL_SHA": "b" * 40,
    })

    assert info["updatePending"] is True


def test_version_info_never_guesses_when_the_shas_are_unknown():
    """No wrapper env and no git answer: report unknown, not "update pending"."""
    with mock.patch.object(ps, "_git_output", return_value=""):
        info = ps.service_version_info({})

    assert info["gitSha"] == ""
    assert info["updatePending"] is False


def test_status_announcer_writes_version_and_identity():
    """The status map entry is what the status view reads (#72/#73)."""
    announce = ps.make_status_announcer({
        "gitSha": "a" * 40,
        "gitShaShort": "aaaaaaa",
        "gitBranch": "proclaim-stable",
        "updateChannel": "proclaim-stable",
        "channelSha": "b" * 40,
        "updatePending": True,
    })
    doc = Doc()

    announce(doc)

    entry = doc.get("status", type=Map)["proclaimService"]
    assert entry["role"] == "proclaim-service"
    assert entry["gitShaShort"] == "aaaaaaa"
    assert entry["updatePending"] is True
    assert entry["clientId"] == doc.client_id
    assert entry["startedAt"] and entry["connectedAt"]


def test_status_announcer_reannounces_onto_a_new_doc():
    """A doc rollover creates a new Doc, so each session gets its own announcement."""
    announce = ps.make_status_announcer({
        "gitSha": "a" * 40, "gitShaShort": "aaaaaaa", "gitBranch": "main",
        "updateChannel": "proclaim-stable", "channelSha": "a" * 40, "updatePending": False,
    })

    first, second = Doc(), Doc()
    announce(first)
    announce(second)

    assert first.get("status", type=Map)["proclaimService"]["clientId"] == first.client_id
    assert second.get("status", type=Map)["proclaimService"]["clientId"] == second.client_id
