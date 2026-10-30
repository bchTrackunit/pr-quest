import { useEffect, useState } from 'react';

import type { HealthResponse } from '../shared/api.ts';
import { apiRequest } from './apiClient.ts';

export const App = () => {
  const [health, setHealth] = useState<HealthResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest('health', { params: {}, signal: controller.signal })
      .then(setHealth)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>PR Quest</h1>
      {health ? (
        <p>
          Server is up. Linear key: {health.config.linearApiKey ? 'set' : 'missing'}. Cursor key:{' '}
          {health.config.cursorApiKey ? 'set' : 'missing'}.
        </p>
      ) : (
        <p>{error ?? 'Connecting to the server...'}</p>
      )}
    </main>
  );
};
