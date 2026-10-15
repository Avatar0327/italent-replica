import { Input, Select } from 'antd';
import { useCallback, type ReactNode } from 'react';
import type { FormItemProps } from 'antd';
import { CreateEntry } from '../evaluation/CreateEntry.js';
import { RemoteSelect, useRead } from '../evaluation/runtime.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { PersonSelect, TenantDatePicker } from '../foundation/selectors.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { s } from './messages.js';
import { BASE, createRecordBody, END_RECEIPT, endCommand, endReceipt, recordDateErrors } from './rules.js';
import type { ListResult, ReadinessRef, RecordView, SuccessionType } from './types.js';

export const RECORD = 'Succession.Record';
const RECORDS = `${BASE}/records`;
const EDITABLE = ['readinessId', 'startDate', 'endDate'];
export const targetPaths = { position: '/api/tenant/job/positions', org: '/api/tenant/org/organizations' };

function dateRule(
  field: 'startDate' | 'endDate',
  today: string | undefined,
): NonNullable<FormItemProps['rules']>[number] {
  return ({ getFieldValue }) => ({
    validator: () => {
      const key = recordDateErrors({ startDate: getFieldValue('startDate'), endDate: getFieldValue('endDate') }, today)[
        field
      ];
      return key ? Promise.reject(new Error(s.errors[key])) : Promise.resolve();
    },
  });
}
const required = { required: true, message: s.required };
const blank = (value: unknown) => (value === undefined || value === '' ? null : value);
// 清空的可空字段要显式发 null，否则 JSON 会丢掉 undefined，服务端以为没改。
const NULLABLE = ['readinessId', 'endDate'];
const trimmed = (body: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      NULLABLE.includes(key) ? blank(typeof value === 'string' ? value.trim() : value) : value,
    ]),
  );

/** 继任者候选人搜索：表单与列表筛选共用。 */
export function useCandidateLoader() {
  const api = useApiClient();
  return useCallback(
    async (query: string, signal: AbortSignal) => {
      const q = encodeURIComponent(query.trim().slice(0, 50));
      const result = await api.request<{ items: { employeeId: string; name: string }[] }>(
        `${BASE}/successor-candidates?q=${q}&limit=30`,
        { signal },
      );
      return result.items.map((item) => ({ value: item.employeeId, label: item.name }));
    },
    [api],
  );
}

/**
 * 原站新增表单没有后备类型和结束原因（UI2 对照，docs/02_业务建模/27 新增组织继任字段）：
 * 后备类型取服务端默认，结束原因只在批量结束里填。
 */
function useControls(type: SuccessionType): Record<string, ReactNode> {
  const readiness = useRead<ListResult<ReadinessRef>>(`${BASE}/readiness`);
  const loadCandidates = useCandidateLoader();
  return {
    targetId: <RemoteSelect path={targetPaths[type]} label={target(type)} />,
    successor: <PersonSelect load={loadCandidates} />,
    readinessId: (
      <Select
        allowClear
        aria-label={s.fields.readiness}
        loading={readiness.loading}
        options={(readiness.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))}
      />
    ),
    startDate: <TenantDatePicker />,
    endDate: <TenantDatePicker />,
  };
}
const target = (type: SuccessionType) => (type === 'position' ? s.fields.targetPosition : s.fields.orgName);

export function RecordForm(props: { type: SuccessionType; row?: RecordView; close(): void; saved(): void }) {
  const form = <RecordEditor {...props} />;
  return props.row ? (
    form
  ) : (
    <CreateEntry path={RECORDS} title={s.createTitle[props.type]!} close={props.close}>
      {form}
    </CreateEntry>
  );
}
/** 记录表单字段：按 Succession.Record 字段权限渲染；目标与继任者建后只读并回显名称。 */
function useRecordFields(type: SuccessionType, row: RecordView | undefined, today: string | undefined) {
  const permission = usePermissions(RECORD);
  const controls = useControls(type);
  const access = (name: string) => {
    const code = {
      targetId: type === 'position' ? 'targetPositionId' : 'targetOrgId',
      successor: 'successorEmployeeId',
    };
    const field = permission.field(code[name as keyof typeof code] ?? name);
    // 目标与继任者建后不可改（FIELD_IMMUTABLE）。
    return row && !EDITABLE.includes(name) ? { ...field, editable: false } : field;
  };
  const labels: Record<string, string> = {
    targetId: target(type),
    successor: s.fields.successor,
    readinessId: s.fields.readiness,
    startDate: s.fields.startDate,
    endDate: s.fields.endDate,
  };
  const rules: Record<string, FormField['rules']> = {
    targetId: [required],
    successor: [required],
    startDate: [required, dateRule('startDate', today)],
    endDate: [dateRule('endDate', today)],
  };
  // 建后不可改的两个关系字段只读时回显名称。
  const display: Record<string, string | undefined> = { successor: row?.successor?.name, targetId: targetName(row) };
  return Object.entries(controls).map(([name, control]): FormField => ({
    name,
    label: labels[name]!,
    control,
    access: access(name),
    rules: rules[name],
    display: display[name],
  }));
}

