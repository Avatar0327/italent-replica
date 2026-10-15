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
import { submitAccess, type Integrity } from './access.js';
import { display, subProcessAccess } from './model.js';
import { CatalogSelect, ORG_PATH } from './selects.js';
import { useGuardedSubmission } from './submission.js';
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
  const writer = useRecordForm(PATH, process as Row | undefined, project, process ? { action: 'edit' } : {});
  // 子流程按 IDP.SubProcess 自身字段权限与操作权渲染，父对象 subProcesses 可编辑是前提（失败即拒绝）
  const subPermission = usePermissions(OBJECTS.subProcess);
  const subOperations = subPermission.snapshot.objects[OBJECTS.subProcess]?.dataOperations;
  const parent = permission.field('subProcesses');
  // 只读展示与整组完整性都跟随冲突重读后的最新版本，与表单其他字段同源；新增时没有已有子流程
  const shownSubs = writer.current?.subProcesses as SubProcess[] | undefined;
  const subAccess = subProcessAccess(parent.visible && parent.editable, subPermission.field, subOperations, shownSubs);
  // 只读展示沿用编辑态的原因：整组因完整性只读时，用户能看到为什么不能改
  const subDisplay = { ...subProcessAccess(false, subPermission.field, subOperations), reason: subAccess.reason };
  // 写入完整性约束提交字段（submitAccess）：不完整的字段不渲染编辑控件、不进提交，展示回到最新记录
  const integrity: Record<string, Integrity> = { subProcesses: subAccess.integrity };
  const controls: Record<string, ReactNode> = {
    name: <Input maxLength={100} />,
    orgId: <CatalogSelect path={ORG_PATH} />,
    publicDown: <YesNo />,
    enabled: <YesNo />,
    subProcesses: <SubProcessEditor access={subAccess} />,
  };
  const fields = FIELDS.map((name): FormField => ({
    name,
    label: LABELS[name] ?? name,
    control: controls[name],
    access: submitAccess(permission.field(name), integrity[name]),
    rules: rulesOf(name),
    display: name === 'subProcesses' ? <SubProcessEditor access={subDisplay} value={shownSubs} /> : undefined,
  }));
  const submission = useGuardedSubmission(writer, fields, { creating: !process, required: REQUIRED });
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={process?.id ?? 'new'}
      submission={submission}
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
type SubAccess = ReturnType<typeof subProcessAccess>;
interface SubHandlers {
  edit?(row: IndexedSub): void;
  up?(index: number): void;
  remove?(index: number): void;
  /** 移除中间行会改动后续行的顺序号，服务端按编辑权复核；只有移除末行不改顺序。 */
  removable(index: number): boolean;
}

