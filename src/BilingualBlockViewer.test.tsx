import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BilingualBlockViewer } from "./BilingualBlockViewer";
import type { Block } from "./blockTypes";
import { createBlock, createSequentialPositions } from "./blockTypes";
import type { UseTTSResult } from "./useTTS";
import * as useTTSModule from "./useTTS";

vi.mock("./useTTS");
// Pass translation text through unchanged so getByText() works
vi.mock("snarkdown", () => ({ default: (text: string) => text }));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build an array of blocks with sequential fractional-index positions. */
function makeBlocks(
	contents: string[],
	type: Block["type"] = "bullet",
): Block[] {
	const positions = createSequentialPositions(contents.length);
	return contents.map((content, i) =>
		createBlock(content, type, 0, positions[i]),
	);
}

/**
 * Build the translations Map for a set of blocks.
 * Each block's translation defaults to `"${language}: ${content}"` —
 * distinct enough to tell original from translation in the DOM.
 * Pass `overrides` to use a specific translated string for a given source.
 */
function makeTranslations(
	blocks: Block[],
	language: string,
	overrides: Record<string, string> = {},
): Map<string, string> {
	return new Map(
		blocks.map((block) => [
			`${language}:${block.content.trim()}`,
			overrides[block.content] ?? `${language}: ${block.content}`,
		]),
	);
}