function RecordEditor({
  type,
  row,
  close,
  saved,
}: {
  type: SuccessionType;
  row?: RecordView;
  close(): void;
  saved(): void;
}) {
  const api = useApiClient();
  const { today } = useSession();
  const writer = useConflictCommand(
    RECORDS,
    row ? { id: row.id, revision: row.revision, values: { ...row } } : { revision: 0, values: {} },
    async () => {
      const latest = await api.request<RecordView>(`${RECORDS}/${row!.id}`);
      return { id: latest.id, revision: latest.revision, values: { ...latest } };
    },
  );
  const fields = useRecordFields(type, row, today);
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row?.id ?? `new-${type}`}
      submission={writer.form}
      title={row ? s.editTitle : s.createTitle[type]!}
      initialValues={row ? { ...row } : { startDate: today }}
      groups={[{ title: s.basic, fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新列表回查，重开即按新版本解锁。
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (values) => {
        await writer.run({
          values,
          editableFields: fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name),
          send: ({ edited, command }) =>
            row
              ? api.request<RecordView>(`${RECORDS}/${row.id}`, {
                  method: 'PUT',
                  command: { ...command, body: trimmed(edited) },
                })
              : api.request<RecordView>(RECORDS, {
                  method: 'POST',
                  command: { ...command, body: createRecordBody(type, edited) },
                }),
        });
        saved();
      }}
    />
  );
}
export const targetName = (row?: RecordView) => row?.targetPosition?.name ?? row?.targetOrg?.name;

/**
 * SC-R3 批量结束：一个命令整体成功或失败；结束日期同样不得晚于今天（服务端复核）。
 * 编辑权只看 editableFields；回执是 {items}，按提交的记录逐条核对（rules.ts endReceipt）。
 * 冲突（某条已被改）两种恢复：弹窗内重读逐条记录、核对后按最新版本提交；或关闭（列表随之刷新）后重新选择。
 * 命令键由所选记录及其版本组成，重选后拿到新版本即是新键，不会被上一次的冲突锁住；
 * 结果未知时逐条钉住，重选含其中任一条仍是原命令（conflict.tsx）。
 */
export function EndForm({ rows, close, saved }: { rows: RecordView[]; close(): void; saved(): void }) {
  const permission = usePermissions(RECORD);
  const api = useApiClient();
  const { today } = useSession();
  const writer = useConflictCommand(
    `${RECORDS}/end`,
    { id: END_RECEIPT, revision: 0, values: { rows }, objects: rows },
    async () => {
      const fresh = await Promise.all(rows.map((row) => api.request<RecordView>(`${RECORDS}/${row.id}`)));
      return { id: END_RECEIPT, revision: 0, values: { rows: fresh } };
    },
  );
  const field = (name: string, control: ReactNode, rules: FormField['rules']): FormField => ({
    name,
    label: name === 'endDate' ? s.endFormDate : s.fields.endReason,
    control,
    access: permission.field(name),
    display: name === 'endDate' ? today : undefined,
    rules,
  });
  const fields = [
    field('endDate', <TenantDatePicker />, [
      required,
      {
        validator: (_, value) =>
          today && value > today ? Promise.reject(new Error(s.errors.endFuture)) : Promise.resolve(),
      },
    ]),
    field('endReason', <Input maxLength={200} />, []),
  ];
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey="end"
      submission={writer.form}
      title={s.end}
      initialValues={{ endDate: today }}
      groups={[{ title: s.endHint, fields }]}
      onClose={() => {
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (values) => {
        const editableFields = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
        // 结束日期是必填项：不可编辑时整单不能提交，不拿“可见”当可编辑。
        if (!editableFields.includes('endDate')) throw new Error(s.errors.readonly);
        // 先在本地组装（未选在用记录、超上限即时报错），再交给命令；重读核对后 full 是逐条读回的最新记录。
        const body = endBody(writer.full.rows as RecordView[], values);
        await writer.run({
          values,
          editableFields,
          send: async ({ command }) =>
            endReceipt(
              await api.request(`${RECORDS}/end`, { method: 'POST', command: { ...command, body } }),
              body.items,
            ),
        });
        saved();
      }}
    />
  );
}

function endBody(rows: RecordView[], values: Record<string, unknown>) {
  try {
    return endCommand(rows, String(values.endDate), values.endReason as string | undefined);
  } catch (error) {
    throw new Error(s.errors[(error as Error).message] ?? (error as Error).message);
  }
}
