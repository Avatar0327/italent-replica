import { Alert, Button, Form, Input, Space, Table } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { ApiError } from '../foundation/client.js';
import { useEvaluationForm } from './useEvaluationForm.js';
import { evUi, MissingFields, Unavailable } from './alignment.js';
import { RemoteSelect } from './runtime.js';
import { EV } from './ActivityFields.js';
import { records, type Row } from './model.js';
import { m, textValue } from './messages.js';

const fields = [
  'name',
  'ownerOrgId',
  'scoreMode',
  'fullScore',
  'passScore',
  'totalRule',
  'votePassRatio',
  'indicatorReference',
];
type EditorProps = { row: Row; close(): void; saved(): void };
function useFormEditor({ row, close, saved }: EditorProps) {
  const permission = usePermissions('TEvaluation.EvaluationForm');
  const writer = useEvaluationForm(`${EV}/evaluation-forms`, row);
  const [form] = Form.useForm();
  const [error, setError] = useState<unknown>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = writer.current!;
  const allowed =
    permission.can('update') && !!permission.snapshot.objects['TEvaluation.EvaluationForm']?.dataOperations.update;
  const editable = ['name', 'ownerOrgId'].filter((field) => allowed && permission.field(field).editable);
  useDraftRefill(writer, editable, form);
  const scoreMode = Form.useWatch('scoreMode', form) ?? current.scoreMode;
  const visible = fields.filter(
    (key) =>
      permission.field(key).visible &&
      (!['fullScore', 'passScore', 'totalRule'].includes(key) || scoreMode !== 'by_vote') &&
      (key !== 'totalRule' || scoreMode === 'by_indicator') &&
      (!['votePassRatio', 'indicatorReference'].includes(key) || scoreMode === 'by_vote'),
  );
  const save = async () => {
    if (writer.locked || !allowed) return;
    setError(undefined);
    try {
      await form.validateFields();
      await writer.save(
        form.getFieldsValue(true),
        editable.filter((key) => visible.includes(key)),
        'PATCH',
      );
      writer.clear();
      if (alive.current) {
        saved();
        close();
      }
    } catch (cause) {
      if (alive.current) {
        setError(cause);
        if (cause instanceof ApiError) form.setFields(cause.fieldErrors);
      }
    }
  };
  return { writer, form, error, permission, current, allowed, editable, visible, save };
}
export function EvaluationFormEditor(props: EditorProps) {
  const state = useFormEditor(props);
  const { row, close } = props;
  const { writer, form, error, permission, current, allowed, save } = state;
  return (
    <section className="evaluation-full-page" aria-label={evUi.formEdit}>
      <header>
        <h1>{evUi.formEdit}</h1>
      </header>
      <CommandStatus submission={writer} labels={{ ...m, ...evUi }} />
      {!!error && <Alert type="error" message={error instanceof Error ? error.message : m.failed} />}
      <FormLock locked={writer.locked}>
        <Form form={form} layout="vertical" initialValues={row} disabled={writer.locked}>
          <EditorFields state={state} keys={['name', 'ownerOrgId']} />
          <h2 className="r3b-section">{evUi.staffArea}</h2>
          <MissingFields labels={evUi.staffFields} />
          <h2 className="r3b-section">{evUi.scoringArea}</h2>
          <MissingFields labels={evUi.scoringFields} />
          {permission.field('items').visible && (
            <>
              <h3>{evUi.items}</h3>
              <Table
                rowKey={(_, index) => String(index)}
                pagination={false}
                dataSource={records(current.items)}
                columns={[
                  {
                    title: '分类',
                    width: 110,
                    render: (_, item) => (item.kind === 'standard' ? evUi.standard : evUi.general),
                  },
                  { title: evUi.items, width: 139, render: (_, item) => textValue(item.name) },
                  {
                    title: evUi.hiddenTargets,
                    width: 691,
                    render: (_, item) =>
                      records(item.hiddenTargets)
                        .map((target) => textValue(target.name ?? target.id))
                        .join('、') || m.noValue,
                  },
                ]}
              />
              <Space>
                <Unavailable label={evUi.standard} reason={evUi.unverified} />
                <Unavailable label={evUi.general} reason={evUi.unverified} />
              </Space>
            </>
          )}
          <EditorFields state={state} keys={fields.slice(2)} />
          <h2 className="r3b-section">{evUi.resultArea}</h2>
          <MissingFields labels={evUi.resultFields} />
        </Form>
      </FormLock>
      <footer className="evaluation-footer">
        <Space>
          <Button disabled={writer.busy} onClick={close}>
            {m.cancel}
          </Button>
          <Unavailable label={evUi.preview} reason={evUi.unverified} />
          {allowed && (
            <Button type="primary" loading={writer.busy} disabled={writer.locked} onClick={() => void save()}>
              {evUi.confirm}
            </Button>
          )}
        </Space>
      </footer>
    </section>
  );
}

function EditorFields({ state, keys }: { state: ReturnType<typeof useFormEditor>; keys: string[] }) {
  const { editable, visible, current } = state;
  return (
    <div className="r3b-form-grid">
      {keys
        .filter((key) => visible.includes(key))
        .map((key) => (
          <Form.Item
            key={key}
            name={editable.includes(key) ? key : undefined}
            label={key === 'name' ? evUi.formName : key === 'ownerOrgId' ? m.ownerOrgId : evUi[key as 'scoreMode']}
            required
            rules={editable.includes(key) ? [{ required: true, message: m.required }] : []}
          >
            {editable.includes(key) ? (
              <LockedField>
                {key === 'name' ? <Input maxLength={100} /> : <RemoteSelect path="/api/tenant/org/organizations" />}
              </LockedField>
            ) : (
              <span>{String(evUi[current[key] as 'by_indicator'] ?? textValue(current[key]))}</span>
            )}
          </Form.Item>
        ))}
    </div>
  );
}
