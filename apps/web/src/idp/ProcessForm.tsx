import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  type FormInstance,
  type TableColumnsType,
} from 'antd';
import {
  MAX_START_DAYS,
  MAX_SUB_PROCESSES,
  REFERENCE_POINTS,
  START_FROM,
  startRuleText,
  startRuleViolation,
  type StartRule,
} from '@italent/domain';
import { useState, type ReactNode } from 'react';
import { CreateEntry } from '../evaluation/CreateEntry.js';
import type { Row } from '../evaluation/model.js';
import { Failure, useRead } from '../evaluation/runtime.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { IDP_API, OBJECTS } from './api.js';
import { t } from './messages.js';
import { display } from './model.js';
import { CatalogSelect, ORG_PATH } from './selects.js';
import type { Process, SubProcess } from './types.js';

const PATH = `${IDP_API}/processes`;
const FIELDS = ['name', 'orgId', 'publicDown', 'enabled', 'subProcesses'];
const REQUIRED = ['name', 'orgId', 'subProcesses'];
const LABELS: Record<string, string> = {
  ...t.fields,
  name: t.fields.processName,
  publicDown: t.fields.publicDownQuestion,
};
/** 提交只带契约字段：读接口回传的 ruleText / seq 不提交（服务端 strictObject）。 */
const SUB_KEYS = [
  'id',
  'name',
  'category',
  'approvalType',
  'approvalProcessId',
  'startMode',
  'startTimeType',
  'fixedDate',
  'referencePoint',
  'startFrom',
  'days',
] as const;

const project = (row: Row) =>
  Object.fromEntries(
    FIELDS.map((name) => [
      name,
      name === 'subProcesses' ? subInputs(row[name] as SubProcess[] | undefined) : row[name],
    ]),
  );
function subInputs(items: SubProcess[] | undefined) {
  return items?.map((item) =>
    Object.fromEntries(SUB_KEYS.filter((key) => item[key] !== undefined).map((key) => [key, item[key]])),
  );
}
function ruleOf(item: SubProcess): StartRule {
  return {
    startMode: item.startMode === 'manual' ? 'manual' : 'auto',
    startTimeType: (item.startTimeType ?? null) as StartRule['startTimeType'],
    fixedDate: item.fixedDate ?? null,
    referencePoint: (item.referencePoint ?? null) as StartRule['referencePoint'],
    startFrom: (item.startFrom ?? null) as StartRule['startFrom'],
    days: item.days ?? null,
  };
}

/** 流程新增 / 编辑：编辑前先读详情拿完整子流程与 revision，再走 F-123 提交内核。 */
export function ProcessForm({ id, close, saved }: { id?: string; close(): void; saved(): void }) {
  if (!id)
    return (
      <CreateEntry path={PATH} title={t.newProcess} close={close}>
        <ProcessEditor close={close} saved={saved} />
      </CreateEntry>
    );
  return <LoadedProcess id={id} close={close} saved={saved} />;
}
function LoadedProcess({ id, close, saved }: { id: string; close(): void; saved(): void }) {
  const detail = useRead<Process>(`${PATH}/${id}`);
  if (!detail.data)
    return (
      <Modal open title={t.editProcess} footer={null} onCancel={close}>
        {detail.error ? <Failure error={detail.error} retry={detail.reload} /> : <PageState kind="loading" />}
      </Modal>
    );
  return <ProcessEditor process={detail.data} close={close} saved={saved} />;
}
function ProcessEditor({ process, close, saved }: { process?: Process; close(): void; saved(): void }) {
  const permission = usePermissions(OBJECTS.process);
  const writer = useRecordForm(PATH, process as Row | undefined, project);
  const subAccess = permission.field('subProcesses');
  const controls: Record<string, ReactNode> = {
    name: <Input maxLength={100} />,
    orgId: <CatalogSelect path={ORG_PATH} />,
    publicDown: <YesNo />,
    enabled: <YesNo />,
    subProcesses: <SubProcessEditor readOnly={!subAccess.editable} />,
  };
  const fields = FIELDS.map((name): FormField => ({
    name,
    label: LABELS[name] ?? name,
    control: controls[name],
    access: permission.field(name),
    rules: rulesOf(name),
    display: name === 'subProcesses' ? <SubProcessEditor readOnly value={process?.subProcesses} /> : undefined,
  }));
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={process?.id ?? 'new'}
      submission={writer}
      title={process ? t.editProcess : t.newProcess}
      initialValues={process ? project(process as Row) : { publicDown: true, enabled: true, subProcesses: [] }}
      groups={[{ title: t.sections.processInfo, fields }]}
      onClose={close}
      onRefresh={writer.reload}
      onSubmit={async (values) => {
        const editable = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
        await writer.save(values, editable, process ? 'PATCH' : 'POST', (body) =>
          typeof body.name === 'string' ? { ...body, name: body.name.trim() } : body,
        );
        writer.clear();
        saved();
        close();
      }}
    />
  );
}

