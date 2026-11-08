/**
 * 上传队列（设计 §5.1）：同时最多 2 张在传；单张失败可重试，重试按所处阶段走 §5.1.1 恢复协议；
 * 卸载后迟到回调不写状态（自查 6，照 account/useAvatarWriter.ts 的 live 引用），并中止在途请求。
 */
import type { AttachmentPurpose } from '@italent/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiClient } from '../Session.js';
import { newCommand } from '../client.js';
import {
  attachmentApi,
  isAbort,
  localRejection,
  purposeConfig,
  runUpload,
  viewOf,
  type AttachmentApi,
  type AttachmentView,
  type UploadOutcome,
  type UploadState,
} from './api.js';
import { attachmentText as text } from './messages.js';

const PARALLEL = 2;

export interface UploadTask {
  readonly key: string;
  readonly filename: string;
  readonly phase: 'queued' | 'running' | 'uncertain' | 'failed';
  readonly message?: string;
  /** 429：`Retry-After` 到期前重试按钮禁用（epoch 毫秒）。 */
  readonly retryAt?: number;
}

interface Live {
  mounted: boolean;
  controller: AbortController;
  readonly states: Map<string, UploadState>;
  readonly inFlight: Set<string>;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}

export interface QueueOptions {
  readonly purpose: AttachmentPurpose;
  /** 把新列表交给宿主；连续完成的多张按最新列表叠加，不丢项。 */
  readonly commit: (next: AttachmentView[]) => void;
  readonly latest: () => readonly AttachmentView[];
}

export function useUploadQueue({ purpose, latest, commit }: QueueOptions) {
  const client = useApiClient();
  const api = useMemo(() => attachmentApi(client), [client]);
  const config = purposeConfig(purpose);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const live = useLiveRef();
  const patch = useCallback(
    (key: string, next: Partial<UploadTask> | null) =>
      setTasks((list) =>
        next ? list.map((task) => (task.key === key ? { ...task, ...next } : task)) : list.filter((t) => t.key !== key),
      ),
    [],
  );
  const finish = useFinish({ live, patch, commit, latest, setNotices });
  const start = useCallback(
    async (key: string) => {
      const state = live.states.get(key);
      if (!state || live.inFlight.has(key)) return;
      live.inFlight.add(key);
      patch(key, { phase: 'running', message: undefined, retryAt: undefined });
      const outcome = await runSafely(api, state, live.controller.signal);
      live.inFlight.delete(key);
      if (live.mounted && outcome) finish(key, state, outcome);
    },
    [api, live, patch, finish],
  );
  useEffect(() => {
    const slots = PARALLEL - live.inFlight.size;
    const queued = tasks.filter((task) => task.phase === 'queued' && !live.inFlight.has(task.key));
    for (const task of queued.slice(0, Math.max(0, slots))) void start(task.key);
  }, [tasks, live, start]);

  const choose = (files: readonly File[]) => {
    if (!files.length) return;
    if (files.length > config.maxFiles - latest().length - tasks.length) return setNotices([text.tooMany]);
    const rejected: string[] = [];
    const accepted: UploadTask[] = [];
    for (const file of files) {
      const reason = localRejection(config, file);
      if (reason) rejected.push(`${file.name}：${reason}`);
      else {
        const key = crypto.randomUUID();
        live.states.set(key, { purpose, file });
        accepted.push({ key, filename: file.name, phase: 'queued' });
      }
    }
    setNotices(rejected);
    setTasks((list) => [...list, ...accepted]);
  };
  const retry = (key: string) => {
    const task = tasks.find((item) => item.key === key);
    if (!task || !['failed', 'uncertain'].includes(task.phase) || (task.retryAt ?? 0) > Date.now()) return;
    patch(key, { phase: 'queued', message: undefined });
  };
  const discard = (key: string) => {
    discardTarget(api, live.states.get(key));
    live.states.delete(key);
    patch(key, null);
  };
  const busy = tasks.some((task) => task.phase === 'queued' || task.phase === 'running');
  return { tasks, notices, busy, choose, retry, discard };
}

function useLiveRef(): Live {
  const ref = useRef<Live>({
    mounted: true,
    controller: new AbortController(),
    states: new Map(),
    inFlight: new Set(),
    timers: new Set(),
  });
  useEffect(() => {
    const live = ref.current;
    live.mounted = true;
    return () => {
      live.mounted = false;
      live.controller.abort();
      live.controller = new AbortController();
      live.inFlight.clear();
      for (const timer of live.timers) clearTimeout(timer);
      live.timers.clear();
    };
  }, []);
  return ref.current;
}

async function runSafely(api: AttachmentApi, state: UploadState, signal: AbortSignal) {
  try {
    return await runUpload(api, state, signal);
  } catch (error) {
    if (isAbort(error) || signal.aborted) return undefined;
    // 读文件或计算哈希失败（文件已被系统移走等）：本地确定失败，未发出写命令
    return { kind: 'failed', message: text.failed } satisfies UploadOutcome;
  }
}

interface FinishDeps {
  readonly live: Live;
  readonly patch: (key: string, next: Partial<UploadTask> | null) => void;
  readonly commit: (next: AttachmentView[]) => void;
  readonly latest: () => readonly AttachmentView[];
  readonly setNotices: (update: (list: string[]) => string[]) => void;
}

function useFinish({ live, patch, commit, latest, setNotices }: FinishDeps) {
  return useCallback(
    (key: string, state: UploadState, outcome: UploadOutcome) => {
      if (outcome.kind === 'done') {
        live.states.delete(key);
        patch(key, null);
        commit([...latest(), viewOf(outcome.receipt)]);
      } else if (outcome.kind === 'expired') {
        live.states.delete(key);
        patch(key, null);
        setNotices((list) => [...list, `${state.file.name}：${text.expired}`]);
      } else if (outcome.kind === 'uncertain') patch(key, { phase: 'uncertain', message: text.unknown });
      else {
        const seconds = outcome.retryAfter;
        const retryAt = seconds ? Date.now() + seconds * 1000 : undefined;
        patch(key, { phase: 'failed', message: seconds ? text.rateLimitSeconds(seconds) : outcome.message, retryAt });
        if (seconds) {
          const timer = setTimeout(() => {
            live.timers.delete(timer);
            if (live.mounted) patch(key, { retryAt: undefined });
          }, seconds * 1000);
          live.timers.add(timer);
        }
      }
    },
    [live, patch, commit, latest, setNotices],
  );
}

/**
 * 放弃一张未完成的上传：已登记的临时行尽力删除（失败不提示，24h 后由清理任务回收，§2.5）；
 * 登记结果仍未知时附件 ID 不明，同样交给清理任务。
 */
function discardTarget(api: AttachmentApi, state: UploadState | undefined) {
  if (!state?.target || state.uploadUncertain) return;
  void api.remove(state.target.id, newCommand(undefined, state.target.revision)).catch(() => undefined);
}