/** Translated text that makeTranslations produces for a block with the given content. */
function tr(language: string, content: string): string {
	return `${language}: ${content}`;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const FRENCH = "French";

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("BilingualBlockViewer", () => {
	let mockTTS: UseTTSResult;

	beforeEach(() => {
		mockTTS = {
			status: "idle",
			currentText: null,
			speak: vi.fn(),
			cancel: vi.fn(),
		};
		vi.mocked(useTTSModule.useTTS).mockReturnValue(mockTTS);
	});

	// ── Rendering ────────────────────────────────────────────────────────────────

	describe("rendering", () => {
		it("shows translated text for each block", () => {
			const blocks = makeBlocks(["Hello", "World"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			expect(screen.getByText(tr(FRENCH, "Hello"))).toBeInTheDocument();
			expect(screen.getByText(tr(FRENCH, "World"))).toBeInTheDocument();
		});

		it("shows original text alongside translation by default", () => {
			const blocks = makeBlocks(["Hello"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			expect(screen.getByText("Hello")).toBeInTheDocument();
			expect(screen.getByText(tr(FRENCH, "Hello"))).toBeInTheDocument();
		});

		it("hides original text when showOriginal is false", () => {
			const blocks = makeBlocks(["Hello"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
					showOriginal={false}
				/>,
			);

			expect(screen.queryByText("Hello")).not.toBeInTheDocument();
			expect(screen.getByText(tr(FRENCH, "Hello"))).toBeInTheDocument();
		});

		it("shows auto-speak button for TTS-enabled languages", () => {
			const blocks = makeBlocks(["Hello"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			expect(
				screen.getByRole("button", { name: /auto text-to-speech/i }),
			).toBeInTheDocument();
		});

		it("does not show auto-speak button for non-TTS languages", () => {
			const blocks = makeBlocks(["Hello"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, "German")}
					language="German"
				/>,
			);

			expect(
				screen.queryByRole("button", { name: /auto text-to-speech/i }),
			).not.toBeInTheDocument();
		});

		it("shows error message when TTS errors", () => {
			mockTTS.status = "error";
			mockTTS.errorMessage = "Network error";
			const blocks = makeBlocks(["Hello"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			expect(screen.getByText(/Network error/)).toBeInTheDocument();
		});

		it("skips blocks that have no translation", () => {
			const blocks = makeBlocks(["Hello"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={new Map()}
					language={FRENCH}
				/>,
			);

			expect(screen.queryByText("Hello")).not.toBeInTheDocument();
			expect(screen.queryByText(tr(FRENCH, "Hello"))).not.toBeInTheDocument();
		});

		it("renders indented bullet blocks with paddingLeft inline style", () => {
			const positions = createSequentialPositions(2);
			const blocks = [
				createBlock("Top level", "bullet", 0, positions[0]),
				createBlock("Indented", "bullet", 2, positions[1]),
			];
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			// Top-level block (level 0) should have no paddingLeft style at all
			const topEl = screen.getByText(tr(FRENCH, "Top level")).closest("[style*='padding']");
			expect(topEl).toBeNull();

			// Indented block (level 2) should have paddingLeft: 24px (2 * 12)
			const indentedEl = screen.getByText(tr(FRENCH, "Indented")).closest("[style*='padding']");
			expect(indentedEl).toHaveStyle("padding-left: 24px");
		});

		it("does not indent heading blocks regardless of level", () => {
			const positions = createSequentialPositions(1);
			const blocks = [createBlock("A Heading", "heading", 2, positions[0])];
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			// Heading blocks should not have any padding-left style
			const headingEl = screen.getByText(tr(FRENCH, "A Heading")).closest("[style*='padding']");
			expect(headingEl).toBeNull();
		});
	});

	// ── Manual playback ───────────────────────────────────────────────────────────

	describe("manual playback", () => {
		it("speaks the translation when a block is clicked", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Hello", "World", "Goodbye"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			await user.click(screen.getByText(tr(FRENCH, "World")));

			expect(mockTTS.speak).toHaveBeenCalledWith(tr(FRENCH, "World"), FRENCH);
		});

		it("cancels when clicking the currently playing block", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Hello", "World"]);
			mockTTS.status = "playing";
			mockTTS.currentText = tr(FRENCH, "World");
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			await user.click(screen.getByText(tr(FRENCH, "World")));

			expect(mockTTS.cancel).toHaveBeenCalled();
		});

		it("does not speak when the language has no TTS support", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Hello"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, "German")}
					language="German"
				/>,
			);

			await user.click(screen.getByText(tr("German", "Hello")));

			expect(mockTTS.speak).not.toHaveBeenCalled();
		});
	});

	// ── Auto-play mode ────────────────────────────────────────────────────────────

	describe("auto-play mode", () => {
		it("starts playing the first block when auto-speak is enabled", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Line 1", "Line 2", "Line 3"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);

			await waitFor(() => {
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 1"),
					FRENCH,
				);
			});
		});

		it("plays the next block when the current one finishes", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Line 1", "Line 2", "Line 3"]);
			const translations = makeTranslations(blocks, FRENCH);

			let onFinished: ((text: string) => void) | undefined;
			vi.mocked(useTTSModule.useTTS).mockImplementation((opts) => {
				onFinished = opts?.onFinished;
				return mockTTS;
			});

			const { rerender } = render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);
			await waitFor(() =>
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 1"),
					FRENCH,
				),
			);

			mockTTS.status = "idle";
			onFinished?.(tr(FRENCH, "Line 1"));
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await waitFor(() => {
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 2"),
					FRENCH,
				);
			});
		});

		it("does not auto-play when auto-speak is off (default)", () => {
			const blocks = makeBlocks(["Line 1", "Line 2"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			expect(mockTTS.speak).not.toHaveBeenCalled();
		});

		it("does not start new playback when TTS is already busy", async () => {
			const user = userEvent.setup();
			mockTTS.status = "playing";
			const blocks = makeBlocks(["Line 1", "Line 2"]);
			render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={makeTranslations(blocks, FRENCH)}
					language={FRENCH}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);

			expect(mockTTS.speak).not.toHaveBeenCalled();
		});
	});

	// ── Playhead ──────────────────────────────────────────────────────────────────

	describe("playhead", () => {
		it("marks the last finished block with a green border", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Line 1", "Line 2", "Line 3"]);
			const translations = makeTranslations(blocks, FRENCH);

			let onFinished: ((text: string) => void) | undefined;
			vi.mocked(useTTSModule.useTTS).mockImplementation((opts) => {
				onFinished = opts?.onFinished;
				return mockTTS;
			});

			const { rerender } = render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);
			await waitFor(() =>
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 1"),
					FRENCH,
				),
			);

			mockTTS.status = "idle";
			onFinished?.(tr(FRENCH, "Line 1"));
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await waitFor(() => {
				const blockEl = screen
					.getByText(tr(FRENCH, "Line 1"))
					.closest('[class*="border-green-500"]');
				expect(blockEl).toBeInTheDocument();
			});
		});

		it("continues from the correct position when new blocks are added mid-playback", async () => {
			const user = userEvent.setup();
			let blocks = makeBlocks(["Line 1", "Line 2"]);
			let translations = makeTranslations(blocks, FRENCH);

			let onFinished: ((text: string) => void) | undefined;
			vi.mocked(useTTSModule.useTTS).mockImplementation((opts) => {
				onFinished = opts?.onFinished;
				return mockTTS;
			});

			const { rerender } = render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);
			await waitFor(() =>
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 1"),
					FRENCH,
				),
			);

			// Line 1 finishes → Line 2 starts
			mockTTS.status = "idle";
			onFinished?.(tr(FRENCH, "Line 1"));
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);
			await waitFor(() =>
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 2"),
					FRENCH,
				),
			);

			// Two new blocks arrive while Line 2 is playing
			blocks = makeBlocks(["Line 1", "Line 2", "Line 3", "Line 4"]);
			translations = makeTranslations(blocks, FRENCH);
			mockTTS.status = "playing";
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			// Line 2 finishes → should play Line 3, not restart from Line 1
			mockTTS.status = "idle";
			onFinished?.(tr(FRENCH, "Line 2"));
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await waitFor(() => {
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 3"),
					FRENCH,
				);
			});
		});
	});

	// ── Toggle auto-speak during playback ─────────────────────────────────────────

	describe("toggling auto-speak", () => {
		it("stops auto-playing when toggled off", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Line 1", "Line 2", "Line 3"]);
			const translations = makeTranslations(blocks, FRENCH);

			let onFinished: ((text: string) => void) | undefined;
			vi.mocked(useTTSModule.useTTS).mockImplementation((opts) => {
				onFinished = opts?.onFinished;
				return mockTTS;
			});

			const { rerender } = render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);
			await waitFor(() =>
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 1"),
					FRENCH,
				),
			);

			// Disable while Line 1 is still playing
			mockTTS.status = "playing";
			await user.click(
				screen.getByRole("button", { name: /disable auto text-to-speech/i }),
			);

			// Line 1 finishes — Line 2 should NOT start
			mockTTS.status = "idle";
			onFinished?.(tr(FRENCH, "Line 1"));
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			expect(mockTTS.speak).toHaveBeenCalledTimes(1);
			expect(mockTTS.speak).not.toHaveBeenCalledWith(
				tr(FRENCH, "Line 2"),
				FRENCH,
			);
		});

		it("resumes from playhead + 1 when re-enabled", async () => {
			const user = userEvent.setup();
			const blocks = makeBlocks(["Line 1", "Line 2", "Line 3"]);
			const translations = makeTranslations(blocks, FRENCH);

			let onFinished: ((text: string) => void) | undefined;
			vi.mocked(useTTSModule.useTTS).mockImplementation((opts) => {
				onFinished = opts?.onFinished;
				return mockTTS;
			});

			const { rerender } = render(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			// Enable → Line 1 plays, then Line 2
			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);
			await waitFor(() =>
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 1"),
					FRENCH,
				),
			);
			mockTTS.status = "idle";
			onFinished?.(tr(FRENCH, "Line 1"));
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);
			await waitFor(() =>
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 2"),
					FRENCH,
				),
			);

			// Disable, then finish Line 2 (playhead lands on index 1)
			await user.click(
				screen.getByRole("button", { name: /disable auto text-to-speech/i }),
			);
			mockTTS.status = "idle";
			onFinished?.(tr(FRENCH, "Line 2"));
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			// Re-enable → should resume at Line 3
			await user.click(
				screen.getByRole("button", { name: /enable auto text-to-speech/i }),
			);
			rerender(
				<BilingualBlockViewer
					blocks={blocks}
					translations={translations}
					language={FRENCH}
				/>,
			);

			await waitFor(() => {
				expect(mockTTS.speak).toHaveBeenCalledWith(
					tr(FRENCH, "Line 3"),
					FRENCH,
				);
			});
		});
	});
});