function rulesOf(name: string): FormField['rules'] {
  if (name === 'subProcesses')
    return [
      {
        validator: (_, value: SubProcess[] | undefined) => {
          if (!value?.length) return Promise.reject(new Error(t.subProcessRequired));
          const broken = value.map((item, index) => startRuleViolation(ruleOf(item), index)).find(Boolean);
          return broken ? Promise.reject(new Error(broken)) : Promise.resolve();
        },
      },
    ];
  return REQUIRED.includes(name) ? [{ required: true, whitespace: name === 'name', message: t.required }] : [];
}

function YesNo({ value, onChange }: { value?: boolean; onChange?: (value: boolean) => void }) {
  return (
    <Select
      value={value}
      onChange={onChange}
      options={[
        { value: true, label: t.yes },
        { value: false, label: t.no },
      ]}
    />
  );
}

type IndexedSub = SubProcess & { index: number };
interface SubHandlers {
  edit(row: IndexedSub): void;
  up(index: number): void;
  remove(index: number): void;
}

/** 子流程按顺序整组提交（seq 由服务端按数组顺序定）；行内编辑在二级弹窗里完成。 */
function SubProcessEditor({
  value = [],
  onChange,
  readOnly,
}: {
  value?: SubProcess[];
  onChange?: (value: SubProcess[]) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState<{ index: number; item: SubProcess }>();
  const change = (next: SubProcess[]) => onChange?.(next);
  const handlers: SubHandlers = {
    edit: (row) => setEditing({ index: row.index, item: row }),
    up: (index) => {
      const next = [...value];
      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
      change(next);
    },
    remove: (index) => change(value.filter((_, at) => at !== index)),
  };
  return (
    <div className="idp-sub-process">
      <Table<IndexedSub>
        size="small"
        rowKey="index"
        pagination={false}
        dataSource={value.map((item, index) => ({ ...item, index }))}
        locale={{ emptyText: t.empty }}
        columns={subColumns(readOnly ? undefined : handlers)}
      />
      {!readOnly && (
        <Button
          type="dashed"
          disabled={value.length >= MAX_SUB_PROCESSES}
          onClick={() => setEditing({ index: value.length, item: { startMode: 'auto' } })}
        >
          {t.actions.addSubProcess}
        </Button>
      )}
      {editing && (
        <SubProcessDialog
          item={editing.item}
          index={editing.index}
          close={() => setEditing(undefined)}
          save={(item) => {
            const next = [...value];
            next[editing.index] = item;
            change(next);
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

function subColumns(handlers?: SubHandlers): TableColumnsType<IndexedSub> {
  const columns: TableColumnsType<IndexedSub> = [
    { key: 'seq', title: '#', width: 48, render: (_, row) => row.index + 1 },
    { key: 'name', title: t.fields.name, render: (_, row) => display(row.name) },
    { key: 'category', title: t.fields.category, width: 100, render: (_, row) => label(t.categories, row.category) },
    {
      key: 'approvalType',
      title: t.fields.approvalType,
      width: 120,
      render: (_, row) => label(t.approvalTypes, row.approvalType),
    },
    {
      key: 'rule',
      title: t.fields.ruleText,
      render: (_, row) => (row.startMode ? startRuleText(ruleOf(row), row.index) : t.noValue),
    },
  ];
  if (!handlers) return columns;
  return [
    ...columns,
    {
      key: 'operations',
      title: t.fields.operations,
      width: 200,
      render: (_, row) => (
        <Space size={0}>
          <Button type="link" onClick={() => handlers.edit(row)}>
            {t.actions.edit}
          </Button>
          <Button type="link" disabled={row.index === 0} onClick={() => handlers.up(row.index)}>
            {t.actions.up}
          </Button>
          <Button type="link" danger onClick={() => handlers.remove(row.index)}>
            {t.actions.remove}
          </Button>
        </Space>
      ),
    },
  ];
}
const label = (labels: Record<string, string>, key?: string | null) => labels[key ?? ''] ?? t.noValue;
const options = (labels: Record<string, string>, keys?: readonly string[]) =>
  (keys ?? Object.keys(labels)).map((key) => ({ value: key, label: labels[key] ?? key }));
const required = [{ required: true, message: t.required }];

type SubValues = Omit<SubProcess, 'startTimeType'> & { startTimeType?: string };
const NONE = 'none';

/** 不适用的规则字段一律清成 null，避免切换开启方式后残留旧值被服务端判为不自洽（IDP-R2）。 */
function toSubProcess(values: SubValues, id?: string): SubProcess {
  const type = values.startMode === 'manual' || values.startTimeType === NONE ? null : (values.startTimeType ?? null);
  return {
    ...(id ? { id } : {}),
    name: values.name?.trim(),
    category: values.category,
    approvalType: values.approvalType,
    approvalProcessId: values.approvalProcessId,
    startMode: values.startMode,
    startTimeType: type,
    fixedDate: type === 'fixed' ? (values.fixedDate ?? null) : null,
    referencePoint: type === 'relative' ? (values.referencePoint ?? null) : null,
    startFrom: type === 'relative' ? (values.startFrom ?? null) : null,
    days: type === 'relative' && values.startFrom !== 'same_day' ? (values.days ?? null) : null,
  };
}

function SubProcessDialog(props: { item: SubProcess; index: number; close(): void; save(item: SubProcess): void }) {
  const { item, index, close, save } = props;
  const [form] = Form.useForm<SubValues>();
  const [error, setError] = useState<string>();
  const approvalType = Form.useWatch('approvalType', form);
  const ok = async () => {
    const next = toSubProcess(await form.validateFields(), item.id);
    const violation = startRuleViolation(ruleOf(next), index);
    if (violation) return setError(violation);
    save(next);
  };
  const candidates = `${IDP_API}/approval-processes${approvalType ? `?approvalType=${approvalType}` : ''}`;
  return (
    <Modal
      open
      title={item.name ? `${t.actions.edit}${t.fields.subProcesses}` : t.actions.addSubProcess}
      onCancel={close}
      okText={t.actions.ok}
      cancelText={t.actions.back}
      onOk={() => void ok()}
      destroyOnHidden
    >
      {error && <Alert type="error" showIcon message={error} />}
      <Form form={form} layout="vertical" initialValues={{ ...item, startTimeType: item.startTimeType ?? NONE }}>
        <Form.Item name="name" label={t.fields.name} rules={[{ ...required[0], whitespace: true, max: 100 }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="category" label={t.fields.category} rules={required}>
          <Select options={options(t.categories)} />
        </Form.Item>
        <Form.Item name="approvalType" label={t.fields.approvalType} rules={required}>
          <Select
            options={options(t.approvalTypes)}
            onChange={() => form.setFieldValue('approvalProcessId', undefined)}
          />
        </Form.Item>
        <Form.Item name="approvalProcessId" label={t.fields.approvalProcessId} rules={required}>
          <CatalogSelect disabled={!approvalType} path={candidates} />
        </Form.Item>
        <Form.Item name="startMode" label={t.fields.startMode} rules={required}>
          <Select options={options(t.startModes)} />
        </Form.Item>
        <StartRuleFields form={form} first={index === 0} />
      </Form>
    </Modal>
  );
}

/** 只有自动开启才有规则；第一段没有“上一阶段结束时间”可选。 */
function StartRuleFields({ form, first }: { form: FormInstance<SubValues>; first: boolean }) {
  const startMode = Form.useWatch('startMode', form);
  const timeType = Form.useWatch('startTimeType', form);
  const startFrom = Form.useWatch('startFrom', form);
  if (startMode !== 'auto') return null;
  const points = first ? REFERENCE_POINTS.filter((key) => key !== 'previous_end') : REFERENCE_POINTS;
  return (
    <>
      <Form.Item name="startTimeType" label={t.fields.startTimeType}>
        <Select options={options(t.startTimeTypes)} />
      </Form.Item>
      {timeType === 'fixed' && (
        <Form.Item name="fixedDate" label={t.fields.fixedDate} rules={required}>
          <TenantDatePicker />
        </Form.Item>
      )}
      {timeType === 'relative' && (
        <>
          <Form.Item name="referencePoint" label={t.fields.referencePoint} rules={required}>
            <Select options={options(t.referencePoints, points)} />
          </Form.Item>
          <Form.Item name="startFrom" label={t.fields.startFrom} rules={required}>
            <Select options={options(t.startFroms, START_FROM)} />
          </Form.Item>
          {startFrom && startFrom !== 'same_day' && (
            <Form.Item name="days" label={t.fields.days} rules={required}>
              <InputNumber min={1} max={MAX_START_DAYS} precision={0} />
            </Form.Item>
          )}
        </>
      )}
    </>
  );
}
