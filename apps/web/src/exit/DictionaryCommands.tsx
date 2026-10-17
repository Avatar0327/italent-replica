// 离职字典的写命令：新增 / 编辑表单与行内启停、调序，全部经 F-123 内核 useConflictCommand（F-142）。
// 恢复槽是字典集合路径（新增）或集合路径 + 行 id（修改），键里不带动作；动作记在槽上下文（F-147）。
import { Button, Input, InputNumber, Popconfirm, Space, Switch, message } from 'antd';
import type { ReactNode } from 'react';
import { ApiError, rejectionMessage, type Command } from '../foundation/client.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import type { Values } from '../foundation/forms/store.js';
import { changedFields, projectFields } from '../foundation/forms/values.js';
import { m } from './messages.js';
import {
  CODE_MAX,
  NAME_MAX,
  ORDER_MAX,
  dictionaryPath,
  entryFields,
  moveTarget,
  nextOrder,
  parseEntries,
  parseEntryReceipt,
  sameCode,
  type Entry,
  type Kind,
  type WriteAccess,
} from './model.js';

type Api = ReturnType<typeof useApiClient>;
const labels: Record<string, string> = {
  code: m.code,
  name: m.name,
  enabled: m.enabled,
  displayOrder: m.displayOrder,
};
const snapshotOf = (row: Entry) => ({ id: row.id, revision: row.revision, values: projectFields(row, entryFields) });
const listOf = async (api: Api, kind: Kind) => parseEntries(await api.request<unknown>(dictionaryPath(kind)));
/** 没有单条读取接口：重读整份列表（上限 500，不分页）按 id 取本行。 */
function useRow(kind: Kind, row?: Entry) {
  const api = useApiClient();
  if (!row) return undefined;
  return async () => {
    const latest = (await listOf(api, kind)).find((entry) => entry.id === row.id);
    if (!latest) throw new Error(m.rowGone);
    return snapshotOf(latest);
  };
}
/** 回执按实际提交的版本（If-Match）核对：新增 0 → 1，修改 n → n + 1。 */
async function sendEntry(api: Api, kind: Kind, command: Command<Values>, id?: string) {
  const path = id ? `${dictionaryPath(kind)}/${encodeURIComponent(id)}` : dictionaryPath(kind);
  const raw = await api.request<unknown>(path, { method: id ? 'PUT' : 'POST', command });
  return parseEntryReceipt(raw, { id, revision: command.revision ?? 0 });
}

/**
 * 新增 409 的拒绝原因前端读不到（ApiError 不带 details.reason），重读列表按编码核对（不分大小写）：
 * 确有同编码就把原因标到编码字段，输入保留可改正重提；否则（如字典已满）按原拒绝显示。
 */
async function codeTaken(api: Api, kind: Kind, error: unknown, code: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409 || error.kind !== 'conflict') return error;
  const rows = await listOf(api, kind).catch(() => undefined);
  if (!rows?.some((row) => sameCode(row.code, code))) return error;
  const details = { message: m.codeTaken, details: { fieldErrors: { code: [m.codeTaken] } } };
  return new ApiError(error.status, error.code, error.kind, error.message, details);
}

