import { defaultRegularizationDate } from '@italent/domain';
import { Alert, Button, Form, Input, Modal, Radio, Select, Space, message, type FormInstance } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Latest } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import type { Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useBusinessRead, useInternDraft, type ApplicationDraft } from '../intern/commands.js';
import { acceptBusiness } from '../intern/model.js';
import { WithOpening } from '../intern/RegularizeForm.js';
import { useRead } from '../part-time/useRead.js';
import { useProbationCommand, type ProbationCommand, type Send } from './commands.js';
import { m } from './messages.js';
import {
  acceptAdjust,
  acceptRegularizations,
  adjustBody,
  adjustChanges,
  adjustFields,
  apiRoot,
  applicationBody,
  businesses,
  destinationOf,
  employees,
  monthOptions,
  object,
  probationPath,
  probationValues,
  regularizationsBody,
  regularizations,
  regularizeFields,
  validateAdjust,
  validateRegularize,
  type Pinned,
  type ProbationView,
  type ReceiptItem,
  type Row,
} from './model.js';

export interface FormProps {
  row: Row;
  onClose(): void;
  onDone(): void;
  /** 写后刷新；带视图时切到目的视图（直接转正 → 已转正，申请提交 → 转正审批中）。 */
  refresh(view?: ProbationView): Promise<unknown>;
}

/** 打开基线与 409 重读共用一个读取：试用详情的 revision 与值来自同一次响应。 */
function useProbationRead(employeeId: string, project: (values: Values) => Values = (values) => values) {
  const api = useApiClient();
  return useCallback(async (): Promise<Latest> => {
    const { revision, values } = probationValues(await api.request(probationPath(employeeId)), employeeId);
    return { id: employeeId, revision, values: project(values) };
  }, [api, employeeId, project]);
}

type FieldProps = { name: string; label: string; required?: boolean; children: ReactNode };
function Field({ name, label, required, children }: FieldProps) {
  return (
    <Form.Item name={name} label={label} required={required}>
      <LockedField>{children}</LockedField>
    </Form.Item>
  );
}
const date = (label: string) => <Input type="date" aria-label={label} />;

type ShellProps = Pick<FormProps, 'onClose'> & {
  title: string;
  cmd: ProbationCommand;
  error: unknown;
  locked: boolean;
};
function Shell(props: ShellProps & { onSubmit(): void; okText?: string; children: ReactNode }) {
  const { cmd, error, locked } = props;
  return (
    <Modal
      open
      title={props.title}
      maskClosable={false}
      closable={!cmd.form.busy}
      onCancel={props.onClose}
      footer={
        <Space>
          <Button onClick={props.onClose} disabled={cmd.form.busy}>
            {m.cancel}
          </Button>
          <Button type="primary" loading={cmd.form.busy} disabled={locked} onClick={props.onSubmit}>
            {props.okText ?? m.save}
          </Button>
        </Space>
      }
    >
      <CommandStatus submission={cmd.form} labels={m.fields} />
      {!!error && !cmd.form.state?.error && <Alert type="error" showIcon message={rejectionMessage(error)} />}
      <FormLock locked={locked}>{props.children}</FormLock>
    </Modal>
  );
}

/** 提交入口：字段级错误（本地校验、服务端 fieldErrors）挂到字段上并保留输入，其余错误显示在弹窗顶部。 */
function useSubmit(form: FormInstance, run: (values: Values) => Promise<void>) {
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    setError(undefined);
    try {
      await run(form.getFieldsValue(true) as Values);
    } catch (cause) {
      const fields = cause instanceof ApiError ? cause.fieldErrors : [];
      form.setFields(fields);
      if (!fields.length) setError(cause);
    }
  };
  return { error, submit };
}

