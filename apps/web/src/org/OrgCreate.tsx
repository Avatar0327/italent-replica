import { Input } from 'antd';
import { FormOverlay, TenantDatePicker, type FormField } from '../foundation/index.js';
import { ReferenceSelect } from '../job/JobEditor.js';
import { orgCreateBody, type OrgRow } from './page-model.js';
import { PersonSelect } from './PersonFields.js';
import { type PageAccess } from './page-support.js';
import { useRecordCommand } from './record-command.js';
import { detailText, pageText as m } from './messages.js';

interface Props {
  /** 新建下级时预填的行政维度上级。 */
  parentId?: string;
  date: string;
  access: PageAccess;
  onClose(): void;
  onSaved(): void;
}
// 原站新建组织弹窗：生效日期、上级、编码、名称、简称在前；接口没有的字段（部门职责等）列入后端缺口，不在此占位。
function createFields({ date, access }: Props): FormField[] {
  const field = (name: string, label: string, control: FormField['control'], required = false): FormField => ({
    name,
    label,
    control,
    access: access.field(name === 'adminParent' ? 'parents' : name),
    rules: required ? [{ required: true, message: m.required }] : undefined,
  });
  return [
    // 接口没有单独的生效日期：首个版本从设立日期开始（DEC-130），原站此处叫「生效日期」。
    field('establishedOn', m.date, <TenantDatePicker />, true),
    field('adminParent', detailText.admin, <ReferenceSelect kind="org" date={date} />, true),
    field('code', m.code, <Input maxLength={64} />),
    field('name', m.name, <Input maxLength={200} />, true),
    field('shortName', m.shortName, <Input maxLength={100} />, true),
    field('personInChargeId', m.personInChargeId, <PersonSelect date={date} />),
    field('hrbpId', m.hrbpId, <PersonSelect date={date} />),
    field('location', m.location, <Input maxLength={500} />),
  ];
}
export function OrgCreate(props: Props) {
  const { parentId, date } = props;
  const key = parentId ? `child:${parentId}` : 'new';
  const record = useRecordCommand({
    // 新建没有原单可回查：结果未知时保持锁定，待刷新列表核对。
    resource: `/api/tenant/org/organizations#${key}@${date}`,
    project: (row: OrgRow) => row,
  });
  return (
    <FormOverlay
      mode="modal"
      recordKey={`${key}@${date}`}
      submission={record.command}
      open
      title={parentId ? m.createChild : m.create}
      initialValues={{ establishedOn: date, adminParent: parentId }}
      onClose={() => {
        record.command.clear();
        props.onClose();
      }}
      onSubmit={async (values) => {
        await record.save(values, { path: '/api/tenant/org/organizations', method: 'POST', build: orgCreateBody });
        props.onSaved();
      }}
      groups={[{ title: m.basic, fields: createFields(props) }]}
    />
  );
}
