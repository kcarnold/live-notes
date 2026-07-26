import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusView } from './StatusView';
import type { LiveAudioStatus, RoomPresenceView } from './liveAudioStatus';

const presence = (over: Partial<RoomPresenceView> = {}): RoomPresenceView => ({
  broadcasterPresent: true,
  broadcasterIdentity: 'organizer-host',
  listeners: [],
  translatorIdentities: [],
  snapshotAgeMs: 0,
  ...over,
});

const liveAudio = (over: Partial<LiveAudioStatus> = {}): LiveAudioStatus => ({
  translations: [],
  presence: presence(),
  ...over,
});

describe('StatusView', () => {
  it('renders a working export link for the session', () => {
    render(<StatusView docId="doc-2026-07-13" statusEntries={{}} />);
    const link = screen.getByRole('link', { name: /download session/i });
    expect(link).toHaveAttribute('href', '/api/session/export?doc=doc-2026-07-13');
    expect(link).toHaveAttribute('download');
  });

  it('shows skeleton health tiles and the canary placeholder (#72)', () => {
    render(<StatusView docId="doc-2026-07-13" statusEntries={{}} />);
    expect(screen.getByText('Component health')).toBeInTheDocument();
    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.getByText('Proclaim service')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet reporting').length).toBeGreaterThan(0);
    expect(screen.getByText('Preflight canary')).toBeInTheDocument();
  });

  it('reports how many components are heartbeating once the status map fills', () => {
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{ server: { uptime: 10 }, 'bridge-fr': { state: 'active' } }}
      />,
    );
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
  });

  // The point of the panel: translator and listener counts without a broadcaster page.
  it('shows listener and bridge counts from the live-audio status poll', () => {
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        liveAudioState="ok"
        liveAudio={liveAudio({
          presence: presence({
            listeners: [
              { identity: 'attendee-a', listenLanguage: 'es' },
              { identity: 'attendee-b', listenLanguage: null },
            ],
          }),
          translations: [
            { language: 'fr', translatorIdentity: 'translator-fr', status: 'active', subscriberCount: 0 },
            { language: 'es', translatorIdentity: 'translator-es', status: 'active', subscriberCount: 1 },
          ],
        })}
      />,
    );
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('2 listeners')).toBeInTheDocument();
    expect(screen.getByText('2/2 running')).toBeInTheDocument();
    expect(screen.getByText('ES')).toBeInTheDocument();
  });

  it('reads a quiet pre-service room as amber, not as an outage', () => {
    // No broadcaster and nobody listening is the normal state ten minutes before a
    // service; showing red there would train operators to ignore the panel.
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        liveAudioState="ok"
        liveAudio={liveAudio({ presence: presence({ broadcasterPresent: false }) })}
      />,
    );
    expect(screen.getByText('Not broadcasting')).toBeInTheDocument();
    expect(screen.getByText('Nobody listening')).toBeInTheDocument();
    expect(screen.getByText('Reachable')).toBeInTheDocument();
  });

  it('flags a bridge that died while the room is still live', () => {
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        liveAudioState="ok"
        liveAudio={liveAudio({
          translations: [
            { language: 'fr', translatorIdentity: 'translator-fr', status: 'active', subscriberCount: 0 },
            { language: 'es', translatorIdentity: 'translator-es', status: 'error', subscriberCount: 2 },
          ],
        })}
      />,
    );
    expect(screen.getByText('1/2 running')).toBeInTheDocument();
    expect(screen.getByText(/error/)).toBeInTheDocument();
  });

  it('separates "no LiveKit here" from "the server is down"', () => {
    // A dev machine without LiveKit must not look like a production outage.
    const { unmount } = render(
      <StatusView docId="doc-2026-07-13" statusEntries={{}} liveAudioState="unconfigured" />,
    );
    expect(screen.getAllByText('LiveKit not configured').length).toBeGreaterThan(0);
    expect(screen.getByText('Reachable')).toBeInTheDocument();
    unmount();

    render(<StatusView docId="doc-2026-07-13" statusEntries={{}} liveAudioState="error" />);
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
  });

  it('marks a stale presence snapshot rather than passing it off as live', () => {
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        liveAudioState="ok"
        liveAudio={liveAudio({ presence: presence({ snapshotAgeMs: 45_000 }) })}
      />,
    );
    expect(screen.getByText(/Presence snapshot/)).toBeInTheDocument();
  });
});
