import json
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

from proclaim_lib import get_translation_screen_idx

SNAPSHOTS_DIR = Path(__file__).parent / "proclaim_snapshots"


class MockProclaimDB:
    def __init__(self, data: dict):
        self._items: Dict[str, dict] = {
            item["ServiceItemId"].replace("-", ""): item
            for item in data["service_items"]
        }

    def get_service_item(self, item_id: str) -> Optional[Dict[str, Any]]:
        item = self._items.get(item_id.replace("-", ""))
        if item is None:
            return None
        result = dict(item)
        if "content_dict" in result:
            result["Content"] = json.dumps(result.pop("content_dict"))
        return result


@pytest.fixture(
    params=sorted(p for p in SNAPSHOTS_DIR.glob("*.json") if not p.stem.endswith(".expected")),
    ids=lambda p: p.stem,
)
def snapshot(request: pytest.FixtureRequest) -> dict:
    return json.loads(request.param.read_text())


@pytest.fixture
def db(snapshot: dict) -> MockProclaimDB:
    return MockProclaimDB(snapshot)


@pytest.fixture
def translation_idx(snapshot: dict) -> Optional[int]:
    return get_translation_screen_idx(snapshot["presentation_content"])


@pytest.fixture
def expected(request: pytest.FixtureRequest, snapshot: dict) -> Optional[dict]:  # noqa: ARG001
    """Load the .expected.json file for this snapshot, or None if absent."""
    param_path: Path = request.node.callspec.params["snapshot"]  # type: ignore[attr-defined]
    expected_path = param_path.with_suffix("").with_suffix(".expected.json")
    if not expected_path.exists():
        return None
    return json.loads(expected_path.read_text())
