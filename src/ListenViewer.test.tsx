import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListenViewer } from "./ListenViewer";

interface MockProps {
  children: React.ReactNode;
  className?: string;
  onError?: (e: Error) => void;
  onDisconnected?: () => void;
}

// Who useRemoteParticipants reports; tests set this before rendering.
const roomState = vi.hoisted(() => ({
  participants: [] as Array<{ identity: string; trackPublications: Map<string, never> }>,
}));

// What the session says the speaker is speaking. `en` is the historical default;
// a test that wants a non-English talk sets this before rendering.
const sessionState = vi.hoisted(() => ({ sourceLanguage: "en" }));

// The room's failure callbacks, captured so a test can fire the drop it is modelling,
// and a switch for making the token fetch fail the way a sleeping phone's does.
const roomCallbacks = vi.hoisted(() => ({
  onError: undefined as ((e: Error) => void) | undefined,
  onDisconnected: undefined as (() => void) | undefined,
}));
const netState = vi.hoisted(() => ({ tokenFails: false }));

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
    reconnecting: "Reconnecting",
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
    LiveKitRoom: ({ children, className, onError, onDisconnected }: MockProps) => {
      roomCallbacks.onError = onError;
      roomCallbacks.onDisconnected = onDisconnected;
      return (
        <div data-testid="livekit-room" className={className}>
          {children}
        </div>
      );
    },
    RoomAudioRenderer: () => null,
    useRoomContext: () => null,
    useRemoteParticipants: () => roomState.participants,
  };
});

// Walk the whole reconnect ladder. Each rung is scheduled by the effect that runs when
// the previous attempt fails, so the clock has to be advanced a rung at a time.
const runOutTheLadder = async () => {
  for (const rung of [1_000, 3_000, 8_000, 20_000, 30_000, 30_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(rung + 500);
    });
  }
};

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
    roomCallbacks.onError = undefined;
    roomCallbacks.onDisconnected = undefined;
    netState.tokenFails = false;
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
        if (netState.tokenFails) return Promise.reject(new Error("Failed to fetch"));
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

  it("reconnects on its own after the room drops", async () => {
    // The Android case: the phone slept, livekit-client exhausted its own reconnect
    // ladder, and the room came back Disconnected. The pane used to latch that into a
    // terminal error and stay silent until someone tapped Retry.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    roomState.participants = [participant("organizer-host")];
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());

    act(() => {
      roomCallbacks.onDisconnected?.();
    });

    // Not an error: the pane says it is working on it, and the transcript stays up.
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    expect(screen.queryByText(/live audio error/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("live-transcript")).toBeInTheDocument();

    // First rung of the ladder, and it is back — with nobody having touched the phone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByTestId("livekit-room")).toBeInTheDocument();
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
  });

  it("stops retrying once the ladder runs out, rather than hammering the server", async () => {
    // Each attempt re-requests the translator bot, so an endless ladder would hold a
    // Gemini session open for a tab nobody is watching. After the last rung the pane
    // waits for a person instead.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    roomState.participants = [participant("organizer-host")];
    netState.tokenFails = true;
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByText(/reconnecting/i)).toBeInTheDocument());

    await runOutTheLadder();
    expect(screen.getByText(/live audio error/i)).toBeInTheDocument();

    // Six automatic retries after the first failure, and then nothing.
    const attemptsAtGiveUp = translateRequests();
    expect(attemptsAtGiveUp).toBe(7);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(translateRequests()).toBe(attemptsAtGiveUp);
  });

  it("tries again when the listener comes back to the tab", async () => {
    // What actually rescues a phone that was locked for a while: the ladder has long
    // since run out, but returning to the tab means there is a network again.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    roomState.participants = [participant("organizer-host")];
    netState.tokenFails = true;
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByText(/reconnecting/i)).toBeInTheDocument());
    await runOutTheLadder();
    expect(screen.getByText(/live audio error/i)).toBeInTheDocument();

    netState.tokenFails = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByTestId("livekit-room")).toBeInTheDocument();
    expect(screen.queryByText(/live audio error/i)).not.toBeInTheDocument();
  });
});
