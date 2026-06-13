"""Shared pytest setup for the Proclaim service tests.

The service module asserts ``YSWEET_URL`` at import time, so it must be set
before ``import proclaim_service``. The repo root is also added to sys.path so
the top-level module is importable regardless of where pytest is invoked from.
"""

import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("YSWEET_URL", "http://localhost:8000")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def anyio_backend():
    # Run the async tests on asyncio (the backend the service uses in production).
    return "asyncio"
