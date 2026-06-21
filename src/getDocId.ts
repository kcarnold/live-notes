// Resolve the current session's Y-Sweet doc id from the URL. This is the same
// id used as the YDocProvider docId in App.tsx, and doubles as the LiveKit room
// name for live audio translation so audio rooms line up 1:1 with sessions.
const getTodayLocal = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

export function getDocId(): string {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('doc') || `doc-${getTodayLocal()}`;
}
