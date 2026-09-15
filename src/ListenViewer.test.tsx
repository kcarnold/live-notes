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

// What the room reports about itself. The pane's status light is driven by this, so a
// test can put the room into livekit-client's own reconnecting state and check that the
// pane says so rather than showing a green dot over it.
const connState = vi.hoisted(() => ({ state: "connected" }));

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
    useConnectionState: () => connState.state,
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
    roomCallbacks.onError = undefined;
    roomCallbacks.onDisconnected = undefined;
    netState.tokenFails = false;
    connState.state = "connected";
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

  it("says the room is reconnecting rather than showing it as live", async () => {
    // livekit-client runs its own ~44s retry policy on a dropped room. While that is
    // happening there is nothing for us to do but report it: the participant list is
    // stale, so the old presence-only dot sat on green over a dead socket.
    roomState.participants = [participant("organizer-host")];
    connState.state = "reconnecting";
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByText(/reconnecting/i)).toBeInTheDocument());
    expect(screen.queryByText(/listening live/i)).not.toBeInTheDocument();
    // Not an error either — nothing is required of the listener yet.
    expect(screen.queryByText(/live audio error/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("live-transcript")).toBeInTheDocument();
  });

  it("does not re-request a bot while the room is reconnecting", async () => {
    // The backstop reads demand off the participant list, which is not trustworthy
    // mid-reconnect. Spending a Gemini session on that reading is the failure mode.
    roomState.participants = [participant("organizer-host")];
    connState.state = "reconnecting";
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByText(/reconnecting/i)).toBeInTheDocument());
    const afterConnect = translateRequests();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(translateRequests()).toBe(afterConnect);
  });

  it("shows an error and waits for a person once the room gives up", async () => {
    // Disconnected is terminal in livekit-client: it fires only after that policy has
    // been exhausted. There is no point retrying on a timer behind it.
    roomState.participants = [participant("organizer-host")];
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());
    const atDrop = translateRequests();

    act(() => {
      roomCallbacks.onDisconnected?.();
    });

    expect(screen.getByText(/live audio error/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // The transcript is unaffected: it reads Yjs, not LiveKit.
    expect(screen.getByTestId("live-transcript")).toBeInTheDocument();
    // And nothing is retried on our own initiative.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(translateRequests()).toBe(atDrop);
  });

  it("swallows the Disconnected its own teardown causes", async () => {
    // Unmounting <LiveKitRoom> calls room.disconnect(), which fires Disconnected. Left
    // uncounted for, tapping Retry would immediately re-enter the error state.
    roomState.participants = [participant("organizer-host")];
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());

    act(() => {
      roomCallbacks.onError?.(new Error("Abort handler called"));
      roomCallbacks.onDisconnected?.(); // the teardown's own event
    });
    expect(screen.getByText(/live audio error/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());
    expect(screen.queryByText(/live audio error/i)).not.toBeInTheDocument();
  });

  it("makes one fresh attempt when the listener comes back to the tab", async () => {
    // The phone was locked; the room died and livekit gave up while the timers driving
    // its retries were throttled. Returning to the tab is a person being present, so it
    // is worth one attempt with a new token and a re-requested bot.
    roomState.participants = [participant("organizer-host")];
    netState.tokenFails = true;
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByText(/live audio error/i)).toBeInTheDocument());

    netState.tokenFails = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());
    expect(screen.queryByText(/live audio error/i)).not.toBeInTheDocument();
  });

  it("leaves a healthy room alone when the tab comes back", async () => {
    // The common case by far: the listener glances at their phone and everything is
    // fine. Reconnecting on every glance would drop working audio and re-request a bot.
    roomState.participants = [participant("organizer-host")];
    render(<ListenViewer language="French" />);

    fireEvent.click(screen.getByRole("button", { name: /listen live/i }));
    await waitFor(() => expect(screen.getByTestId("livekit-room")).toBeInTheDocument());
    const settled = fetchMock.mock.calls.length;

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fetchMock.mock.calls.length).toBe(settled);
  });
});
