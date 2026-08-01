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
