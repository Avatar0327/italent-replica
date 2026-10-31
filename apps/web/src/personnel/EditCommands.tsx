// F-329（DEC-705）：员工档案三类编辑入口，全部经 F-123 内核 useConflictCommand 提交，只复用既有写接口。
// 恢复槽是集合路径（新增）或集合路径 + 对象 id（修改 / 删除），未确认的命令由模块级存储 PersonnelCommands 持有：
// 员工页、实习生页都能打开档案，存储不能随所在页面根部走（第 2 轮 P2-1）。
import { Button, Drawer, Input, InputNumber, Popconfirm, Space, Switch, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { rejectionMessage, type Command } from '../foundation/client.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { useApiClient } from '../foundation/Session.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand, validObject } from '../foundation/forms/ConflictCommands.js';
import { changedFields, type Values } from '../foundation/forms/values.js';
import { RefSelect, refPaths } from '../contracts/references.js';
import { PersonnelCommands } from './commands.js';
import {
  canDeleteSubset,
  personEditable,
  personFieldKind,
  personInfoFields,
  personJobFields,
  personReceipt,
  recordBody,
  recordEditable,
  recordReceipt,
  subsetEditable,
  subsetFields,
  subsetReceipt,
} from './edit-model.js';
import { fieldValue, type Row } from './model.js';
import { ReadPanel } from './ReadPanel.js';
import { useRead } from './useRead.js';
import type { ProfileSubset } from './useSubsetAccess.js';
import { m, subsetLabels } from './messages.js';

type Api = ReturnType<typeof useApiClient>;
type Kind = ReturnType<typeof personFieldKind>;
const people = '/api/tenant/personnel/employees';
const records = '/api/tenant/employment/records';
const personPath = (id: string) => `${people}/${encodeURIComponent(id)}`;
const subsetPath = (employeeId: string, kind: ProfileSubset) => `${personPath(employeeId)}/subsets/${kind}`;
const label = (name: string) => m.editing.labels[name] ?? m.labels[name] ?? name;
const revisionOf = (command: Command<Values>) => command.revision ?? 0;
const required = [{ required: true, whitespace: true, message: m.editing.required }];
/** 引用字段沿用合同模块的候选（按服务端权限有界读取），经理选人员。 */
const references: Record<string, string> = {
  departmentId: refPaths.departmentId,
  positionId: refPaths.positionId,
  postId: refPaths.postId,
  directManagerId: refPaths.employeeId,
  dottedManagerId: refPaths.employeeId,
};

function control(name: string, kind: Kind): ReactNode {
  if (references[name]) return <RefSelect path={references[name]} ariaLabel={label(name)} />;
  if (kind === 'date') return <TenantDatePicker />;
  if (kind === 'boolean') return <Switch aria-label={label(name)} />;
  if (kind === 'integer') return <InputNumber min={0} precision={0} />;
  if (kind === 'decimal') return <InputNumber min={0} />;
  return <Input maxLength={2000} />;
}
const field = (name: string, kind: Kind, access: FormField['access'], row: Values): FormField => ({
  name,
  label: label(name),
  control: control(name, kind),
  access,
  display: fieldValue(name, row[name], 'long'),
});
/** 读回最新版本：内核核对差异后按最新版本重提（DEC-067 先回查再重提）。 */
const reader = (api: Api, path: string, values: (raw: Row) => Values) => async () => {
  const raw = await api.request<Row>(path);
  return { id: raw.id, revision: Number(raw.revision), values: values(raw) };
};
/** 行内命令（删除）：明确拒绝与冲突提示原因并刷新，结果未知时保持锁定、不刷新成功。 */
const rowFailure = (form: { peek(): { status: string } | undefined; clear(): void }, error: unknown) => {
  if (form.peek()?.status === 'unknown') return false;
  void message.error(rejectionMessage(error));
  form.clear();
  return true;
};

/** 抬头与列表行的「编辑人员」：原站同一张抽屉，分员工信息、任职信息两节。 */
export function EditPersonButton({ employeeId, saved }: { employeeId: string; saved(): void }) {
  const permission = usePermissions(PERSONNEL_OBJECT);
  const editable = personEditable(permission.snapshot.objects[PERSONNEL_OBJECT]);
  const [open, setOpen] = useState(false);
  if (!editable.length) return null;
  return (
    <>
      <Button type="link" onClick={() => setOpen(true)}>
        {m.editing.person}
      </Button>
      {open && (
        <PersonnelCommands>
          <PersonDrawer employeeId={employeeId} editable={editable} close={() => setOpen(false)} saved={saved} />
        </PersonnelCommands>
      )}
    </>
  );
}

