import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListenViewer } from "./ListenViewer";

interface MockProps {
  children: React.ReactNode;
  className?: string;
}

// Who useRemoteParticipants reports; tests set this before rendering.
const roomState = vi.hoisted(() => ({
  participants: [] as Array<{ identity: string; trackPublications: Map<string, never> }>,
}));

// What the session says the speaker is speaking. `en` is the historical default;
// a test that wants a non-English talk sets this before rendering.
const sessionState = vi.hoisted(() => ({ sourceLanguage: "en" }));

vi.mock("./useSourceLanguage", () => ({
  useSourceLanguage: () => sessionState.sourceLanguage,
}));

vi.mock("./useLocale", () => ({
  LANGUAGE_BCP47: { French: "fr", English: "en" },
  useStrings: () => ({
    listenLive: "Listen Live",
    stopAudio: "Stop audio",
    liveListening: "Live listening",
    waitingForSpeaker: "Waiting for speaker",
    restartingTranslation: "Restarting translation",
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
    useRemoteParticipants: () => roomState.participants,
  };
});

const participant = (identity: string) => ({
  identity,
  trackPublications: new Map<string, never>(),
});

describe("ListenViewer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  // How many times the client has asked the server for a translator bot. Exact-path
  // match: the unsubscribe beacon and token requests must not count.
  const translateRequests = () =>
    fetchMock.mock.calls.filter(([input]) => input === "/api/livekit/translate").length;

  beforeEach(() => {
    roomState.participants = [];
    sessionState.sourceLanguage = "en";
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });

    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/livekit/translate")) {
        return Promise.resolve({
          json: () => ({
            translatorIdentity: "translator-1",
            status: "ready",
            targetLanguage: "fr",
          }),
        } as unknown as Response);
      }
      if (url.includes("/api/livekit/token")) {
        return Promise.resolve({
          json: () => ({ token: "token-123", serverUrl: "wss://example.com" }),
        } as unknown as Response);
      }
      return Promise.resolve({ json: () => ({}) } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("re-requests a missing translator while the speaker is broadcasting", async () => {
    // The self-heal loop: the server lost our bot (restart, reap, room drop) and nothing
    // server-side recreates it — the client must ask again. Speaker present, bot absent.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    roomState.participants = [participant("organizer-host")];
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());
    expect(translateRequests()).toBe(1); // the opt-in request

    // The degraded state is visible, not just silent retrying.
    expect(screen.getByText(/restarting translation/i)).toBeInTheDocument();

    // Past the grace window, the ensure loop asks the server again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    expect(translateRequests()).toBe(2);
  });

  it("does not churn against the reaper while waiting for the broadcast to start", async () => {
    // The waiting-room case (2026-07-19): pre-broadcast, the server reaps translator-less
    // sessions, so re-requesting in a loop would fight it. With no organizer in the room,
    // the ensure loop must stay quiet — it fires only once the speaker appears.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    roomState.participants = []; // nobody broadcasting yet
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());
    expect(translateRequests()).toBe(1);
    expect(screen.getByText(/waiting for speaker/i)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(translateRequests()).toBe(1); // still just the opt-in request
  });

  it("asks for no bot when the chosen language is the one being spoken", async () => {
    // "Original" is whatever the speaker is speaking, so it moves with the session:
    // in a Spanish-spoken service, choosing Spanish means hearing the speaker, not
    // paying a bot to translate Spanish into Spanish.
    sessionState.sourceLanguage = "es";
    roomState.participants = [participant("organizer-host")];
    render(<ListenViewer language="es" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());

    expect(translateRequests()).toBe(0);
    // ...and the token carries no `listen` demand for a language nobody translates.
    const tokenCall = fetchMock.mock.calls.find(([input]) => input === "/api/livekit/token");
    expect(JSON.parse((tokenCall?.[1] as RequestInit).body as string)).not.toHaveProperty(
      "listenLanguage",
    );
  });

  it("still asks for a bot when English is a target rather than the source", async () => {
    // The mirror of the case above, and the one the old hard-coded `en` got wrong:
    // with a Spanish speaker, English is an ordinary translation target.
    sessionState.sourceLanguage = "es";
    roomState.participants = [participant("organizer-host")];
    render(<ListenViewer language="en" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());

    expect(translateRequests()).toBe(1);
    const translateCall = fetchMock.mock.calls.find(
      ([input]) => input === "/api/livekit/translate",
    );
    expect(JSON.parse((translateCall?.[1] as RequestInit).body as string)).toMatchObject({
      targetLanguage: "en",
    });
  });
});
