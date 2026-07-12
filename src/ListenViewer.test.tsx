import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListenViewer } from "./ListenViewer";

interface MockProps {
  children: React.ReactNode;
  className?: string;
}

vi.mock("./useLocale", () => ({
  LANGUAGE_BCP47: { French: "fr", English: "en" },
  useStrings: () => ({
    listenLive: "Listen Live",
    stopAudio: "Stop audio",
    liveListening: "Live listening",
    waitingForSpeaker: "Waiting for speaker",
    retry: "Retry",
    connecting: "Connecting",
    liveAudioError: "Live audio error",
    waitingForSpeech: "Waiting for speech",
  }),
}));

vi.mock("./LiveTranscript", () => ({
  LiveTranscript: ({ langCode }: { langCode: string }) => (
    <div data-testid="live-transcript">{langCode}</div>
  ),
}));

vi.mock("./getDocId", () => ({
  getDocId: () => "doc-test",
}));

vi.mock("@livekit/components-react", () => {
  return {
    LiveKitRoom: ({ children, className }: MockProps) => (
      <div data-testid="livekit-room" className={className}>
        {children}
      </div>
    ),
    RoomAudioRenderer: () => null,
    useRoomContext: () => null,
    useRemoteParticipants: () => [],
  };
});

describe("ListenViewer", () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/livekit/translate")) {
        return Promise.resolve({
          json: () => ({
            translatorIdentity: "translator-1",
            status: "ready",
            targetLanguage: "fr",
          }),
        } as Response);
      }
      if (url.includes("/api/livekit/token")) {
        return Promise.resolve({
          json:  () => ({ token: "token-123", serverUrl: "wss://example.com" }),
        } as Response);
      }
      return Promise.resolve({ json: () => ({}) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("keeps the LiveKit room from forcing the whole pane to full height", async () => {
    const user = userEvent.setup();
    render(<ListenViewer language="fr" />);

    await user.click(screen.getByRole("button", { name: /listen live/i }));

    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());

    expect(screen.getByTestId("livekit-room")).toHaveClass("w-full");
    expect(screen.getByTestId("livekit-room")).toHaveClass("shrink-0");
    expect(screen.getByTestId("livekit-room")).toHaveClass("h-auto");
  });
});