/** 列表行只有摘要字段：打开时读详情取全量与版本，读不到就不画表单。 */
function PersonDrawer(props: { employeeId: string; editable: string[]; close(): void; saved(): void }) {
  const result = useRead<Row>(personPath(props.employeeId));
  if (!result.data || !validObject(result.data))
    return (
      <Drawer open title={m.editing.person} onClose={props.close}>
        <ReadPanel {...result}>{null}</ReadPanel>
      </Drawer>
    );
  return <PersonForm {...props} row={result.data} />;
}

function PersonForm({ row, editable, close, saved }: { row: Row; editable: string[]; close(): void; saved(): void }) {
  const api = useApiClient();
  const permission = usePermissions(PERSONNEL_OBJECT);
  const path = personPath(row.id);
  const writer = useConflictCommand(
    people,
    { id: row.id, revision: Number(row.revision), values: row },
    reader(api, path, (raw) => raw),
    { action: 'edit' },
  );
  // 只读展示取内核最新全量：409 重读核对后显示同事改后的值，不停在打开时（第 2 轮 P2-5）。
  const item = (name: string) => ({
    ...field(
      name,
      personFieldKind(name),
      { visible: permission.field(name).visible, editable: editable.includes(name) },
      writer.full,
    ),
    rules: ['name', 'email'].includes(name) ? required : undefined,
  });
  return (
    <FormOverlay
      open
      mode="drawer"
      recordKey={path}
      submission={writer.form}
      title={m.editing.person}
      initialValues={row}
      groups={[
        { title: m.employeeInfo, fields: personInfoFields.map(item) },
        { title: m.recordFields, fields: personJobFields.map(item) },
      ]}
      onClose={() => {
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (values) => {
        // 补丁语义：没有改动不发空请求。
        if (!changedFields(values, writer.full, editable).length) return;
        await writer.run({
          values,
          editableFields: editable,
          send: async ({ command }) =>
            personReceipt(await api.request(path, { method: 'PATCH', command }), {
              id: row.id,
              revision: revisionOf(command),
            }),
        });
        saved();
      }}
    />
  );
}

/** 子集分区标题栏的「新增」：要列表级 create 按钮且有可编辑字段。 */
export function SubsetCreate(props: {
  employeeId: string;
  kind: ProfileSubset;
  permission?: ObjectPermission;
  saved(): void;
}) {
  const [open, setOpen] = useState(false);
  if (!subsetEditable(props.permission, props.kind, 'create').length) return null;
  return (
    <>
      <Button type="link" size="small" onClick={() => setOpen(true)}>
        {m.editing.create}
      </Button>
      {open && (
        <PersonnelCommands>
          <SubsetForm {...props} close={() => setOpen(false)} />
        </PersonnelCommands>
      )}
    </>
  );
}

type RowProps = {
  employeeId: string;
  kind: ProfileSubset;
  permission?: ObjectPermission;
  row: Row;
  saved(): void;
};
/** 子集逐条「编辑」「删除」；本单位经历由任职同步，不能删，同步字段只读。 */
export const SubsetRowCommands = (props: RowProps) => (
  <PersonnelCommands>
    <RowCommands {...props} />
  </PersonnelCommands>
);

function RowCommands(props: RowProps) {
  const { employeeId, kind, permission, row, saved } = props;
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const path = subsetPath(employeeId, kind);
  const writer = useConflictCommand(
    path,
    { id: row.id, revision: Number(row.revision), values: row },
    reader(api, `${path}/${encodeURIComponent(row.id)}`, (raw) => raw),
    { action: 'delete' },
  );
  const editable = subsetEditable(permission, kind, 'update', row).length > 0 && validObject(row);
  const deletable = canDeleteSubset(permission, kind, row);
  if (!editable && !deletable) return null;
  const remove = async () => {
    try {
      await writer.run({
        values: {},
        editableFields: [],
        send: async ({ command }) => {
          const raw = await api.request(`${path}/${encodeURIComponent(row.id)}`, {
            method: 'DELETE',
            command: { ...command, body: {} },
          });
          return subsetReceipt(raw, { id: row.id, revision: revisionOf(command), deleted: true });
        },
      });
    } catch (error) {
      if (!rowFailure(writer.form, error)) return;
    }
    saved();
  };
  return (
    <Space direction="vertical" size={0} className="staff-subset-commands">
      <Space size={4}>
        {editable && (
          <Button type="link" size="small" onClick={() => setEditing(true)}>
            {m.editing.edit}
          </Button>
        )}
        {deletable && (
          <Popconfirm
            title={m.editing.removeConfirm(subsetLabels[kind])}
            okText={m.confirm}
            cancelText={m.cancel}
            disabled={writer.form.locked}
            onConfirm={() => void remove()}
          >
            <Button type="link" size="small" danger disabled={writer.form.locked}>
              {m.editing.remove}
            </Button>
          </Popconfirm>
        )}
      </Space>
      <CommandStatus submission={writer.form} labels={m.labels} />
      {editing && <SubsetForm {...props} close={() => setEditing(false)} />}
    </Space>
  );
}

function SubsetForm({
  employeeId,
  kind,
  permission,
  row,
  close,
  saved,
}: {
  employeeId: string;
  kind: ProfileSubset;
  permission?: ObjectPermission;
  row?: Row;
  close(): void;
  saved(): void;
}) {
  const api = useApiClient();
  const path = subsetPath(employeeId, kind);
  const target = row && `${path}/${encodeURIComponent(row.id)}`;
  const editable = subsetEditable(permission, kind, row ? 'update' : 'create', row);
  const writer = useConflictCommand(
    path,
    row ? { id: row.id, revision: Number(row.revision), values: row } : { revision: 0, values: {} },
    target ? reader(api, target, (raw) => raw) : undefined,
    row ? { action: 'edit' } : {},
  );
  const values: Values = row ?? {};
  const shown = subsetFields(kind).filter(
    (item) => !item.system && item.kind !== 'uuid' && m.labels[item.code] && (row || editable.includes(item.code)),
  );
  const fields = shown.map((item) =>
    field(
      item.code,
      item.kind,
      { visible: fieldAccess(permission, item.code).visible, editable: editable.includes(item.code) },
      writer.full,
    ),
  );
  const title = `${row ? m.editing.edit : m.editing.create}${subsetLabels[kind]}`;
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={target ?? path}
      submission={writer.form}
      title={title}
      initialValues={values}
      groups={[{ title: subsetLabels[kind], fields }]}
      onClose={() => {
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (submitted) => {
        if (row && !changedFields(submitted, writer.full, editable).length) return;
        await writer.run({
          values: submitted,
          editableFields: editable,
          send: async ({ command }) => {
            const raw = await api.request(target ?? path, { method: row ? 'PATCH' : 'POST', command });
            return subsetReceipt(raw, { id: row?.id, revision: revisionOf(command) });
          },
        });
        saved();
      }}
    />
  );
}

/** 任职记录逐条「编辑任职」：要 Employment.Edit 按钮；只改预置字段，生效日期、业务类型另走任职业务。 */
export function RecordEdit({
  record,
  permission,
  saved,
}: {
  record: Row;
  permission?: ObjectPermission;
  saved(): void;
}) {
  const [open, setOpen] = useState(false);
  const editable = recordEditable(permission, record);
  if (!editable.length) return null;
  return (
    <>
      <Button type="link" size="small" onClick={() => setOpen(true)}>
        {m.editing.job}
      </Button>
      {open && (
        <PersonnelCommands>
          <RecordForm record={record} editable={editable} close={() => setOpen(false)} saved={saved} />
        </PersonnelCommands>
      )}
    </>
  );
}

function RecordForm({
  record,
  editable,
  close,
  saved,
}: {
  record: Row;
  editable: string[];
  close(): void;
  saved(): void;
}) {
  const api = useApiClient();
  const path = `${records}/${encodeURIComponent(record.id)}`;
  const preset = (raw: Row) => ({ ...((raw.fields ?? {}) as Values) });
  const values = preset(record);
  const writer = useConflictCommand(
    records,
    { id: record.id, revision: Number(record.revision), values },
    reader(api, path, preset),
    { action: 'edit' },
  );
  const fields = editable.map((name) => field(name, undefined, { visible: true, editable: true }, writer.full));
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={path}
      submission={writer.form}
      title={m.editing.job}
      initialValues={values}
      groups={[{ title: m.recordFields, fields }]}
      onClose={() => {
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (submitted) => {
        if (!changedFields(submitted, writer.full, editable).length) return;
        await writer.run({
          values: submitted,
          editableFields: editable,
          send: async ({ command }) => {
            const raw = await api.request(path, {
              method: 'PATCH',
              command: { ...command, body: recordBody(command.body) },
            });
            return recordReceipt(raw, { id: record.id, revision: revisionOf(command) });
          },
        });
        saved();
      }}
    />
  );
}
