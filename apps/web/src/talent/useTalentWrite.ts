import { useCallback, useState } from 'react';
import { request, TalentApiError } from './api.js';
import { text } from './messages.js';

export interface Write {
  readonly path: string;
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly revision: number;
  readonly body?: unknown;
}
interface Pending extends Write {
  readonly key: string;
}

/**
 * 写命令：每次提交带新的命令 ID；结果未知（5xx / 网络）时保留原命令，只允许按原 ID 重试（AGENTS §10「幂等」），
 * 服务端明确拒绝（4xx，如 revision 冲突、被引用不可删）时显示原因，由用户刷新后显式重提。
 */
export function useTalentWrite(tenantId: string, saved: () => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState<Pending | null>(null);
  const execute = async (command: Pending) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(tenantId, command.path, {
        method: command.method,
        ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
        headers: { 'if-match': String(command.revision), 'idempotency-key': command.key },
      });
      setUnknown(null);
      setNotice(command.method === 'DELETE' ? text.deleted : text.saved);
      saved();
    } catch (cause) {
      if (cause instanceof TalentApiError) {
        setUnknown(null);
        setError(cause.message);
      } else {
        setUnknown(command);
        setError(text.uncertain);
      }
    } finally {
      setBusy(false);
    }
  };
  const mutate = (command: Write) => {
    if (!busy && !unknown) void execute({ ...command, key: crypto.randomUUID() });
  };
  return {
    busy,
    notice,
    error,
    setError: useCallback((message: string) => setError(message), []),
    unknown,
    locked: busy || !!unknown,
    mutate,
    retry: () => {
      if (unknown && !busy) void execute(unknown);
    },
  };
}
export type TalentWrite = ReturnType<typeof useTalentWrite>;
