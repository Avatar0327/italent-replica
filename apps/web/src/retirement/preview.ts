import { useEffect, useRef, useState } from 'react';
import { newCommand } from '../foundation/client.js';
import { sameValue, type Values } from '../foundation/forms/values.js';
import { useDirectApi } from '../part-time/direct-api.js';

type Preview = { path: string; input: Values; data?: Values; error?: unknown; loading?: boolean };
export function useRetirementPreview(path: string, input: Values) {
  const send = useDirectApi();
  const [result, setResult] = useState<Preview>();
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const current = result?.path === path && sameValue(result.input, input) ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: current?.loading,
    attempted: !!result,
    matches: (values: Values) => !!current?.data && sameValue(current.input, values),
    async run(values: Values) {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const request = { path, input: values };
      setResult({ ...request, loading: true });
      try {
        const data = await send(path, 'POST', newCommand(values), controller.signal);
        if (!controller.signal.aborted) setResult({ ...request, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ ...request, error });
      }
    },
  };
}
