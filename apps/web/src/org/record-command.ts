import { useApiClient } from '../foundation/index.js';
import { messages } from '../foundation/forms/messages.js';
import type { Submission, Values } from '../foundation/forms/store.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';

interface RecordRow {
  id: string;
  revision: number;
  [field: string]: unknown;
}
/** 命令上下文（业务日期、动作）随草稿存在槽里；不在编辑字段集合内，内核不会把它放进请求体。 */
const contextField = '__context';
interface Options<T extends RecordRow, C extends Values> {
  /**
   * 内核按此键保存草稿与命令状态：编辑用原单路径、新建用集合路径（F-123 §2），
   * 不带日期、视图、动作或入口，所有入口共用一个槽（DEC-431①）。
   */
  resource: string;
  /** 本次打开时的命令上下文；槽里有未完成的命令时以槽里保存的为准。 */
  context: C;
  original?: T;
  /** 重读原单的地址；新建没有原单，结果未知时保持锁定。 */
  readPath?: (id: string, context: C) => string;
  project(row: T): Values;
}
/** 槽里还有未完成的命令（处理中、结果未知、冲突、被拒）时沿用它的上下文，换日期或动作重开不另起命令。 */
function slotContext<C extends Values>(state: Submission | undefined, opened: C) {
  const saved = state && state.status !== 'done' ? (state.values[contextField] as C | undefined) : undefined;
  return saved ?? opened;
}
/** 组织、职务写入口接 F-123 内核：锁定、命令 ID、冲突重读与回执校验都由内核负责，这里只适配 DTO。 */
export function useRecordCommand<T extends RecordRow, C extends Values>(options: Options<T, C>) {
  const { resource, original, readPath, project } = options;
  const api = useApiClient();
  const command = useCommandForm(resource);
  const context = slotContext(command.state, options.context);
  const resumed = Object.entries(context).some(([key, value]) => options.context[key] !== value);
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
      values: { ...values, [contextField]: context },
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
