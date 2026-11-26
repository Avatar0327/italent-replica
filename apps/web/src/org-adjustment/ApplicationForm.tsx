import { Button, Input, Popover } from 'antd';
import { labels, text } from './messages.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { display, rangeLabel, type Detail, type RangeOrg } from './model.js';
import { FormOrgChoice } from './OrgChoice.js';
import type { useAdjustmentCommand } from './commands.js';

export function EditorPlaceholder({ disabled }: { disabled: boolean }) {
  return (
    <Popover trigger="click" content={text.editorPlaceholder}>
      <Button disabled={disabled}>{text.editor}</Button>
    </Popover>
  );
}

export function ApplicationForm({
  row,
  command,
  onClose,
}: {
  row?: Detail;
  command: ReturnType<typeof useAdjustmentCommand>;
  onClose(): void;
}) {
  const { access } = command;
  const latest = command.form.state?.latest?.values;
  const editable = row ? access.edit : access.add;
  const effectiveDate = latest ? (latest.effectiveDate as string | undefined) : row?.effectiveDate;
  const field = (name: keyof typeof labels, control: FormField['control'], fixed?: string): FormField => {
    const permission = access.field(name);
    return {
      name,
      label: labels[name],
      control,
      display: fixed,
      access: { ...permission, editable: editable && permission.editable },
    };
  };
  const range = (latest ? latest.rangeDisplay : row?.adjustmentRange) as RangeOrg[] | undefined;
  const orgId = (latest ? latest.approvalSubjectOrgId : row?.approvalSubjectOrgId) as string | undefined;
  const orgName = (latest ? latest.approvalSubjectOrgName : row?.approvalSubjectOrgName) as string | undefined;
  const fields = [
    { ...field('subject', <Input aria-label={labels.subject} maxLength={100} />), rules: [{ required: true }] },
    { ...field('effectiveDate', <TenantDatePicker />), rules: [{ required: true }] },
    {
      ...field(
        'adjustmentRange',
        <FormOrgChoice
          label={labels.adjustmentRange}
          asOf={effectiveDate}
          multiple
          selected={range?.map(({ orgId, name }) => ({ id: orgId, name }))}
        />,
        rangeLabel(range),
      ),
      requiredMark: true,
    },
    {
      ...field(
        'approvalSubjectOrgId',
        <FormOrgChoice
          label={labels.approvalSubjectOrgId}
          asOf={effectiveDate}
          selected={orgId ? [{ id: orgId, name: orgName }] : []}
        />,
        display(orgName),
      ),
      rules: [{ required: true }],
    },
    field('content', <Input.TextArea aria-label={labels.content} maxLength={1000} showCount />),
  ];
  return (
    <FormOverlay
      open
      mode="modal"
      title={text.application}
      recordKey={row?.id ?? 'new'}
      groups={[{ title: '', fields }]}
      initialValues={command.baseline}
      submission={{ ...command.form, locked: command.form.locked || !editable }}
      notice={command.race}
      footerExtra={editable && <EditorPlaceholder disabled={command.form.locked} />}
      onClose={onClose}
      onSubmit={(values) =>
        command.send(
          row ? 'edit' : 'create',
          { ...values, ...(!row && { adjustmentRange: values.adjustmentRange ?? [] }) },
          fields.filter((item) => item.access.editable).map(({ name }) => name),
        )
      }
    />
  );
}
