// F-481 §3.2、§8.4：电子签 > 设置 > 签署模板。列表 + 新建 / 编辑抽屉 + 行内启用 / 停用；不提供删除（停用即从下拉消失）。
// 写命令都经 F-123 内核 useConflictCommand：新建 POST 全量、编辑 PATCH 只发改动字段并带 If-Match（esign/routes.ts）。
import { ESIGN_TEMPLATE_VARIABLES } from '@italent/domain';
import { App, Button, Input, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { rejectionMessage, type Command } from '../foundation/client.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { createFormStore, type Values } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { changedFields } from '../foundation/forms/values.js';
import { m } from './messages.js';
import {
  BODY_MAX,
  CODE_MAX,
  ESIGN_SETTINGS_OBJECT,
  NAME_MAX,
  TEMPLATES_PATH,
  integerOf,
  parseTemplateReceipt,
  parseTemplates,
  settingsActions,
  templatePath,
  unknownVariables,
  validSortOrder,
  type TemplateRow,
} from './model.js';

type Api = ReturnType<typeof useApiClient>;
type Actions = ReturnType<typeof settingsActions>;
const t = m.templates;
// 切换菜单再回来时结果未知的命令仍锁定（同人员类别 commands.ts）。
const store = createFormStore();
const text = (value: unknown) => (value === undefined || value === null || value === '' ? m.missing : String(value));
const statusTag = (row: TemplateRow) => {
  if (row.status === undefined) return m.missing;
  const color = row.status === 'enabled' ? 'green' : undefined;
  return <Tag color={color}>{m[row.status]}</Tag>;
};
const snapshotOf = (row: TemplateRow) => ({
  id: row.id,
  revision: row.revision,
  values: { code: row.code, name: row.name, body: row.body, sortOrder: row.sortOrder, status: row.status },
});

/** 回查：没有单条读取接口，重读列表按 id 取本行（结果未知、冲突时内核调用）。 */
function useLatest(row?: TemplateRow) {
  const api = useApiClient();
  if (!row) return undefined;
  return async () => {
    const latest = parseTemplates(await api.request<unknown>(TEMPLATES_PATH)).find((item) => item.id === row.id);
    if (!latest) throw new Error(m.rowGone);
    return snapshotOf(latest);
  };
}
async function sendTemplate(api: Api, command: Command<Values>, id?: string) {
  // 新建没有版本：不带 If-Match（routes.ts POST 不读 revision）。
  const request = id ? command : { id: command.id, body: command.body };
  const raw = await api.request<unknown>(id ? templatePath(id) : TEMPLATES_PATH, {
    method: id ? 'PATCH' : 'POST',
    command: request,
  });
  return parseTemplateReceipt(raw, { id, revision: command.revision ?? 0 });
}

export function TemplatesPage() {
  return (
    <FormCommands store={store}>
      <TemplateList />
    </FormCommands>
  );
}

function TemplateList() {
  const permission = usePermissions(ESIGN_SETTINGS_OBJECT);
  const actions = settingsActions(permission.snapshot.objects[ESIGN_SETTINGS_OBJECT]);
  const read = useRead<unknown>(TEMPLATES_PATH);
  const [editing, setEditing] = useState<{ row?: TemplateRow }>();
  let rows: TemplateRow[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) rows = parseTemplates(read.data);
  } catch (cause) {
    error = cause;
  }
  const ready = !error && !read.loading;
  const rowActions = actions.edit || actions.status;
  return (
    <section className="esign-templates">
      <header className="page-heading">
        <h1>{t.title}</h1>
        {actions.create && ready && (
          <Button type="primary" onClick={() => setEditing({})}>
            {m.create}
          </Button>
        )}
      </header>
      {!!error && <PageState kind="error" error={error} retry={read.refresh} />}
      {!error && read.loading && <PageState kind="loading" />}
      {ready && (
        <Table<TemplateRow>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: t.empty }}
          columns={[
            { key: 'name', title: t.name, render: (_: unknown, row: TemplateRow) => text(row.name) },
            { key: 'code', title: t.code, render: (_: unknown, row: TemplateRow) => text(row.code) },
            { key: 'status', title: t.status, render: (_: unknown, row: TemplateRow) => statusTag(row) },
            { key: 'sortOrder', title: t.sortOrder, render: (_: unknown, row: TemplateRow) => text(row.sortOrder) },
            ...(rowActions
              ? [
                  {
                    key: 'actions',
                    title: m.actions,
                    render: (_: unknown, row: TemplateRow) => (
                      <Space size={0} wrap>
                        {actions.edit && (
                          <Button type="link" size="small" onClick={() => setEditing({ row })}>
                            {m.edit}
                          </Button>
                        )}
                        {actions.status && row.status !== undefined && (
                          <StatusAction key={`${row.id}@${row.revision}`} row={row} saved={read.refresh} />
                        )}
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {editing && (
        <TemplateForm row={editing.row} actions={actions} close={() => setEditing(undefined)} saved={read.refresh} />
      )}
    </section>
  );
}

const required = { required: true, whitespace: true, message: t.required };
/** 新建不发空顺序（后端默认）；文本框里的数字转成整数，与 input.ts 的 number 口径一致。 */
function normalize(values: Values) {
  const sortOrder = values.sortOrder;
  return { ...values, sortOrder: sortOrder === '' || sortOrder === null ? undefined : integerOf(sortOrder) };
}

/** 编码建后不可改（DEC-060）：编辑时只读展示；可用变量只读列出（domain ESIGN_TEMPLATE_VARIABLES）。 */
function templateFormFields(row: TemplateRow | undefined, actions: Actions): FormField[] {
  const access = (name: string) => ({ visible: true, editable: actions.editable(name) });
  const readonly = { visible: true, editable: false };
  return [
    { name: 'name', label: t.name, control: <Input maxLength={NAME_MAX} />, access: access('name'), rules: [required] },
    row
      ? { name: 'code', label: t.code, control: null, access: readonly }
      : {
          name: 'code',
          label: t.code,
          control: <Input maxLength={CODE_MAX} />,
          access: access('code'),
          rules: [required],
        },
    {
      name: 'body',
      label: t.body,
      control: <Input.TextArea rows={8} maxLength={BODY_MAX} />,
      access: access('body'),
      rules: [
        {
          validator: async (_rule: unknown, value: unknown) => {
            const unknown = unknownVariables(value);
            if (unknown.length) throw new Error(t.unknownVariables(unknown));
          },
        },
      ],
    },
    {
      name: 'variables',
      label: t.variables,
      control: null,
      access: readonly,
      display: (
        <Space size={[4, 4]} wrap>
          {ESIGN_TEMPLATE_VARIABLES.map((name) => (
            <Tag key={name}>{`{${name}}`}</Tag>
          ))}
        </Space>
      ),
    },
    {
      name: 'sortOrder',
      label: t.sortOrder,
      control: <Input inputMode="numeric" />,
      access: access('sortOrder'),
      rules: [
        {
          validator: async (_rule: unknown, value: unknown) => {
            // 编辑时清空顺序没有对应的补丁语义（后端只接受整数），须保留一个值。
            if (row && (value === '' || value === null || value === undefined)) throw new Error(t.required);
            if (!validSortOrder(value)) throw new Error(t.sortOrderRange);
          },
        },
      ],
    },
  ];
}

function TemplateForm(props: { row?: TemplateRow; actions: Actions; close(): void; saved(): void }) {
  const { row, actions, close, saved } = props;
  const api = useApiClient();
  const writer = useConflictCommand(
    TEMPLATES_PATH,
    row ? snapshotOf(row) : { revision: 0, values: {} },
    useLatest(row),
    row ? { action: 'edit' } : {},
  );
  const fields = templateFormFields(row, actions);
  const editable = fields.filter((item) => item.access.editable).map((item) => item.name);
  return (
    <FormOverlay
      open
      recordKey={row ? templatePath(row.id) : TEMPLATES_PATH}
      submission={writer.form}
      title={row ? t.editTitle : t.createTitle}
      initialValues={row ? snapshotOf(row).values : {}}
      groups={[{ title: t.basic, fields }]}
      onClose={() => {
        // 冲突或结果未知：刷新列表回查（DEC-067）；明确被拒的尝试不留到下次打开。
        if (writer.stale) saved();
        else if (writer.form.status === 'rejected') writer.form.clear();
        close();
      }}
      onSubmit={async (values) => {
        const body = normalize(values);
        if (row && !changedFields(body, writer.full, editable).length) return;
        await writer.run({
          values: body,
          editableFields: editable,
          send: ({ command }) => sendTemplate(api, command, row?.id),
        });
        saved();
      }}
    />
  );
}

/** 行内启用 / 停用：PATCH status 带本行版本；被拒提示原因并刷新，结果未知保持锁定并提供回查。 */
function StatusAction({ row, saved }: { row: TemplateRow; saved(): void }) {
  const api = useApiClient();
  const { message } = App.useApp();
  const writer = useConflictCommand(TEMPLATES_PATH, snapshotOf(row), useLatest(row), { action: 'status' });
  const next = row.status === 'enabled' ? 'disabled' : 'enabled';
  const run = async () => {
    try {
      await writer.run({
        values: { status: next },
        editableFields: ['status'],
        send: ({ command }) => sendTemplate(api, command, row.id),
      });
      saved();
    } catch (error) {
      if (writer.form.peek()?.status === 'unknown') return;
      void message.error(rejectionMessage(error));
      writer.form.clear();
      saved();
    }
  };
  return (
    <>
      <Button
        type="link"
        size="small"
        danger={next === 'disabled'}
        disabled={writer.form.locked || writer.invalid}
        onClick={() => void run()}
      >
        {next === 'disabled' ? m.disable : m.enable}
      </Button>
      {writer.form.status === 'unknown' && <CommandStatus submission={writer.form} labels={{ status: t.status }} />}
    </>
  );
}
