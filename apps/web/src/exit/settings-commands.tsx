// FE-R2c2b 离职设置页的共用写命令：整行表单（新增 / 编辑）与行内动作（删除、移出），全部经 F-123 内核
// useConflictCommand。恢复槽 = 集合路径（新增）或集合路径 + 行 id；动作记在槽上下文（F-147），同一行任一结果未知时
// 该行其他写入都锁定。没有单条读取接口：冲突重读整份列表（黑名单为当前页）按 id 取本行。
import { Button, Popconfirm, Space, message } from 'antd';
import type { ReactNode } from 'react';
import { useRead } from '../contracts/useRead.js';
import { rejectionMessage, type Command } from '../foundation/client.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import type { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand, type Run } from '../foundation/forms/ConflictCommands.js';
import type { Values } from '../foundation/forms/store.js';
import { changedFields } from '../foundation/forms/values.js';
import { s } from './settings-messages.js';
import { parseDeleteReceipt, rowPath, type Row } from './settings-model.js';

type Api = ReturnType<typeof useApiClient>;
type Receipt = Promise<{ id: string }>;

/** 读一份列表并严格解析；形态不对按读取失败显示，不当作空列表。 */
export function useParsed<T>(path: string | null, parse: (raw: unknown) => T) {
  const read = useRead<unknown>(path);
  let data: T | undefined;
  let error = read.error;
  try {
    if (read.data !== undefined) data = parse(read.data);
  } catch (cause) {
    error = cause;
  }
  return { data, error, loading: read.loading && !error, reload: read.refresh };
}

/** 冲突重读：重读 path 的整份列表，按 id 取本行（不在了就报“已不在列表中”）。 */
export function rowReader(
  api: Api,
  path: string,
  rows: (raw: unknown) => Row[],
  id: string,
  values: (row: Row) => Values,
) {
  return async () => {
    const latest = rows(await api.request<unknown>(path)).find((row) => row.id === id);
    if (!latest) throw new Error(s.rowGone);
    return { id, revision: latest.revision, values: values(latest) };
  };
}

export interface RecordFormProps {
  resource: string;
  title: string;
  row?: Row;
  /** 打开时的快照（编辑）或初始值（新增）。 */
  values: Values;
  read?: () => Promise<{ id: string; revision: number; values: Values }>;
  fields: FormField[];
  send(full: Values, edited: Values, command: Command<Values>): Receipt;
  close(): void;
  reload(): void;
}
/** 新增 / 编辑弹窗：只提交可编辑字段；编辑没有改动时不发请求。 */
export function RecordForm(props: RecordFormProps) {
  const { row } = props;
  const writer = useConflictCommand(
    props.resource,
    row ? { id: row.id, revision: row.revision, values: props.values } : { revision: 0, values: {} },
    props.read,
    row ? { action: 'edit' } : {},
  );
  const editable = props.fields.filter((field) => field.access.visible && field.access.editable).map((f) => f.name);
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row ? `${props.resource}/${row.id}` : props.resource}
      submission={writer.form}
      title={props.title}
      initialValues={props.values}
      groups={[{ title: props.title, fields: props.fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新列表回查（DEC-067），结果未知的命令在槽上仍锁定。
        if (writer.stale) props.reload();
        props.close();
      }}
      onSubmit={async (values) => {
        if (row && !changedFields(values, writer.full, editable).length) {
          void message.info(s.unchanged);
          return;
        }
        await writer.run({
          values,
          editableFields: editable,
          send: ({ edited, command }) => props.send(writer.full, edited, command),
        });
        props.reload();
      }}
    />
  );
}

