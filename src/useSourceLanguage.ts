// Reading side of the session's spoken language (see liveAudioConfig.ts): subscribe to
// the shared setting so the listen picker, the transcript panes and the status view all
// relabel themselves the moment the broadcaster declares what they're speaking.
//
// Separate from liveAudioConfig.ts only because that module is imported by the Node
// server, which must not pull React in.
import { useCallback, useSyncExternalStore } from 'react';
import { useMap } from '@y-sweet/react';
import {
  LIVE_AUDIO_CONFIG_KEY,
  SOURCE_LANGUAGE_FIELD,
  normalizeSourceLanguage,
} from './liveAudioConfig';

/** The BCP-47 code this session is being spoken in, live. */
export function useSourceLanguage(): string {
  const config = useMap<unknown>(LIVE_AUDIO_CONFIG_KEY);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      config.observe(onStoreChange);
      return () => { config.unobserve(onStoreChange); };
    },
    [config],
  );
  // The snapshot is a string, so it is referentially stable on its own — no memo needed.
  return useSyncExternalStore(subscribe, () =>
    normalizeSourceLanguage(config.get(SOURCE_LANGUAGE_FIELD)),
  );
}
