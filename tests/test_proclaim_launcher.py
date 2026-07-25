"""Tests for the Proclaim service launch wrapper (``proclaim_service_launch.sh``).

The wrapper's whole job is an invariant: *the service always starts*, and an
update that fails leaves the previously working version running. These tests set
up a throwaway git remote + checkout, put a fake ``uv`` on the wrapper's path
(one that records its arguments instead of running Python), and then break the
update in each of the ways a church Mac can break it:

- the release branch moved  -> fast-forward, then run
- the remote is unreachable -> log, run the old version anyway
- the fetch hangs forever   -> kill it at the timeout, run the old version anyway
- local uncommitted changes -> keep them, run the old version anyway
- new deps fail to install  -> roll back to the SHA that was running, then run
- auto-update turned off    -> never touch the checkout

Every case asserts the service was ultimately started.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = REPO_ROOT / 'proclaim_service_launch.sh'

pytestmark = pytest.mark.skipif(shutil.which('git') is None, reason="git is required")


def git(cwd: Path, *args: str) -> str:
    """Run git in ``cwd``, raising on failure."""
    result = subprocess.run(
        ['git', *args], cwd=cwd, capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def commit_file(repo: Path, name: str, content: str, message: str) -> str:
    (repo / name).write_text(content)
    git(repo, 'add', name)
    git(repo, 'commit', '-q', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')


@pytest.fixture
def fake_uv(tmp_path: Path) -> Path:
    """A stand-in ``uv`` that records each invocation to uv-calls.jsonl.

    ``uv sync`` can be made to fail by creating a ``fail-sync`` marker file, which
    is how the dependency-rollback path is exercised.
    """
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    uv = bin_dir / 'uv'
    uv.write_text(
        '#!/bin/bash\n'
        'printf \'{"args": "%s", "sha": "%s"}\\n\' "$*" '
        '"$(git rev-parse HEAD 2>/dev/null)" >> "$UV_CALL_LOG"\n'
        'if [ "$1" = "sync" ] && [ -f "$FAIL_SYNC_MARKER" ]; then exit 1; fi\n'
        'exit 0\n'
    )
    uv.chmod(0o755)
    return uv


@pytest.fixture
def checkout(tmp_path: Path):
    """A checkout of a local 'origin' that already has a proclaim-stable branch."""
    origin = tmp_path / 'origin'
    origin.mkdir()
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'config', 'user.email', 'test@example.com')
    git(origin, 'config', 'user.name', 'Test')
    first = commit_file(origin, 'proclaim_service.py', 'print("v1")\n', 'v1')
    git(origin, 'branch', 'proclaim-stable')

    work = tmp_path / 'work'
    git(tmp_path, 'clone', '-q', str(origin), str(work))
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'Test')
    git(work, 'checkout', '-q', 'proclaim-stable')

    # The wrapper resolves the repo from its own location, so install a copy.
    shutil.copy(LAUNCHER, work / 'proclaim_service_launch.sh')

    return {'origin': origin, 'work': work, 'first_sha': first}


def promote(origin: Path, content: str, message: str) -> str:
    """Move origin's proclaim-stable forward by one commit (a release promotion)."""
    git(origin, 'checkout', '-q', 'proclaim-stable')
    sha = commit_file(origin, 'proclaim_service.py', content, message)
    git(origin, 'checkout', '-q', 'main')
    return sha


