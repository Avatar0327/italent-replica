import { useRef } from 'react';
import { ApiError } from '../foundation/client.js';
import { m } from './messages.js';
/** 未知结果只允许先回查，不在同一表单生成新命令盲重放。 */
export function useWrite() {
  const unknown = useRef(false);
  return {
    reset: () => {
      unknown.current = false;
    },
    async run(action: () => Promise<void>) {
      if (unknown.current) throw new ApiError(0, 'UNKNOWN_RESULT', 'unknown', m.unknown);
      try {
        await action();
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'unknown') unknown.current = true;
        throw error;
      }
    },
  };
}
