// 人员类别的写命令：新建 / 编辑表单与详情里的停用、启用、删除，全部经 F-123 内核 useConflictCommand（同离职字典）。
// 恢复槽是集合路径（新建）或集合路径 + 行 id（修改），没有单条读取接口，回查重读「全部」视图按 id 取本行。
import { Button, Input, InputNumber, Popconfirm, Space, message } from 'antd';
import type { ReactNode } from 'react';
import { rejectionMessage, type Command } from '../foundation/client.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { tenantDate } from '../foundation/dates.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import type { Values } from '../foundation/forms/store.js';
import { changedFields, projectFields } from '../foundation/forms/values.js';
import { m } from './messages.js';
import {
  NAME_MAX,
  ORDER_MAX,
  TYPES_PATH,
  listPath,
  nextOrder,
  parseReceipt,
  parseRows,
  rowPath,
  typeFields,
  type TypeRow,
  type typeActions,
} from './model.js';

type Api = ReturnType<typeof useApiClient>;
type Actions = ReturnType<typeof typeActions>;
const labels: Record<string, string> = {
  name: m.name,
  displayOrder: m.displayOrder,
  effectiveDate: m.effectiveDate,
  expiryDate: m.expiryDate,
};
const snapshotOf = (row: TypeRow) => ({ id: row.id, revision: row.revision, values: projectFields(row, typeFields) });
function useRow(row?: TypeRow) {
  const api = useApiClient();
  if (!row) return undefined;
  return async () => {
    const latest = parseRows(await api.request<unknown>(listPath('all'))).find((item) => item.id === row.id);
    if (!latest) throw new Error(m.rowGone);
    return snapshotOf(latest);
  };
}
/** 新建不发空值（失效日期不填由后端默认 9999-12-31）；修改是补丁，只发改动字段。 */
const compact = (body: Values) => Object.fromEntries(Object.entries(body).filter(([, value]) => value != null));
async function sendRow(api: Api, command: Command<Values>, id?: string) {
  const body = id ? { ...command.body } : compact(command.body);
  // F-455：编辑清空失效日期沿用数据库的无限期值；后端日期契约不接受 null。
  if (
    id &&
    Object.hasOwn(body, 'expiryDate') &&
    (body.expiryDate === null || body.expiryDate === undefined || body.expiryDate === '')
  )
    body.expiryDate = '9999-12-31';
  const raw = await api.request<unknown>(id ? rowPath(id) : TYPES_PATH, {
    method: id ? 'PUT' : 'POST',
    command: { ...command, body },
  });
  return parseReceipt(raw, { id, revision: command.revision ?? 0 });
}

export function TypeForm(props: {
  row?: TypeRow;
  rows: readonly TypeRow[];
  actions: Actions;
  close(): void;
  saved(): void;
}) {
  const { row, rows, actions, close, saved } = props;
  const api = useApiClient();
  const session = useSession();
  const writer = useConflictCommand(
    TYPES_PATH,
    row ? snapshotOf(row) : { revision: 0, values: {} },
    useRow(row),
    row ? { action: 'edit' } : {},
  );
  const field = (name: string, control: ReactNode, rules: FormField['rules'] = []): FormField => ({
    name,
    label: labels[name]!,
    control,
    access: { visible: true, editable: actions.editable(name) },
    rules,
  });
  const required = { required: true, message: m.required };
  const fields = [
    field('name', <Input maxLength={NAME_MAX} />, [{ ...required, whitespace: true }]),
    field('displayOrder', <InputNumber min={0} max={ORDER_MAX} precision={0} />, [
      { required: true, type: 'integer', min: 0, max: ORDER_MAX, message: m.orderRange },
    ]),
    field('effectiveDate', <TenantDatePicker />, [required]),
    field('expiryDate', <TenantDatePicker />),
  ];
  const editable = fields.filter((item) => item.access.editable).map((item) => item.name);
  const today = session.timezone ? tenantDate(new Date(), session.timezone) : undefined;
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row ? rowPath(row.id) : TYPES_PATH}
      submission={writer.form}
      title={`${row ? m.edit : m.create}${m.title}`}
      initialValues={row ? projectFields(row, typeFields) : { displayOrder: nextOrder(rows), effectiveDate: today }}
      groups={[{ title: m.basic, fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新列表回查（DEC-067），结果未知的命令在槽上仍锁定。
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (values) => {
        if (row && !changedFields(values, writer.full, editable).length) return;
        await writer.run({ values, editableFields: editable, send: ({ command }) => sendRow(api, command, row?.id) });
        saved();
      }}
    />
  );
}

/** 详情的停用 / 启用 / 删除：不带请求体，带本行版本；明确拒绝与冲突提示原因并刷新，结果未知保持锁定。 */
export function RowActions({
  row,
  actions,
  edit,
  saved,
}: {
  row: TypeRow;
  actions: Actions;
  edit(): void;
  saved(removed?: boolean): void;
}) {
  const api = useApiClient();
  const writer = useConflictCommand(TYPES_PATH, snapshotOf(row), useRow(row), { action: 'row' });
  const locked = writer.form.locked;
  const run = async (kind: 'disable' | 'enable' | 'remove') => {
    try {
      await writer.run({
        values: {},
        editableFields: [],
        send: async ({ command }) => {
          const remove = kind === 'remove';
          const path = remove ? rowPath(row.id) : rowPath(row.id, kind);
          const raw = await api.request(path, {
            method: remove ? 'DELETE' : 'POST',
            command: { ...command, body: {} },
          });
          return parseReceipt(raw, { id: row.id, revision: command.revision ?? 0, deleted: remove });
        },
      });
      saved(kind === 'remove');
    } catch (error) {
      if (writer.form.peek()?.status === 'unknown') return;
      void message.error(rejectionMessage(error));
      writer.form.clear();
      saved();
    }
  };
  const confirmed = (kind: 'disable' | 'enable' | 'remove', text: string) => (
    <Popconfirm
      title={m.confirmAction(text, row.name ?? '')}
      okText={m.confirm}
      cancelText={m.cancel}
      disabled={locked}
      onConfirm={() => void run(kind)}
    >
      <Button danger={kind !== 'enable'} disabled={locked}>
        {text}
      </Button>
    </Popconfirm>
  );
  return (
    <Space direction="vertical" align="end" size={0}>
      <Space>
        {actions.edit && (
          <Button type="primary" disabled={locked} onClick={edit}>
            {m.edit}
          </Button>
        )}
        {actions.disable && confirmed('disable', m.disable)}
        {actions.enable && confirmed('enable', m.enable)}
        {actions.remove && confirmed('remove', m.remove)}
      </Space>
      <CommandStatus submission={writer.form} labels={labels} />
    </Space>
  );
}
