import { Input, Radio, Typography } from 'antd';
import type { ReactNode } from 'react';
import { CreateEntry } from '../evaluation/CreateEntry.js';
import type { Row } from '../evaluation/model.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { IDP_API, OBJECTS } from './api.js';
import { t } from './messages.js';
import { statusText } from './model.js';
import { CatalogSelect, ORG_PATH } from './selects.js';
import { useGuardedSubmission } from './submission.js';
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
const yesNoOptions = [
  { value: true, label: t.yes },
  { value: false, label: t.no },
];
const statusOptions = [
  { value: 'published', label: t.templateStatus.published },
  { value: 'draft', label: t.templateStatus.draft },
];

interface Props {
  template?: Template;
  close(): void;
  /** 新建成功且选择“开启”时带回新模板，由列表接着发起启用命令（后端没有“创建即启用”的接口）。 */
  saved(enable?: Template): void;
}
/** 模板基本信息的新增与编辑（原站 B2_09 居中弹窗）；模块设置本期只读（见详情）。 */
export function TemplateForm(props: Props) {
  const form = <TemplateEditor {...props} />;
  return props.template ? (
    form
  ) : (
    <CreateEntry path={PATH} title={t.newTemplate} close={props.close}>
      {form}
    </CreateEntry>
  );
}

/**
 * 状态：新建时可选“开启 / 停用”（需有启用按钮权限，否则固定为停用）；编辑时只读，改状态走行操作。
 * 发展计划分类：原站有此字段，后端模板契约没有，显示为缺口占位，不可填写、不提交（后端缺口登记）。
 */
function extraFields(template: Template | undefined, canPublish: boolean): FormField[] {
  return [
    {
      name: 'status',
      label: t.fields.templateState,
      control: <Radio.Group options={statusOptions} />,
      access: { visible: true, editable: !template && canPublish },
      display: statusText(t.templateStatus, template ? template.status : 'draft'),
    },
    {
      name: 'category',
      label: t.categoryLabel,
      control: null,
      access: { visible: true, editable: false },
      display: <Typography.Text type="secondary">{t.categoryGap}</Typography.Text>,
    },
  ];
}

function TemplateEditor({ template, close, saved }: Props) {
  const api = useApiClient();
  const permission = usePermissions(OBJECTS.template);
  const writer = useRecordForm(PATH, template as Row | undefined, project, template ? { action: 'edit' } : {});
  const canPublish = permission.can('publish', 'detail');
  const controls: Record<string, ReactNode> = {
    name: <Input maxLength={100} />,
    processId: <CatalogSelect path={`${IDP_API}/processes?enabled=true`} />,
    orgId: <CatalogSelect path={ORG_PATH} />,
    publicDown: <Radio.Group options={yesNoOptions} />,
    description: <Input.TextArea rows={4} maxLength={2000} />,
  };
  const fields = FIELDS.map((name): FormField => ({
    name,
    label: LABELS[name] ?? name,
    control: controls[name],
    access: permission.field(name),
    rules: REQUIRED.includes(name) ? [{ required: true, whitespace: name === 'name', message: t.required }] : [],
  }));
  const editable = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
  const submission = useGuardedSubmission(writer, fields, { creating: !template, required: REQUIRED });
  const create = async (values: Record<string, unknown>) => {
    let created: Template | undefined;
    const result = await writer.submit({
      values,
      baseline: {},
      editableFields: editable,
      revision: 0,
      send: async (request) => {
        created = await api.request<Template>(PATH, {
          method: 'POST',
          command: { ...request, body: trimmed(request.body) },
        });
        return created;
      },
    });
    if (result.status !== 'done') throw result.error ?? new Error(t.actionFailed);
    writer.clear();
    saved(values.status === 'published' ? created : undefined);
  };
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={template?.id ?? 'new'}
      submission={submission}
      title={template ? t.editTemplate : t.newTemplate}
      // 原站新增模板“向下公开”默认否、“状态”默认开启（B2_09）
      initialValues={
        template ? project(template as Row) : { publicDown: false, status: canPublish ? 'published' : 'draft' }
      }
      groups={[{ title: t.sections.basic, fields: [...fields, ...extraFields(template, canPublish)] }]}
      onClose={close}
      onRefresh={writer.reload}
      onSubmit={async (values) => {
        if (!template) return create(values);
        await writer.save(values, editable, 'PATCH', trimmed);
        writer.clear();
        saved();
      }}
    />
  );
}
export function trimmed(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
  );
}
