import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  ModelImageApiError,
  modelImageRegistration,
  sendModelImageCommand,
  type ModelImageCommand,
  type ModelImageMetadata,
} from './model-image-api.js';
import { modelImageText as text } from './model-image-messages.js';
import type { ModelImageReader } from './useModelImageReader.js';
import { useTalentModelCommands } from './TalentTenantContext.js';

interface WriteState {
  readonly busy: boolean;
  readonly error: string;
  readonly notice: string;
  readonly unknown: ModelImageCommand | null;
  readonly checked: boolean;
}
const INITIAL: WriteState = { busy: false, error: '', notice: '', unknown: null, checked: false };
interface Pipeline {
  readonly tenantId: string;
  readonly live: () => boolean;
  readonly reader: ModelImageReader;
  readonly set: Dispatch<SetStateAction<WriteState>>;
  readonly saved: () => void;
  readonly remember: (command: ModelImageCommand, previous?: ModelImageCommand) => void;
  readonly settled: (command: ModelImageCommand) => void;
}

/** 每一步未知结果都保留原请求；登记重放后才进入上传，上传和删除不盲重试。 */
async function executePipeline(initial: ModelImageCommand, context: Pipeline) {
  let command = initial;
  try {
    if (command.uploadBase64 !== undefined) {
      const result = await sendModelImageCommand<{ revision: number; attachment: ModelImageMetadata }>(
        context.tenantId,
        command,
      );
      const upload: ModelImageCommand = {
        path: `${command.path}/${result.attachment.id}/upload`,
        method: 'POST',
        key: `${command.key}:upload`,
        revision: result.revision,
        body: { base64: command.uploadBase64 },
      };
      context.remember(upload, command);
      command = upload;
      if (!context.live()) return;
      context.reader.updateRevision(result.revision);
    }
    await sendModelImageCommand(context.tenantId, command);
    context.settled(command);
    if (!context.live()) return;
    context.set({ ...INITIAL, busy: true, notice: command.method === 'DELETE' ? text.deleted : text.saved });
    context.saved();
    await context.reader.load();
  } catch (cause) {
    if (cause instanceof ModelImageApiError) context.settled(command);
    if (!context.live()) return;
    const rejected = cause instanceof ModelImageApiError;
    context.set({
      ...INITIAL,
      busy: true,
      error: rejected ? cause.message : text.uncertain,
      unknown: rejected ? null : command,
    });
    // 权限拒绝意味着已显示内容也不再可信：load 同步清图与旧授权，再等待服务端重新核权。
    if (cause instanceof ModelImageApiError && [401, 403, 404].includes(cause.status)) await context.reader.load();
  } finally {
    if (context.live()) context.set((value) => ({ ...value, busy: false }));
  }
}

export function useModelImageWriter(tenantId: string, path: string, reader: ModelImageReader, saved: () => void) {
  const localCommands = useRef(new Map<string, ModelImageCommand>());
  const commands = useTalentModelCommands() ?? localCommands.current;
  const scopeKey = `${tenantId}:${path}`;
  const [state, set] = useState<WriteState>(() => {
    const unknown = commands.get(scopeKey) ?? null;
    return { ...INITIAL, unknown, error: unknown ? text.uncertain : '' };
  });
  const live = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const remember = (command: ModelImageCommand, previous?: ModelImageCommand) => {
    if (!previous || commands.get(scopeKey)?.key === previous.key) commands.set(scopeKey, command);
  };
  const settled = (command: ModelImageCommand) => {
    if (commands.get(scopeKey)?.key === command.key) commands.delete(scopeKey);
  };
  const context: Pipeline = { tenantId, reader, saved, live: () => live.current, set, remember, settled };
  const allowed = () => !working.current && !reader.reading && reader.view?.canEdit && !state.unknown;
  const run = async (command: ModelImageCommand) => {
    working.current = true;
    set((value) => ({ ...value, busy: true, error: '', notice: '' }));
    remember(command);
    await executePipeline(command, context);
    working.current = false;
  };
  const save = async (file: File) => {
    if (!allowed()) return;
    working.current = true;
    set({ ...INITIAL, busy: true });
    try {
      const command = await modelImageRegistration(file, path, reader.view!.revision);
      if (live.current) {
        remember(command);
        await executePipeline(command, context);
      }
    } catch (cause) {
      if (live.current) set({ ...INITIAL, error: cause instanceof Error ? cause.message : text.failed });
    } finally {
      working.current = false;
    }
  };
  const remove = () => {
    if (allowed()) void run({ path, method: 'DELETE', revision: reader.view!.revision, key: crypto.randomUUID() });
  };
  const refresh = async () => {
    if (working.current || reader.reading) return;
    set((value) => ({ ...value, checked: false, ...(value.unknown ? {} : { error: '', notice: '' }) }));
    const result = await reader.load();
    if (result && live.current) set((value) => ({ ...value, checked: !!value.unknown }));
  };
  const retry = () => {
    if (state.unknown && state.checked && !working.current && !reader.reading && reader.view?.canEdit)
      void run(state.unknown);
  };
  return { ...state, save, remove, refresh, retry };
}
