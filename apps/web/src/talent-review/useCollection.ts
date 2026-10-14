import { useEffect, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
import type { PageResult } from '../foundation/client.js';
import { loadCollection } from './api.js';
import type { ReviewRecord } from './types.js';
export function useCollection(collection: string, allowed: boolean) {
  const api = useApiClient();
  const session = useSession();
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{ data: PageResult<ReviewRecord>; loading: boolean; error?: unknown }>({
    data: { items: [] },
    loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: { items: [] }, loading: allowed });
    if (allowed)
      void loadCollection(api, collection, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setState({ data, loading: false });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ data: { items: [] }, loading: false, error });
        });
    return () => controller.abort();
  }, [api, collection, allowed, generation, session.identityKey, session.tenantId]);
  return { ...state, refresh: () => setGeneration((x) => x + 1) };
}