/** B6 编辑试用期：PUT /employees/:id/probation，If-Match = 员工 revision。 */
export function AdjustForm(props: FormProps) {
  const read = useProbationRead(props.row.employeeId!);
  return (
    <WithOpening read={read} title={m.entries.edit} onClose={props.onClose}>
      {(opening) => <AdjustEditor {...props} opening={opening} read={read} />}
    </WithOpening>
  );
}
type EditorProps = FormProps & { application?: boolean; opening: Latest; read(): Promise<Latest> };
function AdjustEditor({ row, onClose, onDone, refresh, opening, read }: EditorProps) {
  const employeeId = row.employeeId!;
  const permissions = usePermissions(object);
  const [form] = Form.useForm();
  const target = { id: employeeId, revision: opening.revision, baseline: opening.values, read };
  const cmd = useProbationCommand(employees, target, 'adjust-probation', () => refresh());
  useDraftRefill(cmd.form, adjustFields, form);
  const locked =
    cmd.disabled || !permissions.snapshot.objects[object]?.dataOperations.update || !permissions.can('Employment.Edit');
  const { error, submit } = useSubmit(form, async (values) => {
    validateAdjust(values);
    const send: Send = {
      method: 'PUT',
      path: probationPath(employeeId),
      body: adjustBody,
      accept: (raw, sent) => ({
        path: slotKey(employees, employeeId),
        id: employeeId,
        revision: acceptAdjust(raw, employeeId, sent),
      }),
    };
    if (!(await cmd.submit(values, adjustFields, send))) return;
    void message.success(m.success.edit);
    onDone();
  });
  return (
    <Shell
      title={m.entries.edit}
      cmd={cmd}
      error={error}
      locked={locked}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <AdjustFields form={form} initial={opening.values} locked={locked} />
    </Shell>
  );
}

function AdjustFields({ form, initial, locked }: { form: FormInstance; initial: Values; locked: boolean }) {
  const has = Form.useWatch('hasProbation', form) === true;
  return (
    <Form
      form={form}
      layout="vertical"
      disabled={locked}
      initialValues={initial}
      onValuesChange={(changed: Values, all: Values) => form.setFieldsValue(adjustChanges(changed, all))}
    >
      <Field name="hasProbation" label={m.fields.hasProbation!} required>
        <Radio.Group
          aria-label={m.fields.hasProbation}
          options={[
            { value: true, label: m.yes },
            { value: false, label: m.no },
          ]}
        />
      </Field>
      {has && (
        <>
          <Field name="startDate" label={m.fields.startDate!} required>
            {date(m.fields.startDate!)}
          </Field>
          <Field name="months" label={m.fields.months!}>
            <Select
              allowClear
              aria-label={m.fields.months}
              options={monthOptions.map((n) => ({ value: n, label: m.months(n) }))}
            />
          </Field>
          <Field name="expectedEndDate" label={m.fields.expectedEndDate!} required>
            {date(m.fields.expectedEndDate!)}
          </Field>
        </>
      )}
      <Field name="regularizationDate" label={m.fields.regularizationDate!}>
        {date(m.fields.regularizationDate!)}
      </Field>
    </Form>
  );
}

/** 试用结果字典（GET /probation-results?enabled=true），转正时提交编码。 */
function useResults() {
  const result = useRead<{ items: { code: string; name: string }[] }>(`${apiRoot}/probation-results?enabled=true`);
  return { ...result, options: (result.data?.items ?? []).map((item) => ({ value: item.code, label: item.name })) };
}
const openingRegularize = (values: Values): Values => ({
  effectiveDate: typeof values.expectedEndDate === 'string' ? defaultRegularizationDate(values.expectedEndDate) : null,
  probationResult: null,
});

