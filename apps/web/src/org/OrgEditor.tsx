import { App, Input, InputNumber, Radio, Select } from 'antd';
import { useState } from 'react';
import {
  ApiError,
  FormOverlay,
  TenantDatePicker,
  newCommand,
  useApiClient,
  type FormField,
} from '../foundation/index.js';
import { ReferenceSelect } from '../job/JobEditor.js';
import { orgChangeBody, orgCreateResource, type Dimension, type OrgAction, type OrgRow } from './page-model.js';
import { type PageAccess } from './page-support.js';
import { useRecordCommand } from './record-command.js';
import { slotKey } from '../foundation/forms/slot.js';
import { PersonSelect } from './PersonFields.js';
import { detailText, pageText as m } from './messages.js';
interface Props {
  original: OrgRow;
  action: OrgAction;
  date: string;
  access: PageAccess;
  onClose(): void;
  onSaved(): void;
}
type Field = (name: string, control: FormField['control'], label: string, required?: boolean) => FormField;
const yesNo = [
  { value: true, label: m.yes },
  { value: false, label: m.no },
];
/**
 * 原站变更弹窗基本信息的字段顺序（B2_09）：名称、简称、编码（只读）、上级组织、显示顺序、负责人、HRBP、虚拟组织、
 * 机构类型、所在地点；层级接口不可写，列入缺口。备注原站此处未取证（未验证），保留在最后。
 */
