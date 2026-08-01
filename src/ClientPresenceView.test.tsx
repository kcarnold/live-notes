import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ClientPresenceView } from './ClientPresenceView';
import type { ClientPresence } from './presence';

function client(
  clientId: number,
  overrides: Partial<ClientPresence> = {},
): { clientId: number; presence: ClientPresence } {
  return {
    clientId,
    presence: {
      url: '/translatedText-French',
      role: 'viewer',
      device: { kind: 'phone', platform: 'iOS', browser: 'Safari' },
      locale: 'fr',
      connectedSince: Date.now(),
      ...overrides,
    },
  };
}

describe('ClientPresenceView', () => {
  it('tells the operator when nobody is publishing presence', () => {
    render(<ClientPresenceView clients={[]} />);
    expect(screen.getByText(/no clients are reporting presence/i)).toBeInTheDocument();
  });

  it('lists each connected client with its device and page', () => {
    render(<ClientPresenceView clients={[client(1), client(2, { url: '/sourceText' })]} />);
    expect(screen.getByText('/translatedText-French')).toBeInTheDocument();
    expect(screen.getByText('/sourceText')).toBeInTheDocument();
    expect(screen.getAllByText('Phone').length).toBe(2);
    expect(screen.getAllByText('iOS · Safari').length).toBe(2);
  });

  it('reports the total number of connected clients', () => {
    render(
      <ClientPresenceView clients={[client(1), client(2), client(3, { url: '/sourceText' })]} />,
    );
    expect(screen.getByText(/connected now \(3\)/i)).toBeInTheDocument();
  });

  it('groups clients on the same page together, biggest group first', () => {
    render(
      <ClientPresenceView
        clients={[client(1, { url: '/sourceText' }), client(2), client(3)]}
      />,
    );
    const groups = screen.getAllByRole('list');
    // The two-client French group sorts ahead of the single-client source group.
    expect(within(groups[0]).getAllByRole('listitem')).toHaveLength(2);
    expect(within(groups[1]).getAllByRole('listitem')).toHaveLength(1);
  });

  it('badges editors so the operator can find the note-taker', () => {
    render(
      <ClientPresenceView
        clients={[client(1, { role: 'editor', url: '/sourceText' }), client(2)]}
      />,
    );
    expect(screen.getAllByText('editor')).toHaveLength(1);
  });

  it('marks the operator’s own device', () => {
    render(<ClientPresenceView clients={[client(1), client(2)]} selfClientId={2} />);
    expect(screen.getAllByText('this device')).toHaveLength(1);
  });

  it('shows how long each client has been connected', () => {
    render(
      <ClientPresenceView
        clients={[
          client(1, { connectedSince: Date.now() - 5 * 60_000 }),
          client(2, { connectedSince: Date.now() - 2_000 }),
        ]}
      />,
    );
    expect(screen.getByText(/5 minutes ago/i)).toBeInTheDocument();
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });

  it('renders devices it cannot identify without dropping the client', () => {
    render(
      <ClientPresenceView
        clients={[client(1, { device: { kind: 'unknown', platform: '' }, locale: '' })]}
      />,
    );
    expect(screen.getByText('Unknown device')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});
