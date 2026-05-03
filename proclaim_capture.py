#!/usr/bin/env python3
"""
Capture a snapshot of the current Proclaim session for offline testing.

Reads from the Proclaim local API and database, writes a JSON file compatible
with tests/conftest.py MockProclaimDB and the proclaim_snapshots/ fixtures.

Usage:
    uv run proclaim_capture.py [--output PATH]
"""

import argparse
import asyncio
import json
from datetime import date
from pathlib import Path
from typing import Any, Dict

import httpx

from proclaim_lib import ProclaimDB, find_presentation_db

PROCLAIM_BASE_URL = "http://127.0.0.1:52195"
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "tests" / "proclaim_snapshots"


async def get_session_id(client: httpx.AsyncClient) -> str:
    r = await client.get(f"{PROCLAIM_BASE_URL}/onair/session", timeout=5.0)
    r.raise_for_status()
    return r.content.decode("utf-8-sig")


async def get_onair_presentation(client: httpx.AsyncClient, session_id: str) -> Dict[str, Any]:
    r = await client.get(
        f"{PROCLAIM_BASE_URL}/presentations/onair",
        headers={"OnAirSessionId": session_id},
        timeout=5.0,
    )
    r.raise_for_status()
    return r.json()


async def get_status(client: httpx.AsyncClient, session_id: str) -> Dict[str, Any]:
    r = await client.get(
        f"{PROCLAIM_BASE_URL}/onair/statusChanged",
        headers={"OnAirSessionId": session_id},
        timeout=5.0,
    )
    if r.status_code == 404:
        return {}
    r.raise_for_status()
    return r.json()


async def capture(output_path: Path) -> None:
    db_path = find_presentation_db()
    print(f"Using database: {db_path}")
    db = ProclaimDB(db_path)

    async with httpx.AsyncClient() as client:
        session_id = await get_session_id(client)
        presentation = await get_onair_presentation(client, session_id)
        status = await get_status(client, session_id)

    service_items_meta = presentation.get("serviceItems", [])
    if not service_items_meta:
        print("No service items found in on-air presentation.")
        return

    # VirtualScreens lives in the DB presentation, not the API response.
    # Get it via the presentationId from the status response.
    presentation_id = status.get("presentationId")
    presentation_content_raw: Dict[str, Any] = {}
    if presentation_id:
        pres_data = db.get_presentation(presentation_id)
        if pres_data:
            presentation_content_raw = pres_data["content"]
            print(f"Presentation: {presentation_id}")
        else:
            print(f"WARNING: presentation {presentation_id} not found in DB")
    else:
        print("WARNING: no presentationId in status response — VirtualScreens will be empty")

    service_items = []
    for meta in service_items_meta:
        item_id = meta["id"]
        row = db.get_service_item(item_id.replace("-", ""))
        if row is None:
            print(f"  WARNING: item {item_id} not found in DB, skipping")
            continue

        content_dict = json.loads(row.get("Content", "{}"))
        service_items.append({
            "ServiceItemId": row["ServiceItemId"],
            "Title": row.get("Title", ""),
            "ServiceItemKind": row.get("ServiceItemKind", "Unknown"),
            "content_dict": content_dict,
        })
        print(f"  Captured: {row.get('Title', item_id)} ({row.get('ServiceItemKind', '?')})")

    current_status = status.get("status", {})
    print(f"Current item: {current_status.get('itemId')} slide {current_status.get('slideIndex')}")

    snapshot = {
        "date": date.today().isoformat(),
        "note": "Captured from live Proclaim session",
        "presentation_content": presentation_content_raw,
        "current_status": current_status,
        "service_items": service_items,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(snapshot, indent=2))
    print(f"\nSnapshot written to: {output_path}")
    print(f"Total items: {len(service_items)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture Proclaim session snapshot for testing")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output JSON path (default: tests/proclaim_snapshots/YYYY-MM-DD_captured.json)",
    )
    args = parser.parse_args()

    output = args.output or (DEFAULT_OUTPUT_DIR / f"{date.today().isoformat()}_captured.json")
    asyncio.run(capture(output))


if __name__ == "__main__":
    main()
