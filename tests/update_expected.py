#!/usr/bin/env python3
"""
Regenerate .expected.json files from .json snapshot files.

Run after capturing a new snapshot or when parse output intentionally changes:
    uv run tests/update_expected.py [snapshot_stem ...]

With no arguments, updates all snapshots that lack an expected file.
Pass snapshot stems to update specific ones:
    uv run tests/update_expected.py 2026-05-02_captured
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from proclaim_lib import get_translation_screen_idx, item_to_yjs_dict, parse_item_translation
from tests.conftest import MockProclaimDB

SNAPSHOTS_DIR = Path(__file__).parent / "proclaim_snapshots"
SKIPPED_KINDS = {"Grouping"}


def build_expected(snapshot: dict) -> dict:
    db = MockProclaimDB(snapshot)
    translation_idx = get_translation_screen_idx(snapshot["presentation_content"])

    presentations = []
    for item in snapshot["service_items"]:
        if item["ServiceItemKind"] in SKIPPED_KINDS:
            continue
        result = parse_item_translation(db, item["ServiceItemId"], translation_idx)
        if result is None:
            continue
        presentations.append(item_to_yjs_dict(result))

    return {
        "status": snapshot.get("current_status"),
        "presentations": presentations,
    }


def update(path: Path, force: bool = False) -> None:
    expected_path = path.with_suffix("").with_suffix(".expected.json")
    if expected_path.exists() and not force:
        print(f"  skipping (already exists): {expected_path.name}")
        return

    print(f"Updating expected for: {path.name}")
    snapshot = json.loads(path.read_text())
    expected = build_expected(snapshot)
    expected_path.write_text(json.dumps(expected, indent=2, ensure_ascii=False))
    print(f"  wrote: {expected_path.name}")


def main() -> None:
    args = sys.argv[1:]
    force = "--force" in args
    stems = [a for a in args if not a.startswith("--")]

    if stems:
        paths = [SNAPSHOTS_DIR / f"{stem}.json" for stem in stems]
    else:
        paths = sorted(p for p in SNAPSHOTS_DIR.glob("*.json") if not p.stem.endswith(".expected"))

    for path in paths:
        update(path, force=force)


if __name__ == "__main__":
    main()
