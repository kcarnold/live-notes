import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusView } from './StatusView';

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

  it('shows the version the Proclaim service reports (#73)', () => {
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{
          proclaimService: {
            gitShaShort: 'abc1234',
            gitBranch: 'proclaim-stable',
            updatePending: false,
          },
        }}
      />,
    );
    expect(screen.getByText('abc1234 · proclaim-stable')).toBeInTheDocument();
    expect(screen.queryByText(/update pending/i)).not.toBeInTheDocument();
  });

  it('flags a pending update when the release branch has moved on (#73)', () => {
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{
          proclaimService: {
            gitShaShort: 'abc1234',
            gitBranch: 'proclaim-stable',
            updatePending: true,
          },
        }}
      />,
    );
    expect(screen.getByText(/update pending/i)).toBeInTheDocument();
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
});

describe('StatusView write key', () => {
  it('stays out of the way when the page has no way to change the key', () => {
    render(<StatusView docId="doc-2026-07-13" statusEntries={{}} />);
    expect(screen.queryByText(/write key/i)).not.toBeInTheDocument();
  });

  it('says plainly when the device has no key', () => {
    render(
      <StatusView docId="doc-2026-07-13" statusEntries={{}} onWriteKeyChange={() => {}} />,
    );
    expect(screen.getByText('No key on this device')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('shows only the tail of an installed key, never the key', () => {
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        writeKey="kZ8xQ2vLm4vt7Rb9ab12"
        onWriteKeyChange={() => {}}
      />,
    );
    expect(screen.getByText('Key installed')).toBeInTheDocument();
    expect(screen.getByText('…ab12')).toBeInTheDocument();
    expect(screen.queryByText('kZ8xQ2vLm4vt7Rb9ab12')).not.toBeInTheDocument();
  });

  it('stores a pasted key, trimmed', async () => {
    const onWriteKeyChange = vi.fn();
    const user = userEvent.setup();
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        onWriteKeyChange={onWriteKeyChange}
      />,
    );

    await user.type(screen.getByLabelText('Paste a write key'), '  NEWKEY  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onWriteKeyChange).toHaveBeenCalledWith('NEWKEY');
  });

  it('refuses to store an empty key', () => {
    const onWriteKeyChange = vi.fn();
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        onWriteKeyChange={onWriteKeyChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onWriteKeyChange).not.toHaveBeenCalled();
  });

  it('clears the key with null, so a lost device can be de-provisioned on the spot', async () => {
    const onWriteKeyChange = vi.fn();
    const user = userEvent.setup();
    render(
      <StatusView
        docId="doc-2026-07-13"
        statusEntries={{}}
        writeKey="kZ8xQ2vLm4vt7Rb9ab12"
        onWriteKeyChange={onWriteKeyChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onWriteKeyChange).toHaveBeenCalledWith(null);
  });
});

describe('current session (#111)', () => {
  const session = {
    docId: 'doc-2026-08-09',
    source: 'date' as const,
    since: null,
    setBy: null,
    expiresAt: null,
  };

  const noop = () => {};

  it('is hidden when the container passes no session', () => {
    render(<StatusView docId="doc-2026-08-09" statusEntries={{}} />);
    expect(screen.queryByText('Current session')).not.toBeInTheDocument();
  });

  it('names the doc everything is on, and where that came from', () => {
    render(
      <StatusView
        docId="doc-2026-08-09"
        statusEntries={{}}
        session={{ ...session, source: 'proposal', setBy: 'proclaim-service' }}
        onPinSession={noop}
        onClearSessionPin={noop}
      />,
    );
    // Twice: the page header names the doc this browser is on, and the section names
    // the doc the server says is current. Them agreeing is the normal case.
    expect(screen.getAllByText('doc-2026-08-09')).toHaveLength(2);
    expect(screen.getByText('Proposed by the presentation service')).toBeInTheDocument();
    expect(screen.getByText(/proclaim-service/)).toBeInTheDocument();
  });

  it('pins the doc an operator types', async () => {
    const onPinSession = vi.fn();
    render(
      <StatusView
        docId="doc-2026-08-09"
        statusEntries={{}}
        session={session}
        onPinSession={onPinSession}
        onClearSessionPin={noop}
      />,
    );
    await userEvent.type(screen.getByLabelText('doc-YYYY-MM-DD'), 'doc-2026-08-16');
    await userEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onPinSession).toHaveBeenCalledWith('doc-2026-08-16');
  });

  it('offers to clear the pin only when there is one', () => {
    const { rerender } = render(
      <StatusView
        docId="doc-2026-08-09"
        statusEntries={{}}
        session={session}
        onPinSession={noop}
        onClearSessionPin={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: /clear pin/i })).not.toBeInTheDocument();
    rerender(
      <StatusView
        docId="doc-2026-08-09"
        statusEntries={{}}
        session={{ ...session, source: 'pin', setBy: 'status-page' }}
        onPinSession={noop}
        onClearSessionPin={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /clear pin/i })).toBeInTheDocument();
  });

  it('flags a writer on a different doc — the #111 symptom, made visible', () => {
    render(
      <StatusView
        docId="doc-2026-08-09"
        statusEntries={{}}
        session={session}
        writers={[
          { writer: 'proclaim', docId: 'doc-2026-08-02', at: new Date().toISOString() },
          { writer: 'booth', docId: 'doc-2026-08-09', at: new Date().toISOString() },
        ]}
        onPinSession={noop}
        onClearSessionPin={noop}
      />,
    );
    expect(screen.getByText('writing to a different session')).toBeInTheDocument();
    expect(screen.getByText('proclaim')).toBeInTheDocument();
  });

  it('reports why a pin change failed instead of silently not changing', () => {
    render(
      <StatusView
        docId="doc-2026-08-09"
        statusEntries={{}}
        session={session}
        sessionError="Unauthorized"
        onPinSession={noop}
        onClearSessionPin={noop}
      />,
    );
    expect(screen.getByText(/Could not change the pin: Unauthorized/)).toBeInTheDocument();
  });
});