export interface RowAction {
  label: string;
  confirm: string;
  send(command: Command<Values>): Receipt;
}
// 行内动作（删除 / 移出）：带本行版本提交。明确拒绝与版本冲突提示原因并刷新列表，按最新版本重新操作；
// 结果未知时本行锁定，由 CommandStatus 提示回查。
export function RowActions(props: {
  resource: string;
  row: Row;
  read: () => Promise<{ id: string; revision: number; values: Values }>;
  edit?: () => void;
  actions: RowAction[];
  labels: Record<string, string>;
  reload(): void;
}) {
  const { row, edit, reload } = props;
  const snapshot = { id: row.id, revision: row.revision, values: {} };
  const writer = useConflictCommand(props.resource, snapshot, props.read, { action: 'row' });
  const locked = writer.form.locked || writer.invalid;
  const run = (action: RowAction) =>
    runInline(writer, { values: {}, editableFields: [], send: ({ command }) => action.send(command) }, reload);
  return (
    <Space direction="vertical" size={0}>
      <Space size={4} wrap>
        {edit && (
          <Button type="link" disabled={locked} onClick={edit}>
            {s.edit}
          </Button>
        )}
        {props.actions.map((action) => (
          <Popconfirm
            key={action.label}
            title={action.confirm}
            okText={s.confirm}
            cancelText={s.cancel}
            disabled={locked}
            onConfirm={() => void run(action)}
          >
            <Button type="link" danger disabled={locked}>
              {action.label}
            </Button>
          </Popconfirm>
        ))}
      </Space>
      <CommandStatus submission={writer.form} labels={props.labels} />
    </Space>
  );
}

/** 行内动作 / 开关：明确拒绝与冲突提示原因并清掉，按最新版本重新操作；结果未知保持锁定；最后刷新。 */
export async function runInline(writer: ReturnType<typeof useConflictCommand>, input: Run, reload: () => void) {
  try {
    await writer.run(input);
  } catch (error) {
    if (writer.form.peek()?.status === 'unknown') return;
    void message.error(rejectionMessage(error));
    writer.form.clear();
  }
  reload();
}

/** 字段被裁剪（键缺失）或为空时显示占位；裁剪的列不参与筛选排序（列表本身不提供排序）。 */
export function cell(row: Row, field: string, format: (value: unknown) => ReactNode = String): ReactNode {
  const value = row[field];
  return value === undefined || value === null || value === '' ? s.placeholder : format(value);
}
/** 整份保存的配置表单字段：能打开表单就已核过全部字段可改。 */
export const configField =
  (labels: Record<string, string>) =>
  (name: string, control: ReactNode, rules: FormField['rules'] = []): FormField => ({
    name,
    label: labels[name]!,
    control,
    access: { visible: true, editable: true },
    rules,
  });
export const options = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).map(([value, text]) => ({ value, label: text }));
export const label = (labels: Readonly<Record<string, string>>) => (value: unknown) =>
  labels[String(value)] ?? String(value);

/** 只读字段列：被裁剪或为空时占位。 */
export const fieldColumn = (field: string, title: string, format?: (value: unknown) => ReactNode, width?: number) => ({
  key: field,
  title,
  width,
  render: (_: unknown, row: Row) => cell(row, field, format),
});

/** 整行 DELETE（带 If-Match、无请求体），回执 {id, deleted: true}。 */
export const deleteAction = (api: Api, collection: string, id: string): RowAction => ({
  label: s.remove,
  confirm: s.deleteConfirm,
  send: async (command) => {
    const raw = await api.request(rowPath(collection, id), {
      method: 'DELETE',
      command: { ...command, body: undefined },
    });
    return parseDeleteReceipt(raw, id);
  },
});

/** 配置列表（交接事项 / 自动加黑规则）的操作列：编辑 + 删除。 */
export function configOperation(props: {
  api: Api;
  collection: string;
  parse(raw: unknown): Row[];
  labels: Record<string, string>;
  edit(row: Row): void;
  reload(): void;
}) {
  const { api, collection } = props;
  return {
    key: 'operation',
    title: s.operation,
    width: 160,
    render: (_: unknown, row: Row) => (
      <RowActions
        resource={collection}
        row={row}
        read={rowReader(api, collection, props.parse, row.id, () => ({}))}
        edit={() => props.edit(row)}
        actions={[deleteAction(api, collection, row.id)]}
        labels={props.labels}
        reload={props.reload}
      />
    ),
  };
}
