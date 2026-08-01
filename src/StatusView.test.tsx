import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