/** 子流程按顺序整组提交（seq 由服务端按数组顺序定）；行内编辑在二级弹窗里完成。 */
function SubProcessEditor({
  value = [],
  onChange,
  access,
}: {
  value?: SubProcess[];
  onChange?: (value: SubProcess[]) => void;
  access: SubAccess;
}) {
  const [editing, setEditing] = useState<{ index: number; item: SubProcess }>();
  const change = (next: SubProcess[]) => onChange?.(next);
  const handlers: SubHandlers = {
    edit: access.edit ? (row) => setEditing({ index: row.index, item: row }) : undefined,
    up: access.reorder
      ? (index) => {
          const next = [...value];
          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
          change(next);
        }
      : undefined,
    remove: access.remove ? (index) => change(value.filter((_, at) => at !== index)) : undefined,
    removable: (index) => access.remove && (access.reorder || index === value.length - 1),
  };
  return (
    <div className="idp-sub-process">
      {access.reason && <Alert type="warning" showIcon message={access.reason} />}
      <Table<IndexedSub>
        size="small"
        rowKey="index"
        pagination={false}
        dataSource={value.map((item, index) => ({ ...item, index }))}
        locale={{ emptyText: t.empty }}
        columns={subColumns(access.visible, handlers)}
      />
      {access.add && (
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
          access={access}
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

/** 列按子流程字段可见性裁剪：不可见字段不出列；开启规则依赖开启方式可见。 */
function subColumns(visible: readonly string[], handlers: SubHandlers): TableColumnsType<IndexedSub> {
  const { edit, up, remove, removable } = handlers;
  const all: (TableColumnsType<IndexedSub>[number] | false)[] = [
    { key: 'seq', title: '#', width: 48, render: (_, row) => row.index + 1 },
    visible.includes('name') && { key: 'name', title: t.fields.name, render: (_, row) => display(row.name) },
    visible.includes('category') && {
      key: 'category',
      title: t.fields.category,
      width: 100,
      render: (_, row) => label(t.categories, row.category),
    },
    visible.includes('approvalType') && {
      key: 'approvalType',
      title: t.fields.approvalType,
      width: 120,
      render: (_, row) => label(t.approvalTypes, row.approvalType),
    },
    visible.includes('startMode') && {
      key: 'rule',
      title: t.fields.ruleText,
      render: (_, row) => (row.startMode ? startRuleText(ruleOf(row), row.index) : t.noValue),
    },
    (!!edit || !!up || !!remove) && {
      key: 'operations',
      title: t.fields.operations,
      width: 200,
      render: (_, row) => (
        <Space size={0}>
          {edit && (
            <Button type="link" onClick={() => edit(row)}>
              {t.actions.edit}
            </Button>
          )}
          {up && (
            <Button type="link" disabled={row.index === 0} onClick={() => up(row.index)}>
              {t.actions.up}
            </Button>
          )}
          {remove && removable(row.index) && (
            <Button type="link" danger onClick={() => remove(row.index)}>
              {t.actions.remove}
            </Button>
          )}
        </Space>
      ),
    },
  ];
  return all.filter((column) => !!column) as TableColumnsType<IndexedSub>;
}
const label = (labels: Record<string, string>, key?: string | null) => labels[key ?? ''] ?? t.noValue;
const options = (labels: Record<string, string>, keys?: readonly string[]) =>
  (keys ?? Object.keys(labels)).map((key) => ({ value: key, label: labels[key] ?? key }));
const required = [{ required: true, message: t.required }];

type SubValues = Omit<SubProcess, 'startTimeType'> & { startTimeType?: string };
const NONE = 'none';

/**
 * 不适用的规则字段一律清成 null，避免切换开启方式后残留旧值被服务端判为不自洽（IDP-R2）。
 * 调用方先把原值与表单值合并，隐藏字段（不在表单里）沿用原值，不会被清空。
 */
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

interface SubDialogProps {
  item: SubProcess;
  index: number;
  access: SubAccess;
  close(): void;
  save(item: SubProcess): void;
}
/** 只渲染可见字段；可见不可编辑的禁用。表单命名 subProcess，避免与外层流程表单的同名字段 id 冲突。 */
function SubProcessDialog({ item, index, access, close, save }: SubDialogProps) {
  const [form] = Form.useForm<SubValues>();
  const [error, setError] = useState<string>();
  const approvalType = Form.useWatch('approvalType', form) ?? item.approvalType;
  const shows = (name: string) => access.visible.includes(name);
  const locked = (name: string) => !access.editable.includes(name);
  const ok = async () => {
    const next = toSubProcess({ ...(item as SubValues), ...(await form.validateFields()) }, item.id);
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
      <Form
        form={form}
        name="subProcess"
        layout="vertical"
        initialValues={{ ...item, startTimeType: item.startTimeType ?? NONE }}
      >
        {shows('name') && (
          <Form.Item name="name" label={t.fields.name} rules={[{ ...required[0], whitespace: true, max: 100 }]}>
            <Input maxLength={100} disabled={locked('name')} />
          </Form.Item>
        )}
        {shows('category') && (
          <Form.Item name="category" label={t.fields.category} rules={required}>
            <Select options={options(t.categories)} disabled={locked('category')} />
          </Form.Item>
        )}
        {shows('approvalType') && (
          <Form.Item name="approvalType" label={t.fields.approvalType} rules={required}>
            <Select
              options={options(t.approvalTypes)}
              disabled={locked('approvalType')}
              onChange={() => form.setFieldValue('approvalProcessId', undefined)}
            />
          </Form.Item>
        )}
        {shows('approvalProcessId') && (
          <Form.Item name="approvalProcessId" label={t.fields.approvalProcessId} rules={required}>
            <CatalogSelect disabled={!approvalType || locked('approvalProcessId')} path={candidates} />
          </Form.Item>
        )}
        {shows('startMode') && (
          <Form.Item name="startMode" label={t.fields.startMode} rules={required}>
            <Select options={options(t.startModes)} disabled={locked('startMode')} />
          </Form.Item>
        )}
        <StartRuleFields form={form} first={index === 0} shows={shows} locked={locked} />
      </Form>
    </Modal>
  );
}

/** 只有自动开启才有规则；第一段没有“上一阶段结束时间”可选。 */
interface RuleProps {
  form: FormInstance<SubValues>;
  first: boolean;
  shows(name: string): boolean;
  locked(name: string): boolean;
}
function StartRuleFields({ form, first, shows, locked }: RuleProps) {
  const startMode = Form.useWatch('startMode', form);
  const timeType = Form.useWatch('startTimeType', form);
  const startFrom = Form.useWatch('startFrom', form);
  if (startMode !== 'auto' || !shows('startTimeType')) return null;
  const points = first ? REFERENCE_POINTS.filter((key) => key !== 'previous_end') : REFERENCE_POINTS;
  return (
    <>
      <Form.Item name="startTimeType" label={t.fields.startTimeType}>
        <Select options={options(t.startTimeTypes)} disabled={locked('startTimeType')} />
      </Form.Item>
      {timeType === 'fixed' && shows('fixedDate') && (
        <Form.Item name="fixedDate" label={t.fields.fixedDate} rules={required}>
          <TenantDatePicker disabled={locked('fixedDate')} />
        </Form.Item>
      )}
      {timeType === 'relative' && (
        <>
          {shows('referencePoint') && (
            <Form.Item name="referencePoint" label={t.fields.referencePoint} rules={required}>
              <Select options={options(t.referencePoints, points)} disabled={locked('referencePoint')} />
            </Form.Item>
          )}
          {shows('startFrom') && (
            <Form.Item name="startFrom" label={t.fields.startFrom} rules={required}>
              <Select options={options(t.startFroms, START_FROM)} disabled={locked('startFrom')} />
            </Form.Item>
          )}
          {startFrom && startFrom !== 'same_day' && shows('days') && (
            <Form.Item name="days" label={t.fields.days} rules={required}>
              <InputNumber min={1} max={MAX_START_DAYS} precision={0} disabled={locked('days')} />
            </Form.Item>
          )}
        </>
      )}
    </>
  );
}