/** B7 直接转正 / B8 转正申请：转正日期默认预计结束日次日（F-205），试用结果必填。 */
export function RegularizeForm(props: FormProps & { application?: boolean }) {
  const read = useProbationRead(props.row.employeeId!, openingRegularize);
  const title = props.application ? m.entries.apply : m.entries.regularize;
  return (
    <WithOpening read={read} title={title} onClose={props.onClose}>
      {(opening) => <RegularizeEditor {...props} opening={opening} read={read} />}
    </WithOpening>
  );
}
/** 直接转正（/regularizations 单人）与申请两步的提交定义；写后回读按单据状态定目的视图。 */
function useSends(employeeId: string, revision: number, created: (draft: ApplicationDraft) => void) {
  const destination = useRef<ProbationView>(undefined);
  const verify = (latest: Values) => {
    destination.current = destinationOf(latest.status);
    if (latest.employeeId !== employeeId || !destination.current) throw new Error(m.invalidReceipt);
  };
  const direct: Send = {
    path: regularizations,
    ifMatch: false,
    body: (values) => regularizationsBody(values, [{ employeeId, revision }]),
    accept: (raw) => {
      const id = acceptRegularizations(raw, [{ employeeId, revision }]).succeeded[0]!.businessId!;
      return { path: slotKey(businesses, id), id, revision: 0, verify };
    },
  };
  const step = (id?: string): Send => ({
    path: id ? `${slotKey(businesses, id)}/submit` : `${slotKey(employees, employeeId)}/businesses`,
    body: id ? () => ({}) : applicationBody,
    accept: (raw, sent) => {
      const receipt = acceptBusiness(raw, { employeeId, kind: 'regularization', sent, id });
      if (receipt.status !== (id ? 'in_review' : 'draft') || receipt.mode !== 'application')
        throw new Error(m.invalidReceipt);
      // 草稿值由调用方取实际提交的表单值
      if (!id) created({ id: String(receipt.id), revision: Number(receipt.revision), values: {} });
      return {
        path: slotKey(businesses, String(receipt.id)),
        id: String(receipt.id),
        revision: Number(receipt.revision),
        verify: id ? verify : undefined,
      };
    },
  });
  return { direct, step, destination };
}

function RegularizeEditor({ row, application, onClose, onDone, refresh, opening, read }: EditorProps) {
  const employeeId = row.employeeId!;
  const permissions = usePermissions(object);
  const permission = permissions.snapshot.objects[object];
  const saved = useInternDraft(`probation/${employeeId}`);
  const draft = application ? saved.draft : undefined;
  const [form] = Form.useForm();
  const results = useResults();
  // 第二步的 If-Match 是草稿单 revision：409 重读读草稿单，恢复槽仍是员工（换入口也绕不开未知锁）
  const readDraft = useBusinessRead(draft?.id ?? '');
  const reread = draft ? async () => ({ ...(await readDraft()), id: employeeId, values: draft.values }) : read;
  const baseline = draft?.values ?? opening.values;
  const target = { id: employeeId, revision: draft?.revision ?? opening.revision, baseline, read: reread };
  const cmd = useProbationCommand(employees, target, application ? 'apply' : 'regularize', () => refresh());
  useDraftRefill(cmd.form, regularizeFields, form);
  const autoSubmit = useRef(false);
  const locked =
    cmd.disabled ||
    !results.options.length ||
    !permission?.dataOperations.create ||
    !permissions.can('Employment.Create') ||
    (!!application && (!permission?.dataOperations.update || !permissions.can('Employment.Submit')));
  const { direct, step, destination } = useSends(employeeId, opening.revision, (created) =>
    saved.put({ ...created, values: form.getFieldsValue(true) as Values }),
  );
  const { error, submit } = useSubmit(form, async (values) => {
    if (!draft) validateRegularize(values);
    if (!(await cmd.submit(values, regularizeFields, application ? step(draft?.id) : direct))) return;
    // 建草稿已确认才自动进入第二步（同实习）；第二步失败时草稿保留，由用户显式重提同一张单
    if (application && !draft) return void (autoSubmit.current = true);
    saved.put();
    void message.success(application ? m.success.apply : m.success.regularize);
    void refresh(destination.current);
    onDone();
  });
  useEffect(() => {
    if (!autoSubmit.current || !draft) return;
    autoSubmit.current = false;
    void submit();
  });
  return (
    <Shell
      title={application ? m.entries.apply : m.entries.regularize}
      cmd={cmd}
      error={error}
      locked={locked}
      onClose={onClose}
      onSubmit={() => void submit()}
      okText={application ? m.submit : m.save}
    >
      {draft && <Alert type="info" message={m.draftCreated} />}
      {results.data && !results.options.length && <Alert type="warning" message={m.noResults} />}
      <FormLock locked={!!draft}>
        <RegularizeFields
          form={form}
          initial={draft?.values ?? opening.values}
          results={results.options}
          dateRequired
        />
      </FormLock>
    </Shell>
  );
}

