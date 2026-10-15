import { useState } from 'react';
import { useApiClient } from '../foundation/index.js';
import { messages } from '../foundation/forms/messages.js';
import { slotContext, type Values } from '../foundation/forms/store.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';

interface RecordRow {
  id: string;
  revision: number;
  [field: string]: unknown;
}
interface Options<T extends RecordRow, C extends Values> {
  /**
   * 内核按此键保存草稿与命令状态：用 slotKey 组成，编辑为原单路径、新建为集合路径，
   * 不带日期、视图、动作或入口，所有入口共用一个槽（docs/08_设计/F-123 页面片接入 2；F-142）。
   */
  resource: string;
  /**
   * 本次打开时实际采用的命令上下文（如按日期编辑权归一化后的业务时点、动作）：存进内核槽（SubmitInput.context），
   * 不进请求体；槽里有未完成的命令时以槽里保存的为准，换日期或动作重开不另起命令。
   */
  context: C;
  original?: T;
  /** 重读原单的地址；新建没有原单，结果未知时保持锁定。 */
  readPath?: (id: string, context: C) => string;
  project(row: T): Values;
}
/** 组织、职务写入口接 F-123 内核：锁定、命令 ID、冲突重读与回执校验都由内核负责，这里只适配 DTO。 */
export function useRecordCommand<T extends RecordRow, C extends Values>(options: Options<T, C>) {
  const { resource, original, readPath, project } = options;
  const api = useApiClient();
  const command = useCommandForm(resource);
  const saved = slotContext<C>(command.state);
  const context = saved ?? options.context;
  // 打开时槽里已有未完成的命令，才算沿用原命令；本次打开内提交产生的状态不算。
  const [resumed] = useState(() => saved !== undefined);
  const latest = command.state?.latest;
  const current = latest ? ({ ...latest.values, id: latest.id, revision: latest.revision } as unknown as T) : original;
  const reload = readPath
    ? () =>
        command.reread(async (id) => {
          // 不给 revision 兜底：缺 revision 的回读由内核判为读取失败，表单保持锁定。
          const row = await api.request<T>(readPath(id ?? '', context));
          return { id: row.id, revision: row.revision, values: project(row) };
        })
    : undefined;
  async function save(
    values: Values,
    request: { path: string; method: 'POST' | 'PATCH'; build(body: Values, current?: T): Values },
  ) {
    const result = await command.submit({
      values,
      context,
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
  return { command: { ...command, reload }, current, save, context, resumed };
}
