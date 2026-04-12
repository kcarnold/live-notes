#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "llm",
#   "llm-gemini",
# ]
# ///

"""
Translate clipboard text, with access to reference documents.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import List, Optional

RESOURCES_DIR = Path(
    os.environ.get(
        "TRANSLATION_RESOURCES_DIR",
        "/Users/ka37/Library/CloudStorage/Dropbox/ken/NCF/Translations and Music",
    )
)

import llm

MODEL_NAME = "gemini-3.1-pro-preview"


def _resolve_resource_file(filename: str) -> Path:
    """Resolve a file within resources and tolerate .txt/.md extension mismatches."""

    candidate_names = [filename]
    if filename.endswith(".txt"):
        candidate_names.append(filename[:-4] + ".md")
    elif filename.endswith(".md"):
        candidate_names.append(filename[:-3] + ".txt")

    root = RESOURCES_DIR.resolve()
    for candidate_name in candidate_names:
        candidate = (RESOURCES_DIR / candidate_name).resolve()
        if not (candidate == root or root in candidate.parents):
            raise ValueError(f"File must be within resources dir: {RESOURCES_DIR}")
        if candidate.exists() and candidate.is_file():
            return candidate

    raise FileNotFoundError(f"No such resource file: {filename}")


prompt = """
Context: The user often requests translations for texts to be used in a Presbyterian church setting. In that context, song lyrics are translated for reference only, not for singing.

The following reference materials are available

<index_files>
{index_files}
</index_files>

Translate the document text to {lang}. 

If a reference text IS available, use it as much as possible to preserve specific word choices and phrasing. (For example, it may be necessary to change pronouns for a collective reading, or add markers for call/response, but try to preserve the original phrasing as much as possible.) Keep this even if the reference text phrasing is a bit unusual or old-fashioned.


If a reference text is NOT available, keep the translation straightforward (simplify complex grammar without sacrificing meaning).

Output the translation in a Markdown code block. Preserve any -- lines and Verse / Chorus / Bridge as-is without translation).

<document>
{document}
</document>

"""


def get_available_indices() -> List[str]:
    """Return a list of all available index files.
    Index files are just all of the `*.index.txt` files in the RESOURCES_DIR.
    """
    if not RESOURCES_DIR.exists():
        return []
    return sorted(p.name for p in RESOURCES_DIR.glob("*.index.txt") if p.is_file())


def get_index_contents(index_filename: str) -> str:
    """
    Return the contents of the given index file as a string.

    The index file provides the line spans for sections in the reference documents.
    """
    index_path = _resolve_resource_file(index_filename)
    return index_path.read_text(encoding="utf-8")


def get_lines_from_file(filename: str, start: Optional[int] = None, end: Optional[int] = None) -> List[str]:
    """Return lines from a resource file, optionally slicing with 1-based inclusive line numbers."""
    file_path = _resolve_resource_file(filename)
    lines = file_path.read_text(encoding="utf-8").splitlines()

    if start is None and end is None:
        return lines

    if start is None:
        start = 1
    if end is None:
        end = len(lines)
    if start < 1 or end < start:
        raise ValueError("Invalid line range; expected 1-based inclusive start<=end")

    return lines[start - 1 : end]


def build_index_listing(indices: List[str]) -> str:
    """Build prompt context containing each index filename and its compact entries."""
    if not indices:
        return "(none found)"

    blocks = []
    for name in indices:
        contents = get_index_contents(name).strip()
        blocks.append(f"## {name}\n{contents}")
    return "\n\n".join(blocks)


def _make_tool_debug_hooks(enabled: bool):
    if not enabled:
        return None, None

    def before_call(tool: Optional[llm.Tool], tool_call: llm.ToolCall):
        tool_name = tool.name if tool is not None else "<unknown-tool>"
        resolved = ""
        if tool_name == "get_lines_from_file":
            filename = tool_call.arguments.get("filename")
            if isinstance(filename, str):
                try:
                    resolved_path = _resolve_resource_file(filename)
                    resolved = f" resolved={resolved_path.name}"
                except Exception:
                    resolved = ""
        print(
            f"[tool-before] name={tool_name} args={tool_call.arguments}{resolved}",
            file=sys.stderr,
        )

    def after_call(tool: llm.Tool, tool_call: llm.ToolCall, tool_result: llm.ToolResult):
        output = tool_result.output
        if isinstance(output, list):
            summary = f"list[{len(output)}]"
            if output:
                preview = str(output[0]).strip()
                if len(preview) > 120:
                    preview = preview[:117] + "..."
                summary += f" first={preview!r}"
        else:
            text = str(output)
            if len(text) > 160:
                text = text[:157] + "..."
            summary = text
        print(
            f"[tool-after] name={tool.name} args={tool_call.arguments} result={summary}",
            file=sys.stderr,
        )

    return before_call, after_call


def translate_text_with_tools(text: str, lang: str, debug_tools: bool = False) -> str:
    model = llm.get_model(MODEL_NAME)
    indices = get_available_indices()
    conversation = model.conversation(tools=[get_lines_from_file])
    before_call, after_call = _make_tool_debug_hooks(debug_tools)

    response = conversation.chain(
        prompt.format(lang=lang, index_files=build_index_listing(indices), document=text),
        before_call=before_call,
        after_call=after_call,
    )
    return response.text()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Translate text using reference indices. Input is read from stdin by default, "
            "or from --text / --filename."
        )
    )
    parser.add_argument("lang", help="Target language (for example: French, English, Portuguese)")
    parser.add_argument("--text", help="Input text to translate")
    parser.add_argument("--filename", help="Path to a file whose contents should be translated")
    parser.add_argument(
        "--debug-tools",
        action="store_true",
        help="Print tool calls and summaries so you can verify which references were retrieved",
    )
    return parser.parse_args()


def read_input_text(args: argparse.Namespace) -> str:
    if args.text is not None:
        return args.text
    if args.filename is not None:
        return Path(args.filename).read_text(encoding="utf-8")

    stdin_text = sys.stdin.read()
    if not stdin_text.strip():
        raise ValueError("No input text provided. Use stdin, --text, or --filename.")
    return stdin_text


def main() -> int:
    args = parse_args()

    if args.text is not None and args.filename is not None:
        print("Use only one of --text or --filename (or neither, to read stdin).", file=sys.stderr)
        return 2

    try:
        text = read_input_text(args)
        print(translate_text_with_tools(text, args.lang, debug_tools=args.debug_tools))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