type ResultOption = { value: string; label: string };
type FieldsProps = { form: FormInstance; initial: Values; results: ResultOption[]; dateRequired: boolean };
function RegularizeFields(props: FieldsProps) {
  return (
    <Form form={props.form} layout="vertical" initialValues={props.initial}>
      <Field name="effectiveDate" label={m.fields.regularizationDate!} required={props.dateRequired}>
        {date(m.fields.regularizationDate!)}
      </Field>
      <Field name="probationResult" label={m.fields.probationResult!} required>
        <Select aria-label={m.fields.probationResult} options={props.results} />
      </Field>
    </Form>
  );
}

/** 批量转正（PB-R8，≤100 人）：统一转正日期可不填（各按预计结束日次日）；逐人回执，失败的人列出原因。 */
export function BatchForm({ rows, onClose, onDone, refresh }: Omit<FormProps, 'row'> & { rows: Row[] }) {
  const permissions = usePermissions(object);
  const [form] = Form.useForm();
  const results = useResults();
  const items: Pinned[] = rows.map((row) => ({ employeeId: row.employeeId!, revision: row.revision! }));
  const objects = items.map((item) => ({ id: item.employeeId, revision: item.revision }));
  const cmd = useProbationCommand(employees, { revision: 0, baseline: {}, objects }, 'regularize', () => refresh());
  const [failed, setFailed] = useState<ReceiptItem[]>();
  const locked =
    cmd.disabled ||
    !!failed ||
    !results.options.length ||
    !permissions.snapshot.objects[object]?.dataOperations.create ||
    !permissions.can('Employment.Create');
  const { error, submit } = useSubmit(form, async (values) => {
    validateRegularize(values, false);
    let outcome: ReturnType<typeof acceptRegularizations> | undefined;
    const send: Send = {
      path: regularizations,
      ifMatch: false,
      body: (values) => regularizationsBody(values, items),
      accept: (raw) => void (outcome = acceptRegularizations(raw, items)),
    };
    if (!(await cmd.submit(values, regularizeFields, send)) || !outcome) return;
    if (outcome.succeeded.length) void message.success(m.success.batch(outcome.succeeded.length));
    if (!outcome.failed.length) return onDone();
    setFailed(outcome.failed);
  });
  const name = (id: string) => rows.find((row) => row.employeeId === id)?.name ?? m.missing;
  return (
    <Shell
      title={`${m.entries.batch}（${m.selected(rows.length)}）`}
      cmd={cmd}
      error={error}
      locked={locked}
      onClose={failed ? onDone : onClose}
      onSubmit={() => void submit()}
    >
      <Alert type="info" message={m.batchDateNote} />
      <RegularizeFields form={form} initial={{}} results={results.options} dateRequired={false} />
      {failed && (
        <Alert
          type="error"
          message={m.batchFailed}
          description={
            <ul>
              {failed.map((item) => (
                <li key={item.employeeId}>{`${name(item.employeeId)}：${item.error?.message}`}</li>
              ))}
            </ul>
          }
        />
      )}
    </Shell>
  );
}