def run_launcher(checkout, fake_uv: Path, tmp_path: Path, **env_overrides):
    """Run the wrapper with a fake uv, returning (completed process, uv calls)."""
    call_log = tmp_path / 'uv-calls.jsonl'
    env = {
        **os.environ,
        'UV_BIN': str(fake_uv),
        'UV_CALL_LOG': str(call_log),
        'FAIL_SYNC_MARKER': str(tmp_path / 'fail-sync'),
        'PROCLAIM_UPDATE_TIMEOUT': '20',
        'PROCLAIM_SYNC_TIMEOUT': '20',
        **env_overrides,
    }
    proc = subprocess.run(
        ['bash', str(checkout['work'] / 'proclaim_service_launch.sh')],
        cwd=checkout['work'],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    calls = [
        json.loads(line)
        for line in call_log.read_text().splitlines()
        if line.strip()
    ] if call_log.exists() else []
    return proc, calls


def service_run(calls):
    """The `uv run ...` call, i.e. proof the service was actually started."""
    return next((c for c in calls if c['args'].startswith('run ')), None)


def test_updates_to_release_branch_then_runs(checkout, fake_uv, tmp_path):
    new_sha = promote(checkout['origin'], 'print("v2")\n', 'v2')

    proc, calls = run_launcher(checkout, fake_uv, tmp_path)

    assert git(checkout['work'], 'rev-parse', 'HEAD') == new_sha
    assert (checkout['work'] / 'proclaim_service.py').read_text() == 'print("v2")\n'
    # New code syncs dependencies before running.
    assert any(c['args'] == 'sync' for c in calls)
    run = service_run(calls)
    assert run is not None and run['sha'] == new_sha
    assert proc.returncode == 0


def test_runs_last_version_when_remote_is_unreachable(checkout, fake_uv, tmp_path):
    promote(checkout['origin'], 'print("v2")\n', 'v2')
    # Point origin at a path that doesn't exist: fetch fails fast, no network.
    git(checkout['work'], 'remote', 'set-url', 'origin', str(tmp_path / 'gone'))

    proc, calls = run_launcher(checkout, fake_uv, tmp_path)

    assert git(checkout['work'], 'rev-parse', 'HEAD') == checkout['first_sha']
    assert service_run(calls) is not None
    assert 'running the current version' in proc.stdout


def test_local_changes_block_the_update_but_not_the_service(checkout, fake_uv, tmp_path):
    promote(checkout['origin'], 'print("v2")\n', 'v2')
    (checkout['work'] / 'proclaim_service.py').write_text('print("hand-edited")\n')

    proc, calls = run_launcher(checkout, fake_uv, tmp_path)

    assert git(checkout['work'], 'rev-parse', 'HEAD') == checkout['first_sha']
    assert (checkout['work'] / 'proclaim_service.py').read_text() == 'print("hand-edited")\n'
    assert service_run(calls) is not None
    assert proc.returncode == 0


def test_failed_dependency_sync_rolls_back_and_still_runs(checkout, fake_uv, tmp_path):
    promote(checkout['origin'], 'print("v2")\n', 'v2')
    (tmp_path / 'fail-sync').write_text('')  # every `uv sync` now fails

    proc, calls = run_launcher(checkout, fake_uv, tmp_path)

    # Rolled back to the version that was running before the update.
    assert git(checkout['work'], 'rev-parse', 'HEAD') == checkout['first_sha']
    run = service_run(calls)
    assert run is not None and run['sha'] == checkout['first_sha']
    assert 'rolling back' in proc.stdout


def test_auto_update_disabled_leaves_the_checkout_alone(checkout, fake_uv, tmp_path):
    promote(checkout['origin'], 'print("v2")\n', 'v2')

    proc, calls = run_launcher(checkout, fake_uv, tmp_path, PROCLAIM_AUTO_UPDATE='0')

    assert git(checkout['work'], 'rev-parse', 'HEAD') == checkout['first_sha']
    assert not any(c['args'] == 'sync' for c in calls)
    assert service_run(calls) is not None
    assert 'auto-update disabled' in proc.stdout


def test_exports_version_env_for_the_service(checkout, fake_uv, tmp_path):
    """The service reads these to report its version in the status map."""
    new_sha = promote(checkout['origin'], 'print("v2")\n', 'v2')

    env_dump = tmp_path / 'env.json'
    uv = fake_uv.parent / 'uv-env'
    uv.write_text(
        '#!/bin/bash\n'
        'if [ "$1" = "run" ]; then\n'
        '  python3 -c "import json,os,sys; json.dump({k: os.environ.get(k) for k in '
        '[\'PROCLAIM_SERVICE_GIT_SHA\',\'PROCLAIM_SERVICE_GIT_BRANCH\','
        '\'PROCLAIM_UPDATE_CHANNEL\',\'PROCLAIM_UPDATE_CHANNEL_SHA\']}, open(sys.argv[1], \'w\'))" '
        f'"{env_dump}"\n'
        'fi\n'
        'exit 0\n'
    )
    uv.chmod(0o755)

    run_launcher(checkout, uv, tmp_path)

    reported = json.loads(env_dump.read_text())
    assert reported['PROCLAIM_SERVICE_GIT_SHA'] == new_sha
    assert reported['PROCLAIM_SERVICE_GIT_BRANCH'] == 'proclaim-stable'
    assert reported['PROCLAIM_UPDATE_CHANNEL'] == 'proclaim-stable'
    assert reported['PROCLAIM_UPDATE_CHANNEL_SHA'] == new_sha


def test_a_hung_fetch_is_killed_and_the_service_still_starts(checkout, fake_uv, tmp_path):
    """A network black hole must not wedge the launch (macOS has no `timeout`)."""
    fake_git = tmp_path / 'bin' / 'git-hangs'
    fake_git.write_text(
        '#!/bin/bash\n'
        '# Ignore `-c key=value` options the wrapper passes before the subcommand.\n'
        'while [ "$1" = "-c" ]; do shift 2; done\n'
        'if [ "$1" = "fetch" ]; then sleep 60; exit 0; fi\n'
        'exec /usr/bin/env git "$@"\n'
    )
    fake_git.chmod(0o755)

    proc, calls = run_launcher(
        checkout, fake_uv, tmp_path, GIT_BIN=str(fake_git), PROCLAIM_UPDATE_TIMEOUT='2',
    )

    assert 'timed out after 2s' in proc.stdout
    assert service_run(calls) is not None
