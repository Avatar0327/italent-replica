import { Alert, Button, Checkbox, Form, Input, Modal, Radio, Space, Table } from 'antd';
import { DATA_OPERATIONS } from '@italent/domain';
import { rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock } from '../foundation/forms/FormLock.js';
import { fieldKey, type DialogMode, type FieldRow } from './object-dialog-model.js';
import { useObjectDialog } from './useObjectDialog.js';
import { om } from './object-messages.js';
type Editor = ReturnType<typeof useObjectDialog>;
export function ObjectPermissionDialog({
  id,
  objectCode,
  mode,
  editable,
  close,
  saved,
}: {
  id: string;
  objectCode: string;
  mode: DialogMode;
  editable: boolean;
  close(): void;
  saved(): void;
}) {
  const editor = useObjectDialog(id, objectCode, mode, editable, saved);
  const labels =
    mode === 'data-operations'
      ? { create: om.create, update: om.update, delete: om.delete }
      : Object.fromEntries(
          Object.values(editor.snapshot?.rows ?? {}).flatMap((row) =>
            (['view', 'edit'] as const).map((kind) => [fieldKey(row.fieldCode, kind), `${row.fieldCode} ${om[kind]}`]),
          ),
        );
  return (
    <Modal
      open
      centered
      width={910}
      rootClassName="profile-permission-modal"
      title={mode === 'fields' ? om.fieldsTitle : om.dataTitle}
      onCancel={close}
      closable={!editor.command.busy}
      maskClosable={!editor.command.busy}
      keyboard={!editor.command.busy}
      footer={<DialogActions editor={editor} editable={editable} close={close} />}
    >
      <CommandStatus submission={editor.command} labels={labels} />
      {!!editor.error && (
        <Alert
          type="error"
          showIcon
          message={rejectionMessage(editor.error)}
          action={<Button onClick={editor.retry}>{om.retry}</Button>}
        />
      )}
      {!!editor.notice && <Alert type="info" message={editor.notice} />}
      <Alert
        type={mode === 'fields' ? 'warning' : 'info'}
        showIcon
        message={mode === 'fields' ? om.fieldsNotice : om.dataNotice}
      />
      {mode === 'fields' && (
        <Space className="profile-field-search">
          <Input
            aria-label={om.code}
            placeholder={om.code}
            maxLength={100}
            value={editor.code}
            disabled={editor.command.locked || !!editor.command.blocked || editor.loading}
            onChange={(event) => editor.setCode(event.target.value)}
            onPressEnter={editor.apply}
          />
          <Button onClick={editor.apply} disabled={editor.command.locked || !!editor.command.blocked}>
            {om.query}
          </Button>
        </Space>
      )}
      <FormLock locked={editor.locked}>
        <Form form={editor.form} disabled={editor.locked} layout="horizontal" className="profile-permission-form">
          {mode === 'fields' ? <FieldPermissions editor={editor} /> : <DataPermissions />}
        </Form>
      </FormLock>
    </Modal>
  );
}
function DialogActions({ editor, editable, close }: { editor: Editor; editable: boolean; close(): void }) {
  return (
    <Space>
      <Button onClick={close} disabled={editor.command.busy}>
        {om.cancel}
      </Button>
      {editor.command.status === 'unknown' && editable && (
        <Button onClick={() => void editor.replay()}>{om.replay}</Button>
      )}
      {editable && (
        <Button
          type="primary"
          disabled={editor.locked || !editor.snapshot}
          loading={editor.command.busy}
          onClick={() => void editor.submit()}
        >
          {om.confirm}
        </Button>
      )}
    </Space>
  );
}
function DataPermissions() {
  return DATA_OPERATIONS.map((key) => (
    <Form.Item key={key} name={key} label={om[key]}>
      <Radio.Group>
        <Radio value={true} aria-label={`${om[key]} ${om.on}`}>
          {om.on}
        </Radio>
        <Radio value={false} aria-label={`${om[key]} ${om.off}`}>
          {om.off}
        </Radio>
      </Radio.Group>
    </Form.Item>
  ));
}
function FieldPermissions({ editor }: { editor: Editor }) {
  const control = (row: FieldRow, kind: 'view' | 'edit') => (
    <Form.Item noStyle name={fieldKey(row.fieldCode, kind)} valuePropName="checked">
      <Checkbox
        aria-label={`${row.fieldCode} ${om[kind]}`}
        disabled={editor.locked || (kind === 'edit' && row.system)}
      />
    </Form.Item>
  );
  return (
    <Table
      rowKey="fieldCode"
      loading={editor.loading}
      size="small"
      scroll={{ y: 340 }}
      dataSource={(editor.result?.items ?? []).flatMap((row) => {
        const current = editor.snapshot?.rows[row.fieldCode];
        return current ? [current] : [];
      })}
      pagination={{
        ...editor.page,
        total: editor.result?.total ?? 0,
        showTotal: om.total,
        showSizeChanger: {
          labelRender: ({ value }) => `${value}${om.perPage}`,
          optionRender: ({ value }) => `${value}${om.perPage}`,
        },
        pageSizeOptions: [100, 200, 500],
        disabled: editor.command.locked || !!editor.command.blocked,
        onChange: (current, pageSize) =>
          editor.setPage({ current: pageSize === editor.page.pageSize ? current : 1, pageSize }),
      }}
      columns={[
        { title: om.fieldName, width: '33%', render: () => om.empty },
        { title: om.code, dataIndex: 'fieldCode', width: '50%' },
        { title: om.view, width: '8.5%', render: (_, row) => control(row, 'view') },
        { title: om.edit, width: '8.5%', render: (_, row) => control(row, 'edit') },
      ]}
    />
  );
}