function changeFields(props: Props, current: OrgRow, field: Field, setters: Setters): FormField[] {
  const { original, date, access } = props;
  const code = access.field('code');
  return [
    field('name', <Input maxLength={200} onChange={(event) => setters.name(event.target.value)} />, m.formName, true),
    field('shortName', <Input maxLength={100} />, m.formShortName),
    {
      name: 'code',
      label: m.formCode,
      control: null,
      access: { visible: code.visible, editable: false },
      display: String(current.code ?? m.missing),
    },
    ...parentFields(original, date, access, setters.parent),
    field('displayOrder', <InputNumber precision={0} className="r1-wide-control" />, m.displayOrder),
    field('personInChargeId', <PersonSelect date={date} />, m.personInChargeId),
    field('hrbpId', <PersonSelect date={date} />, m.hrbpId),
    field('isVirtual', <Radio.Group options={yesNo} />, m.isVirtual, true),
    field('broadType', <Input maxLength={100} />, m.broadType, true),
    field('location', <Input maxLength={500} />, detailText.location),
    field('remarks', <Input.TextArea maxLength={4000} rows={3} />, m.remarks),
  ];
}
interface Setters {
  name(value: string): void;
  parent(value: string): void;
}
const choiceField: FormField = {
  name: 'addEmployment',
  label: m.choice,
  access: { visible: true, editable: true },
  control: (
    <Select
      options={[
        { value: 'yes', label: m.yes },
        { value: 'no', label: m.no },
      ]}
    />
  ),
  rules: [{ required: true, message: m.choiceRequired }],
};
/** 是否联动任职按当前原单（冲突核对后为最新版本）判断；重开被锁定的表单时从内核草稿恢复。 */
function useFields(props: Props, current: OrgRow, draft?: Record<string, unknown>) {
  const { action, access } = props;
  const [name, setName] = useState(String(draft?.name ?? current.name ?? ''));
  const [parent, setParent] = useState(String(draft?.adminParent ?? current.parents?.admin?.parentId ?? ''));
  const needsChoice =
    (access.field('name').editable && name.trim() !== current.name) ||
    (access.field('parents').editable && parent !== (current.parents?.admin?.parentId ?? ''));
  const field: Field = (name, control, label, required = false) => ({
    name,
    label,
    control,
    access: access.field(name),
    rules: required ? [{ required: true, message: m.required }] : undefined,
  });
  if (action === 'edit') return [field('establishedOn', <TenantDatePicker />, m.establishedOn, true)];
  if (action !== 'change') return [];
  const fields = changeFields(props, current, field, { name: setName, parent: setParent });
  return needsChoice ? [...fields, choiceField] : fields;
}
function parentFields(
  original: OrgRow,
  date: string,
  access: PageAccess,
  setParent: (value: string) => void,
): FormField[] {
  return (['admin', 'business', 'product'] as Dimension[])
    .filter((dimension) => original.parents?.[dimension])
    .map((dimension) => ({
      name: `${dimension}Parent`,
      label: `${m[dimension]} · ${m.parent}`,
      access: access.field('parents'),
      control: (
        <ReferenceSelect
          kind="org"
          date={date}
          exclude={original.id}
          onChange={(value) => {
            if (dimension === 'admin') setParent(value ?? '');
          }}
        />
      ),
      rules: [{ required: !!original.parents?.[dimension]?.parentId, message: m.required }],
    }));
}
function project(row: OrgRow) {
  const values: Record<string, unknown> = { ...row };
  for (const dimension of ['admin', 'business', 'product'] as const)
    values[`${dimension}Parent`] = row.parents?.[dimension]?.parentId;
  return values;
}
function toInput(values: Record<string, unknown>) {
  if (values.addEmployment === undefined) return values;
  return { ...values, addEmployment: values.addEmployment === 'yes' };
}
/** 写入的请求体以当前原单（冲突核对后为最新版本）为基准；内核已按基线去掉未改字段。 */
function buildBody(action: OrgAction, date: string) {
  return (body: Record<string, unknown>, current?: OrgRow) => {
    if (action === 'disable') return { effectiveDate: date, enabled: false };
    if (action === 'change' && current) return orgChangeBody(current, toInput(body), date);
    return body;
  };
}
function useConfirmPending(id: string) {
  const api = useApiClient();
  const { modal } = App.useApp();
  return async (body: Record<string, unknown>) => {
    const preview = await api.request<{ hasPendingEmployment: boolean }>(
      `/api/tenant/org/organizations/${id}/employment-preview`,
      { method: 'POST', command: newCommand(body) },
    );
    if (!preview.hasPendingEmployment) return;
    const confirmed = await new Promise<boolean>((resolve) =>
      modal.confirm({
        title: m.pending,
        content: m.pendingHint,
        okText: m.confirm,
        cancelText: m.cancel,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }),
    );
    if (!confirmed) throw new ApiError(422, 'CONFIRMATION_CANCELLED', 'fields', m.pendingHint);
  };
}
function noChange() {
  return new ApiError(422, 'VALIDATION_FAILED', 'fields', m.noChange);
}
function useSubmit(props: Props, record: ReturnType<typeof useOrgCommand>) {
  const { original, action, date } = props;
  const confirmPending = useConfirmPending(original.id);
  const current = record.current ?? original;
  return async (values: Record<string, unknown>) => {
    if (action === 'edit' && values.establishedOn === current.establishedOn) throw noChange();
    if (action === 'change') {
      const body = orgChangeBody(current, toInput(values), date);
      if (Object.keys(body).length === 1) throw noChange();
      if (body.addEmployment === true) await confirmPending(body);
    }
    await record.save(values, {
      path: `/api/tenant/org/organizations/${original.id}${action === 'edit' ? '/correction' : ''}`,
      method: 'PATCH',
      build: buildBody(action, date),
    });
    props.onSaved();
  };
}
function useOrgCommand({ original, action, date }: Props) {
  return useRecordCommand({
    // 原单路径作键：行内、详情、换日期或换动作重开都进同一个槽；动作与日期作为命令上下文存在槽里（F-123 页面片接入 2）。
    resource: slotKey(orgCreateResource, original.id),
    context: { action, date },
    original,
    readPath: (id, context) => `/api/tenant/org/organizations/${id}?asOf=${context.date}`,
    project,
  });
}
const readOnly = { visible: true, editable: false };
/** 只读说明行：不进请求体（FormOverlay 只提交可编辑字段）。 */
export const info = (name: string, label: string, display: FormField['display']): FormField => ({
  name,
  label,
  display,
  control: null,
  access: readOnly,
});
/** 原站弹窗顶部的确认说明（变更 B2_09、停用 B2_07）与日期；停用另显示被停用的组织（只读）。 */
function headerFields({ action, date, original }: Props, resumed: boolean): FormField[] {
  const notice = {
    edit: m.editHint,
    change: m.changeNotice,
    // 原站停用弹窗只有确认说明；级联停用与占用拒绝是复刻服务端口径，一并提示。
    disable: `${m.disableNotice}。${m.disableHint}`,
  }[action];
  return [
    info('__hint', m.notice, notice),
    ...(resumed ? [info('__resumed', m.resumedLabel, m.resumed)] : []),
    ...(action === 'change' ? [info('__date', m.changeDate, date)] : []),
    ...(action === 'disable'
      ? [info('__date', m.disableDate, date), info('__target', m.disableTarget, original.name ?? m.unavailable)]
      : []),
  ];
}
export function OrgEditor(opened: Props) {
  const record = useOrgCommand(opened);
  // 槽里有未确认的命令时按它的动作与日期打开，不按本次入口另起命令。
  const props: Props = { ...opened, ...record.context };
  const { original, action } = props;
  const current = record.current ?? original;
  const fields = useFields(props, current, record.command.state?.values);
  const onSubmit = useSubmit(props, record);
  const close = () => {
    record.command.clear();
    props.onClose();
  };
  return (
    <FormOverlay
      mode="modal"
      recordKey={original.id}
      submission={record.command}
      open
      title={`${m[action]} · ${original.name ?? m.detail}`}
      onClose={close}
      initialValues={project(original)}
      onSubmit={onSubmit}
      groups={[
        {
          title: m.basic,
          fields: [...headerFields(props, record.resumed), ...fields],
        },
      ]}
    />
  );
}
