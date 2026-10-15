import { Input, Select } from 'antd';
import type { ReactNode } from 'react';
import { CreateEntry } from '../evaluation/CreateEntry.js';
import type { Row } from '../evaluation/model.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { IDP_API, OBJECTS } from './api.js';
import { t } from './messages.js';
import { planInput } from './model.js';
import { useGuardedSubmission } from './submission.js';
import { CatalogSelect, EmployeeSelect } from './selects.js';
import type { PlanSummary } from './types.js';

const PATH = `${IDP_API}/plans`;
const CREATE_FIELDS = ['name', 'employeeId', 'tutorRole', 'templateId', 'startDate', 'endDate', 'tutorEmployeeId'];
// 计划创建后员工与模板不可改（plan-input.ts planPatch 只接受这五项）
const EDIT_FIELDS = ['name', 'tutorRole', 'startDate', 'endDate', 'tutorEmployeeId'];
const REQUIRED = ['name', 'employeeId', 'templateId', 'startDate', 'endDate', 'tutorRole'];
const LABELS: Record<string, string> = { ...t.fields, name: t.fields.planName };

const project = (row: Row) => Object.fromEntries(CREATE_FIELDS.map((name) => [name, row[name] ?? undefined]));

/** 新增 / 编辑计划走 F-123 提交内核：命令 ID、锁定、冲突重读由底座负责（docs/02_业务建模/28 IDP-R10）。 */
export function PlanForm({ plan, close, saved }: { plan?: PlanSummary; close(): void; saved(): void }) {
  const form = <PlanEditor plan={plan} close={close} saved={saved} />;
  return plan ? (
    form
  ) : (
    <CreateEntry path={PATH} title={t.newPlan} close={close}>
      {form}
    </CreateEntry>
  );
}
function PlanEditor({ plan, close, saved }: { plan?: PlanSummary; close(): void; saved(): void }) {
  const permission = usePermissions(OBJECTS.plan);
  const row = plan as Row | undefined;
  const writer = useRecordForm(PATH, row, project, row ? { action: 'edit' } : {});
  const controls: Record<string, ReactNode> = {
    name: <Input maxLength={200} />,
    employeeId: <EmployeeSelect />,
    templateId: <CatalogSelect path={`${IDP_API}/templates?status=published`} />,
    startDate: <TenantDatePicker />,
    endDate: <TenantDatePicker />,
    tutorRole: <Select options={Object.entries(t.tutorRoles).map(([value, label]) => ({ value, label }))} />,
    tutorEmployeeId: <EmployeeSelect />,
  };
  const fields = (plan ? EDIT_FIELDS : CREATE_FIELDS).map((name): FormField => ({
    name,
    label: LABELS[name] ?? name,
    control: controls[name],
    access: permission.field(name),
    rules: rulesOf(name),
  }));
  const submission = useGuardedSubmission(writer, fields, { creating: !plan, required: REQUIRED });
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={plan?.id ?? 'new'}
      submission={submission}
      title={plan ? t.editPlan : t.newPlan}
      initialValues={plan ? project(plan as Row) : { tutorRole: 'direct_manager' }}
      groups={[{ title: t.sections.basic, fields }]}
      onClose={close}
      onRefresh={writer.reload}
      onSubmit={async (values) => {
        const editable = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
        await writer.save(values, editable, plan ? 'PATCH' : 'POST', (body) => planInput(body, Object.keys(body)).body);
        writer.clear();
        saved();
        close();
      }}
    />
  );
}

/** 前端先拦日期顺序与“其他人须选指导人”，与服务端 plan-input.ts 同规则；服务端仍为最终判定。 */
function rulesOf(name: string): FormField['rules'] {
  const rules: NonNullable<FormField['rules']> = [];
  if (REQUIRED.includes(name)) rules.push({ required: true, whitespace: name === 'name', message: t.required });
  if (name === 'endDate')
    rules.push(({ getFieldValue }) => ({
      validator: (_, value: string | undefined) =>
        planInput({ startDate: getFieldValue('startDate'), endDate: value }, []).errors.endDate
          ? Promise.reject(new Error(t.dateOrder))
          : Promise.resolve(),
    }));
  if (name === 'tutorEmployeeId')
    rules.push(({ getFieldValue }) => ({
      validator: (_, value: string | undefined) =>
        planInput({ tutorRole: getFieldValue('tutorRole'), tutorEmployeeId: value }, []).errors.tutorEmployeeId
          ? Promise.reject(new Error(t.tutorRequired))
          : Promise.resolve(),
    }));
  return rules;
}
