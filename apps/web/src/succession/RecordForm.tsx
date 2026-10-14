import { Input, Select } from 'antd';
import { useCallback, type ReactNode } from 'react';
import type { FormItemProps } from 'antd';
import { CreateEntry } from '../evaluation/CreateEntry.js';
import { RemoteSelect, useRead } from '../evaluation/runtime.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import type { Row } from '../evaluation/model.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { PersonSelect, TenantDatePicker } from '../foundation/selectors.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { s } from './messages.js';
import { BASE, createRecordBody, endCommand, recordDateErrors } from './rules.js';
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
  const permission = usePermissions(RECORD);
  const { today } = useSession();
  const writer = useRecordForm(RECORDS, row as Row | undefined);
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
  const fields = Object.entries(controls).map(([name, control]): FormField => ({
    name,
    label: labels[name]!,
    control,
    access: access(name),
    rules: rules[name],
    display: display[name],
  }));
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row?.id ?? `new-${type}`}
      submission={writer}
      title={row ? s.editTitle : s.createTitle[type]!}
      initialValues={row ? { ...row } : { startDate: today }}
      groups={[{ title: s.basic, fields }]}
      onClose={close}
      onSubmit={async (values) => {
        const editable = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
        await writer.save(values, editable, row ? 'PUT' : 'POST', (body) =>
          row ? trimmed(body) : createRecordBody(type, body),
        );
        writer.clear();
        saved();
      }}
    />
  );
}
export const targetName = (row?: RecordView) => row?.targetPosition?.name ?? row?.targetOrg?.name;

/** SC-R3 批量结束：一个命令整体成功或失败；结束日期同样不得晚于今天（服务端复核）。 */
export function EndForm({ rows, close, saved }: { rows: RecordView[]; close(): void; saved(): void }) {
  const permission = usePermissions(RECORD);
  const { today } = useSession();
  const writer = useRecordForm(`${RECORDS}/end`);
  const field = (name: string, control: ReactNode, rules: FormField['rules']): FormField => ({
    name,
    label: name === 'endDate' ? s.endFormDate : s.fields.endReason,
    control,
    access: { ...permission.field(name), editable: permission.field(name).visible },
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
      submission={writer}
      title={s.end}
      initialValues={{ endDate: today }}
      groups={[{ title: s.endHint, fields }]}
      onClose={close}
      onSubmit={async (values) => {
        await writer.save(values, ['endDate', 'endReason'], 'POST', (body) => {
          try {
            return endCommand(rows, String(body.endDate), body.endReason as string | undefined);
          } catch (error) {
            throw new Error(s.errors[(error as Error).message] ?? (error as Error).message);
          }
        });
        writer.clear();
        saved();
      }}
    />
  );
}