export function DictionaryForm({
  kind,
  row,
  rows,
  access,
  close,
  reload,
}: {
  kind: Kind;
  row?: Entry;
  rows: readonly Entry[];
  access: WriteAccess;
  close(): void;
  reload(): void;
}) {
  const api = useApiClient();
  const writer = useConflictCommand(
    dictionaryPath(kind),
    row ? snapshotOf(row) : { revision: 0, values: {} },
    useRow(kind, row),
    row ? { action: 'edit' } : {},
  );
  const allowed: readonly string[] = row ? access.updateFields : access.createFields;
  const field = (name: string, control: ReactNode, rules: FormField['rules'] = []): FormField => ({
    name,
    label: labels[name]!,
    control,
    // 字典行对持任职记录查看权者整行可读；编码保存后不可改，编辑时只读。
    access: { visible: true, editable: allowed.includes(name) && !(row && name === 'code') },
    display: name === 'code' ? row?.code : undefined,
    rules,
  });
  const required = { required: true, whitespace: true, message: m.required };
  const fields = [
    field('code', <Input maxLength={CODE_MAX} placeholder={m.codeHint} />, [required]),
    field('name', <Input maxLength={NAME_MAX} />, [required]),
    field('displayOrder', <InputNumber min={0} max={ORDER_MAX} precision={0} />, [
      { required: true, type: 'integer', min: 0, max: ORDER_MAX, message: m.orderRange },
    ]),
    // 启停在列表行内操作（同合同类型）；新增时可直接设为不启用。
    ...(row ? [] : [field('enabled', <Switch aria-label={m.enabled} />)]),
  ];
  const editable = fields.filter((item) => item.access.editable).map((item) => item.name);
  const label = m.dictionaries[kind];
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row ? `${dictionaryPath(kind)}/${row.id}` : dictionaryPath(kind)}
      submission={writer.form}
      title={`${row ? m.edit : m.create}${label}`}
      initialValues={row ? projectFields(row, entryFields) : { enabled: true, displayOrder: nextOrder(rows) }}
      groups={[{ title: label, fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新列表回查（DEC-067），结果未知的命令在槽上仍锁定。
        if (writer.stale) reload();
        close();
      }}
      onSubmit={async (values) => {
        // 修改是补丁语义：没有改动不发空请求（后端要求至少一个字段）。
        if (row && !changedFields(values, writer.full, editable).length) return;
        try {
          await writer.run({
            values,
            editableFields: editable,
            send: ({ command }) => sendEntry(api, kind, command, row?.id),
          });
        } catch (error) {
          throw row ? error : await codeTaken(api, kind, error, values.code);
        }
        reload();
      }}
    />
  );
}

/**
 * 行内启停与上移 / 下移：只改本行一个字段（PUT 补丁，带本行版本）。两者同一入口，编辑表单另记动作，
 * 任一结果未知时同一行的其他写入都锁定。明确拒绝与版本冲突提示原因并刷新列表，按最新版本重新操作。
 */
export function RowCommands({
  kind,
  row,
  rows,
  index,
  access,
  edit,
  reload,
}: {
  kind: Kind;
  row: Entry;
  rows: readonly Entry[];
  index: number;
  access: WriteAccess;
  edit?: () => void;
  reload(): void;
}) {
  const api = useApiClient();
  const writer = useConflictCommand(dictionaryPath(kind), snapshotOf(row), useRow(kind, row), { action: 'row' });
  const locked = writer.form.locked;
  const run = async (values: Values) => {
    try {
      await writer.run({
        values,
        editableFields: Object.keys(values),
        send: ({ command }) => sendEntry(api, kind, command, row.id),
      });
    } catch (error) {
      if (writer.form.peek()?.status === 'unknown') return;
      void message.error(rejectionMessage(error));
      writer.form.clear();
    }
    reload();
  };
  const move = (step: -1 | 1, text: string) => {
    const target = moveTarget(rows, index, step);
    if (target === undefined) return null;
    return (
      <Button
        type="link"
        disabled={locked}
        onClick={() => (target === null ? void message.warning(m.noGap) : void run({ displayOrder: target }))}
      >
        {text}
      </Button>
    );
  };
  const toggle = row.enabled ? m.disable : m.enable;
  const can = (field: string) => (access.updateFields as readonly string[]).includes(field);
  return (
    <Space direction="vertical" size={0}>
      <Space size={4} wrap>
        {edit && (
          <Button type="link" onClick={edit}>
            {m.edit}
          </Button>
        )}
        {can('enabled') && (
          <Popconfirm
            title={m.toggleConfirm(toggle)}
            okText={m.confirm}
            cancelText={m.cancel}
            disabled={locked}
            onConfirm={() => void run({ enabled: !row.enabled })}
          >
            <Button type="link" danger={row.enabled} disabled={locked}>
              {toggle}
            </Button>
          </Popconfirm>
        )}
        {can('displayOrder') && move(-1, m.moveUp)}
        {can('displayOrder') && move(1, m.moveDown)}
      </Space>
      <CommandStatus submission={writer.form} labels={labels} />
    </Space>
  );
}
