import { Input, Radio } from 'antd';
import type { ReactNode } from 'react';
import { CreateEntry } from '../evaluation/CreateEntry.js';
import type { Row } from '../evaluation/model.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { IDP_API, OBJECTS } from './api.js';
import { t } from './messages.js';
import { CatalogSelect, ORG_PATH } from './selects.js';
import type { Template } from './types.js';

const PATH = `${IDP_API}/templates`;
const FIELDS = ['name', 'processId', 'orgId', 'publicDown', 'description'];
const REQUIRED = ['name', 'processId', 'orgId'];
const LABELS: Record<string, string> = {
  ...t.fields,
  name: t.fields.templateName,
  publicDown: t.fields.publicDownQuestion,
};
const project = (row: Row) => Object.fromEntries(FIELDS.map((name) => [name, row[name] ?? undefined]));

/** 模板基本信息（名称、流程、所属组织、向下公开、描述）的新增与编辑；模块设置本期只读（见详情）。 */
export function TemplateForm({ template, close, saved }: { template?: Template; close(): void; saved(): void }) {
  const form = <TemplateEditor template={template} close={close} saved={saved} />;
  return template ? (
    form
  ) : (
    <CreateEntry path={PATH} title={t.newTemplate} close={close}>
      {form}
    </CreateEntry>
  );
}
function TemplateEditor({ template, close, saved }: { template?: Template; close(): void; saved(): void }) {
  const permission = usePermissions(OBJECTS.template);
  const writer = useRecordForm(PATH, template as Row | undefined, project);
  const controls: Record<string, ReactNode> = {
    name: <Input maxLength={100} />,
    processId: <CatalogSelect path={`${IDP_API}/processes?enabled=true`} />,
    orgId: <CatalogSelect path={ORG_PATH} />,
    // 原站新增模板用单选“是 / 否”
    publicDown: (
      <Radio.Group
        options={[
          { value: true, label: t.yes },
          { value: false, label: t.no },
        ]}
      />
    ),
    description: <Input.TextArea rows={4} maxLength={2000} />,
  };
  const fields = FIELDS.map((name): FormField => ({
    name,
    label: LABELS[name] ?? name,
    control: controls[name],
    access: permission.field(name),
    rules: REQUIRED.includes(name) ? [{ required: true, whitespace: name === 'name', message: t.required }] : [],
  }));
  return (
    <FormOverlay
      open
      recordKey={template?.id ?? 'new'}
      submission={writer}
      title={template ? t.editTemplate : t.newTemplate}
      initialValues={template ? project(template as Row) : { publicDown: true }}
      groups={[{ title: t.sections.basic, fields }]}
      onClose={close}
      onRefresh={writer.reload}
      onSubmit={async (values) => {
        const editable = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
        await writer.save(values, editable, template ? 'PATCH' : 'POST', trimmed);
        writer.clear();
        saved();
        close();
      }}
    />
  );
}
export function trimmed(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
  );
}
