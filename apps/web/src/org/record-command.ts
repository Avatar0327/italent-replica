import { useApiClient } from '../foundation/index.js';
import { messages } from '../foundation/forms/messages.js';
import type { Values } from '../foundation/forms/store.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';

interface RecordRow {
  id: string;
  revision: number;
  [field: string]: unknown;
}
interface Options<T extends RecordRow> {
  /** 内核按此键保存草稿与命令状态；行内与详情入口须给同一个键（DEC-431①）。 */
  resource: string;
  original?: T;
  /** 重读原单的地址；新建没有原单，结果未知时保持锁定。 */
  readPath?: (id: string) => string;
  project(row: T): Values;
}
/** 组织、职务写入口接 F-123 内核：锁定、命令 ID、冲突重读与回执校验都由内核负责，这里只适配 DTO。 */
export function useRecordCommand<T extends RecordRow>({ resource, original, readPath, project }: Options<T>) {
  const api = useApiClient();
  const command = useCommandForm(resource);
  const latest = command.state?.latest;
  const current = latest ? ({ ...latest.values, id: latest.id, revision: latest.revision } as unknown as T) : original;
  const reload = readPath
    ? () =>
        command.reread(async (id) => {
          // 不给 revision 兜底：缺 revision 的回读由内核判为读取失败，表单保持锁定。
          const row = await api.request<T>(readPath(id ?? ''));
          return { id: row.id, revision: row.revision, values: project(row) };
        })
    : undefined;
  async function save(
    values: Values,
    request: { path: string; method: 'POST' | 'PATCH'; build(body: Values, current?: T): Values },
  ) {
    const result = await command.submit({
      values,
      baseline: original ? project(original) : {},
      editableFields: Object.keys(values),
      revision: original?.revision ?? 0,
      businessId: original?.id,
      patchOnly: !!original,
      send: (sent) =>
        api.request<{ id: string }>(request.path, {
          method: request.method,
          command: { ...sent, body: request.build(sent.body, current) },
        }),
    });
    if (result.status !== 'done') throw result.error ?? new Error(messages.unknown);
  }
  return { command: { ...command, reload }, current, save };
}
