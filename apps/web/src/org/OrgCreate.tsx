import { Form, Input } from 'antd';
import { FormOverlay, TenantDatePicker, tenantDate, useSession, type FormField } from '../foundation/index.js';
import { ReferenceSelect } from '../job/JobEditor.js';
import { orgCreateBody, orgCreateDate, orgCreateResource, type OrgRow } from './page-model.js';
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
interface DateProps {
  /** 表单的业务时点；follow 为真时跟随表单里的生效日期。 */
  asOf: string;
  follow: boolean;
  value?: string | null;
  onChange?: (value: string | null) => void;
}
/** 候选查询与显示、提交取同一个业务时点：有日期编辑权跟随表单所选日期，否则固定为租户当天。 */
function useCreateDate({ asOf, follow }: DateProps) {
  const watched = Form.useWatch('establishedOn', Form.useFormInstance()) as string | null | undefined;
  return follow && watched ? watched : asOf;
}
function CreateParentSelect(props: DateProps) {
  return <ReferenceSelect kind="org" date={useCreateDate(props)} value={props.value} onChange={props.onChange} />;
}
function CreatePersonSelect(props: DateProps) {
  return <PersonSelect date={useCreateDate(props)} value={props.value} onChange={props.onChange} />;
}
// 原站新建组织弹窗：生效日期、上级、编码、名称、简称在前；接口没有的字段（部门职责等）列入后端缺口，不在此占位。
function createFields(access: PageAccess, asOf: string): FormField[] {
  const dateAccess = access.field('establishedOn');
  const follow = dateAccess.visible && dateAccess.editable;
  const field = (name: string, label: string, control: FormField['control'], required = false): FormField => ({
    name,
    label,
    control,
    access: access.field(name === 'adminParent' ? 'parents' : name),
    rules: required ? [{ required: true, message: m.required }] : undefined,
  });
  return [
    // 接口没有单独的生效日期：首个版本从设立日期开始（DEC-130），原站此处叫「生效日期」。
    { ...field('establishedOn', m.date, <TenantDatePicker />, true), display: asOf },
    field('adminParent', detailText.admin, <CreateParentSelect asOf={asOf} follow={follow} />, true),
    field('code', m.code, <Input maxLength={64} />),
    field('name', m.name, <Input maxLength={200} />, true),
    field('shortName', m.shortName, <Input maxLength={100} />, true),
    field('personInChargeId', m.personInChargeId, <CreatePersonSelect asOf={asOf} follow={follow} />),
    field('hrbpId', m.hrbpId, <CreatePersonSelect asOf={asOf} follow={follow} />),
    field('location', m.location, <Input maxLength={500} />),
  ];
}
export function OrgCreate(props: Props) {
  const { parentId, date, access } = props;
  const session = useSession();
  const asOf = orgCreateDate(date, tenantDate(new Date(), session.timezone), access.field('establishedOn'));
  const key = parentId ? `child:${parentId}` : 'new';
  // 新建没有原单可回查：所有新建入口共用集合路径这一个恢复槽，结果未知时都保持锁定，待刷新列表核对（F-123 §2）。
  const record = useRecordCommand({ resource: orgCreateResource, project: (row: OrgRow) => row });
  return (
    <FormOverlay
      mode="modal"
      recordKey={`${key}@${asOf}`}
      submission={record.command}
      open
      title={parentId ? m.createChild : m.create}
      initialValues={{ establishedOn: asOf, adminParent: parentId }}
      onClose={() => {
        record.command.clear();
        props.onClose();
      }}
      onSubmit={async (values) => {
        await record.save(values, { path: orgCreateResource, method: 'POST', build: orgCreateBody });
        props.onSaved();
      }}
      groups={[{ title: m.basic, fields: createFields(access, asOf) }]}
    />
  );
}
