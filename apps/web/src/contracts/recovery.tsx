// F-127b 第 3 轮（DEC-385③）：配置对象写命令的冲突恢复只走这里——确认后的基线、按 ID 重读本行、
// 业务字段差异与下一次 If-Match 同源，配置表单、行内启停 / 删除、自动续签开关、规则移序都调用它。
import { Alert, Button, Space, message } from 'antd';
import type { Command } from '../foundation/client.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useCommandForm, type CommandForm } from '../foundation/forms/useCommandForm.js';
import type { Values } from '../foundation/forms/store.js';
import { m } from './messages.js';
import { contractApi, type Config, type Row } from './model.js';

export const pick = (row: Row | undefined, keys: readonly string[], fallback: Row = {}) =>
  Object.fromEntries(keys.map((key) => [key, row?.[key] ?? fallback[key] ?? null]));

/** 重读时按 ID 找不到本行：按已删除处理，保持锁定并提示刷新列表。 */
export class RowGone extends Error {}
const readSize = 200;
// 有界查询：类型 / 规则没有单条读取接口，按 ID 翻页查找，最多 500 页。
const readPages = 500;
type Api = ReturnType<typeof useApiClient>;
export async function findRow(api: Api, list: string, id: string): Promise<Row> {
  for (let page = 1; page <= readPages; page++) {
    const { items } = await api.request<{ items: Row[] }>(`${list}?page=${page}&pageSize=${readSize}`);
    const hit = items.find((item) => item.id === id);
    if (hit) return hit;
    if (items.length < readSize) break;
  }
  throw new RowGone(m.rowGone);
}

type Target = {
  kind: Config;
  /** 类型 / 规则为行 ID，设置为租户 ID；新建时为空（没有可重读的原单）。 */
  id?: string;
  /** 页面当前数据；没有未完结命令时以它为基线。 */
  row?: Row;
  /** 参与比较的业务字段：删除也按这些字段比较，不能为空。 */
  keys: readonly string[];
  fallback?: Row;
};
type Send = (command: Command<Values>, sent: number) => Promise<{ id: string }>;

/**
 * 确认后的基线只在提交成功（clear 后回到页面数据）或用户核对差异（内核 confirm）时更新；
 * 被拒 / 未知 / 冲突时沿用上一次提交所依据的基线与版本——与内核下一次提交取的 prior 是同一份（store.submit），
 * 所以请求体、展示值和 If-Match 不会错位。
 */
export function useConfigCommand(resource: string, { kind, id, row, keys, fallback }: Target) {
  const api = useApiClient();
  const submission = useCommandForm(resource);
  const pending = submission.state && submission.state.status !== 'done' ? submission.state : undefined;
  const baseline = pending ? pending.baseline : pick(row, keys, fallback);
  const revision = pending ? pending.revision : Number(row?.revision ?? 0);
  const read = async () => {
    const latest =
      kind === 'settings' ? await api.request<Row>(contractApi.settings) : await findRow(api, contractApi[kind], id!);
    const latestId = kind === 'settings' ? latest.tenantId : latest.id;
    return { id: String(latestId), revision: Number(latest.revision), values: pick(latest, keys) };
  };
  const reload = async () => {
    await submission.reread(async () => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof RowGone) void message.warning(m.rowGone);
        throw error;
      }
    });
  };
  const submit = (input: { values: Values; editableFields: readonly string[]; patchOnly?: boolean; send: Send }) =>
    submission.submit({
      ...input,
      baseline,
      revision,
      businessId: id,
      send: (command) => input.send(command, command.revision ?? revision),
    });
  const form: CommandForm = { ...submission, reload: id ? reload : undefined };
  return { form, baseline, revision, submit };
}

/** 行内命令的状态区：内核差异 / 拒绝 / 未知，加上“本行已删除”的提示与刷新入口。 */
export function RecoveryStatus({
  form,
  labels,
  onRefresh,
}: {
  form: CommandForm;
  labels: Record<string, unknown>;
  onRefresh?: () => void;
}) {
  if (!form.state || form.state.status === 'done') return null;
  return (
    <Space direction="vertical">
      <CommandStatus submission={form} labels={labels} />
      {form.state.readError instanceof RowGone && (
        <Alert
          type="warning"
          showIcon
          message={m.rowGone}
          action={onRefresh && <Button onClick={onRefresh}>{m.refreshList}</Button>}
        />
      )}
    </Space>
  );
}
