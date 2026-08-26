/**
 * Client for the server-owned current session (#111). Server side: ../sessionRoutes.ts.
 *
 * Reading is open; pinning and clearing go through `apiFetch`, which attaches this
 * device's write key — moving an entire service to another doc is exactly as privileged
 * as taking the microphone.
 */
import { apiFetch } from './writeKey.ts';
import type { CurrentSession } from './sessionCurrent.ts';

/** One writer recently seen asking to write to some doc. Mirrors WriterSighting. */
export interface WriterSighting {
  docId: string;
  writer: string;
  at: string;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Who has recently asked to write where, alongside the current session for comparison. */
export async function fetchSessionWriters(): Promise<{
  current: CurrentSession;
  writers: WriterSighting[];
}> {
  return readJson(await apiFetch('/api/session/writers'));
}

/** Pin a doc as the current session for everyone. Needs a write key. */
export async function pinSession(docId: string): Promise<CurrentSession> {
  return readJson(
    await apiFetch('/api/session/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId, setBy: 'status-page' }),
    }),
  );
}

/** Release the pin, falling back to the service's proposal and then to the date. */
export async function clearSessionPin(): Promise<CurrentSession> {
  return readJson(await apiFetch('/api/session/pin', { method: 'DELETE' }));
}
