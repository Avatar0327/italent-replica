import { Input, InputNumber, Select } from 'antd';
import { useRef } from 'react';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { ApiError } from '../foundation/client.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { base, saveRecord } from './api.js';
import { projectInput } from './model.js';
import { tr } from './messages.js';
import { objects, type Collection, type ReviewRecord } from './types.js';
import { ReferenceSelect } from './ReferenceSelect.js';

const boolean = (
  <Select
    options={[
      { value: true, label: tr.yes },
      { value: false, label: tr.no },
    ]}
  />
);
export function RecordForm({
  collection,
  record,
  onClose,
  saved,
  refresh,
}: {
  collection: Collection;
  record?: ReviewRecord;
  onClose(): void;
  saved(): void;
  refresh(): void;
}) {
  const api = useApiClient();
  const permission = usePermissions(objects[collection]);
  const uncertain = useRef(false);
  const project = collection === 'projects';
  const titles = project ? [tr.newProject, tr.editProject] : [tr.newTemplate, tr.editTemplate];
  const title = titles[record ? 1 : 0]!;
  const fields = formFields(project, !!record, permission);
  return (
    <FormOverlay
      open
      recordKey={record ? `${record.id}:${record.revision}` : `new:${collection}`}
      title={title}
      initialValues={record}
      groups={[{ title: tr.basic, fields }]}
      onClose={onClose}
      onRefresh={refresh}
      onSubmit={async (values) => {
        if (uncertain.current) throw new ApiError(0, 'NETWORK_ERROR', 'unknown', tr.unknown);
        const editable = fields.filter((field) => field.access.editable).map((field) => field.name);
        const body = project ? projectInput(values, editable, record) : templateInput(values, editable);
        try {
          await saveRecord(api, collection, body, record);
          saved();
        } catch (error) {
          if (error instanceof ApiError && ['unknown', 'refresh'].includes(error.kind)) uncertain.current = true;
          throw error;
        }
      }}
    />
  );
}

function formFields(project: boolean, editing: boolean, permission: ReturnType<typeof usePermissions>): FormField[] {
  const names = project
    ? [
        'code',
        'name',
        'ownerOrgId',
        'year',
        'period',
        'periodStartDate',
        'periodEndDate',
        'categoryId',
        'criterionId',
        'calcRuleId',
        'businessDate',
        'downwardPublic',
        'carryLastResult',
        'sharedOrgIds',
      ]
    : ['name', 'ownerOrgId', 'flowId', 'downwardPublic', 'enabled'];
  const required = project
    ? ['code', 'name', 'ownerOrgId', 'year', 'period', 'periodStartDate', 'periodEndDate']
    : ['name', 'ownerOrgId'];
  const refs: Record<string, string> = {
    ownerOrgId: '/api/tenant/org/organizations',
    sharedOrgIds: '/api/tenant/org/organizations',
    categoryId: `${base}/categories`,
    criterionId: '/api/tenant/talent/criteria',
    calcRuleId: `${base}/calc-rules`,
    flowId: `${base}/flows`,
  };
  return names
    .filter((name) => !(editing && name === 'code'))
    .map((name) => {
      const rules: FormField['rules'] = required.includes(name) ? [{ required: true, message: tr.required }] : [];
      if (name === 'code') rules.push({ pattern: /^[A-Za-z][A-Za-z0-9_]{0,49}$/, message: tr.codeRule });
      if (name === 'name' || name === 'period') rules.push({ whitespace: true, max: 50, message: tr.nameRule });
      let control = <Input maxLength={50} />;
      if (refs[name]) control = <ReferenceSelect path={refs[name]} multiple={name === 'sharedOrgIds'} />;
      if (name.endsWith('Date')) control = <TenantDatePicker />;
      if (name === 'year') control = <InputNumber precision={0} min={-2147483648} max={2147483647} />;
      if (['downwardPublic', 'carryLastResult', 'enabled'].includes(name)) control = boolean;
      return { name, label: tr.fields[name as keyof typeof tr.fields], access: permission.field(name), control, rules };
    });
}

function templateInput(values: Record<string, unknown>, editable: string[]) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([name]) => editable.includes(name))
      .map(([name, value]) => {
        if (name === 'flowId' && !value) return [name, null];
        return [name, typeof value === 'string' ? value.trim() : value];
      }),
  );
}
