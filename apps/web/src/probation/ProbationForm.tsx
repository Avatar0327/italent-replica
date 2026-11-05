import { defaultRegularizationDate } from '@italent/domain';
import { Alert, Button, Form, Input, Modal, Radio, Select, Space, Typography, message, type FormInstance } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, rejectionMessage } from '../foundation/client.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Latest } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields, sameValue, type Values } from '../foundation/forms/values.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { PageState } from '../foundation/PageState.js';
import type { ApplicationDraft } from '../intern/commands.js';
import { acceptBusiness } from '../intern/model.js';
import { WithOpening } from '../intern/RegularizeForm.js';
import { useRead } from '../part-time/useRead.js';
import {
  regularizeSend,
  targetOf,
  useProbationCommand,
  type Confirmed,
  type ProbationCommand,
  type Send,
} from './commands.js';
import { useRegularizationRecovery, type Recovery } from './draft.js';
import { m } from './messages.js';
import {
  acceptAdjust,
  acceptRegularizations,
  adjustBody,
  adjustChanges,
  adjustFields,
  apiRoot,
  acceptTemporary,
  applicationBody,
  businesses,
  destinationOf,
  draftPatchBody,
  employees,
  monthOptions,
  object,
  probationPath,
  probationValues,
  recoveredDraft,
  regularizationReceipt,
  regularizationsBody,
  regularizations,
  regularizationDraftPath,
  regularizeFieldsFor,
  temporaryBody,
  temporaryOf,
  validateAdjust,
  validateRegularize,
  type Pinned,
  type ProbationView,
  type ReceiptItem,
  type Row,
  type Temporary,
} from './model.js';

export interface FormProps {
  row: Row;
  onClose(): void;
  onDone(): void;
  /** 写后刷新；带视图时切到目的视图（直接转正 → 已转正，申请提交 → 转正审批中）。 */
  refresh(view?: ProbationView): Promise<unknown>;
}

const unchanged = (values: Values) => values;
/** 打开基线与 409 重读共用一个读取：试用详情的 revision 与值来自同一次响应；投影须是稳定引用，否则上层重渲染即重读。 */
export function useProbationRead(employeeId: string, project: (values: Values) => Values = unchanged) {
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
const date = (label: string, disabled = false) => <Input type="date" aria-label={label} disabled={disabled} />;

type ShellProps = Pick<FormProps, 'onClose'> & {
  title: string;
  cmd: ProbationCommand;
  error: unknown;
  locked: boolean;
  /** 只锁提交、不锁表单（如新建时没有启用的试用结果：仍可编辑、暂存，rf347_1 P2-5）。 */
  submitLocked?: boolean;
};
function Shell(props: ShellProps & { onSubmit(): void; okText?: string; extra?: ReactNode; children: ReactNode }) {
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
          {props.extra}
          <Button
            type="primary"
            loading={cmd.form.busy}
            disabled={locked || props.submitLocked}
            onClick={props.onSubmit}
          >
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
  const target = targetOf(employeeId, opening, read);
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
/**
 * 下拉选项 = 已存结果（保存时的名称）∪ 其余启用项：已存结果的名称快照优先于字典当前名称，停用 / 改名后仍按保存时
 * 的名称显示（F-347 b / e；rf347_1 P2-7：字典到了也不换成当前名称）。
 */
function withSaved(options: ResultOption[], names: Values): ResultOption[] {
  const saved = Object.entries(names).map(([code, name]) => ({ value: code, label: String(name) }));
  return [...saved, ...options.filter((option) => !Object.hasOwn(names, option.value))];
}
const openingRegularize = (values: Values): Values => ({
  effectiveDate: typeof values.expectedEndDate === 'string' ? defaultRegularizationDate(values.expectedEndDate) : null,
  probationResult: null,
});

/** B7 直接转正 / B8 转正申请：转正日期默认预计结束日次日（F-205），试用结果必填。 */
export function RegularizeForm(props: FormProps & { application?: boolean }) {
  const read = useProbationRead(props.row.employeeId!, openingRegularize);
  const recovery = useRegularizationRecovery(props.row.employeeId!, !!props.application);
  const title = props.application ? m.entries.apply : m.entries.regularize;
  // 申请先读服务端暂存与草稿单（F-347）；读取失败不当作没有草稿开表单，否则会另建第二张
  if (!recovery.done)
    return (
      <Modal open title={title} footer={null} onCancel={props.onClose}>
        <PageState kind={recovery.error ? 'error' : 'loading'} error={recovery.error} retry={recovery.retry} />
      </Modal>
    );
  return (
    <WithOpening read={read} title={title} onClose={props.onClose}>
      {(opening) => <RegularizeEditor {...props} opening={opening} read={read} recovery={recovery.recovery} />}
    </WithOpening>
  );
}
/**
 * 直接转正（/regularizations 单人）与申请两步的提交定义；写后回读按单据状态定目的视图。
 * 直接转正的员工 revision 在请求体里：取内核本次命令的版本，冲突核对后重提即带最新版本。
 * 草稿单（撤回单 / 第二步失败的单）改了内容先 PATCH 同一张单（F-347 c），确认后再提交；PATCH 只带与内核给的
 * base（If-Match 那个 revision 的服务端值）不同的项，不另持打开时的值（rf347_2 P2-1）。
 */
function useSends(
  employeeId: string,
  fields: readonly string[],
  saved: (draft: ApplicationDraft, sent: Values) => void,
) {
  const destination = useRef<ProbationView>(undefined);
  const verify = (latest: Values) => {
    destination.current = destinationOf(latest.status);
    if (latest.employeeId !== employeeId || !destination.current) throw new Error(m.invalidReceipt);
  };
  const direct: Send = {
    path: regularizations,
    ifMatch: false,
    body: (values, revision) => regularizationsBody(values, [{ employeeId, revision }]),
    accept: (raw, revision) => {
      const id = acceptRegularizations(raw, [{ employeeId, revision }]).succeeded[0]!.businessId!;
      return { path: slotKey(businesses, id), id, revision: 0, verify };
    },
  };
  // 建草稿 / 改草稿的回执：仍是这名员工的转正申请草稿；草稿值由调用方取实际提交的表单值
  const kept = (raw: Values, sent: number, id?: string) => {
    const receipt = acceptBusiness(raw, { employeeId, kind: 'regularization', sent, id });
    if (receipt.status !== 'draft' || receipt.mode !== 'application') throw new Error(m.invalidReceipt);
    return { id: String(receipt.id), revision: Number(receipt.revision) };
  };
  const step = (id?: string): Send => ({
    path: id ? `${slotKey(businesses, id)}/submit` : `${slotKey(employees, employeeId)}/businesses`,
    body: id ? () => ({}) : applicationBody,
    accept: (raw, sent) => {
      if (id) {
        const receipt = acceptBusiness(raw, { employeeId, kind: 'regularization', sent, id });
        if (receipt.status !== 'in_review' || receipt.mode !== 'application') throw new Error(m.invalidReceipt);
        return { path: slotKey(businesses, id), id, revision: Number(receipt.revision), verify };
      }
      const made = kept(raw, sent);
      return { path: slotKey(businesses, made.id), ...made };
    },
  });
  const patch = (id: string, values: Values): Send => ({
    method: 'PATCH',
    path: slotKey(businesses, id),
    body: (sent, _revision, base) => draftPatchBody(sent, base, fields),
    accept: (raw, sent) => {
      const made = kept(raw, sent, id);
      saved({ ...made, values: {} }, values);
      return { path: slotKey(businesses, id), ...made };
    },
  });
  return {
    direct,
    step: (id?: string, values?: Values): Send => {
      const send = step(id);
      if (id || !values) return send;
      return {
        ...send,
        accept: (raw, sent) => {
          const check = send.accept(raw, sent)!;
          saved({ id: check.id, revision: check.revision, values: {} }, values);
          return check;
        },
      };
    },
    patch,
    destination,
  };
}

type FoundDraft = ApplicationDraft & { names: Values };
/** 读一张草稿单（GET /businesses/:id）并投影成表单值：仍是这名员工停在草稿的转正申请，否则按回执无效。 */
function useDraftRead(employeeId: string) {
  const api = useApiClient();
  return async (id: string): Promise<FoundDraft> => {
    const latest = recoveredDraft(await api.request<Values>(slotKey(businesses, id)), employeeId, id);
    if (!latest) throw new Error(m.invalidReceipt);
    return latest;
  };
}

/**
 * 暂存（DEC-709）：PUT 覆盖写同一份，If-Match = 暂存 revision；不校验必填、不建单。
 * 409 重读（rf347_1 P2-6）读同一个暂存视图：revision 与暂存内容来自同一次 GET，已改的输入保留，核对后显式重提；
 * 视图里有申请草稿单（别人在本页打开后建的，P2-3）时交 found 进入那张单。
 * 冲突基线（rf347_2 P2-2）：打开时是恢复的暂存（没有暂存则员工默认值），每次暂存成功换成回执里的暂存，与 revision
 * 同步更新；服务端没有暂存时最新值即 defaults。
 */
function useStage(
  employeeId: string,
  opened: Confirmed,
  defaults: Values,
  fields: readonly string[],
  found: (draft: FoundDraft) => void,
) {
  const api = useApiClient();
  const readDraft = useDraftRead(employeeId);
  const [confirmed, setConfirmed] = useState(opened);
  const read = async (): Promise<Latest> => {
    const view = await api.request<Values>(regularizationDraftPath(employeeId));
    if (view.employeeId !== employeeId || !Number.isSafeInteger(view.revision)) throw new Error(m.invalidReceipt);
    if (typeof view.applicationId === 'string') found(await readDraft(view.applicationId));
    const values = temporaryOf(view.temporary)?.values ?? defaults;
    return { id: employeeId, revision: Number(view.revision), values };
  };
  const target = targetOf(employeeId, confirmed, read);
  const cmd = useProbationCommand(employees, target, 'stage-regularization', async () => undefined);
  const stage = async (values: Values) => {
    const send: Send = {
      method: 'PUT',
      path: regularizationDraftPath(employeeId),
      body: temporaryBody,
      accept: (raw, sent) => {
        const next = acceptTemporary(raw, employeeId, sent);
        setConfirmed({ revision: next, values: temporaryOf((raw as Values).temporary)?.values ?? defaults });
        return { path: regularizationDraftPath(employeeId), id: employeeId, revision: next };
      },
    };
    if (await cmd.submit(values, fields, send)) void message.success(m.staged);
  };
  const button = (form: FormInstance, locked: boolean) => (
    <Button disabled={locked} loading={cmd.form.busy} onClick={() => void stage(form.getFieldsValue(true) as Values)}>
      {m.stage}
    </Button>
  );
  return { cmd, button };
}

/** 「已带出上次暂存信息 / 点击清除」（DEC-713）：清除只重置表单、不发请求，服务端暂存仍在，关掉重开照样带出。 */
function TemporaryNotice(props: { onClear(): void }) {
  const [shown, setShown] = useState(true);
  const clear = () => {
    props.onClear();
    setShown(false);
  };
  if (!shown) return null;
  const message = (
    <Space>
      {m.temporaryRecovered}
      <Typography.Link onClick={clear}>{m.clearTemporary}</Typography.Link>
    </Space>
  );
  return <Alert type="info" message={message} />;
}

/** 暂存带出的试用结果：字典到之前按暂存时的名称显示；到了之后已不是启用项就置空（新建只能选启用项，F-347 未决）。 */
function useTemporaryResult(
  form: FormInstance,
  temporary: Temporary | undefined,
  results: ReturnType<typeof useResults>,
) {
  const result = temporary?.values.probationResult;
  const stale = !!results.data && result != null && !results.options.some((option) => option.value === result);
  useEffect(() => {
    if (stale) form.setFieldValue('probationResult', null);
  }, [stale, form]);
  return results.data ? {} : (temporary?.names ?? {});
}

/**
 * 暂存冲突重读到申请草稿单（rf347_1 P2-3）：表单换成那张单的内容并进入它（提示沿用“已带出原申请”）；暂存这次冲突
 * 已由重读处理完，核对后清掉，不留锁定条目（同一员工槽上换了单据 revision 也不会撞上它）。
 */
function useFoundDraft(
  found: FoundDraft | undefined,
  staging: ProbationCommand,
  form: FormInstance,
  enter: (draft: FoundDraft) => void,
) {
  const entered = useRef<FoundDraft>(undefined);
  useEffect(() => {
    if (!found || entered.current === found) return;
    entered.current = found;
    enter(found);
    form.setFieldsValue(found.values);
  });
  // 重读完成（有 latest、不在读）才能核对；每次渲染检查一次，条件不满足时内核自己不动
  useEffect(() => {
    if (!found || staging.form.status !== 'conflict') return;
    staging.form.confirm();
    staging.form.clear();
  });
}

/** 转正 / 转正申请的按钮权与数据操作权（申请两步：建草稿 + 提交）。 */
function useRegularizeAllowed(application?: boolean) {
  const permissions = usePermissions(object);
  const permission = permissions.snapshot.objects[object];
  const create = !!permission?.dataOperations.create && permissions.can('Employment.Create');
  return create && (!application || (!!permission?.dataOperations.update && permissions.can('Employment.Submit')));
}

/** 转正日期的字段权：可见才显示，可编辑才可改、才随请求发送（F-344）。 */
function useDateAccess() {
  const access = usePermissions(object).field('effectiveDate');
  return { ...access, fields: regularizeFieldsFor(access.editable) };
}

type RegularizeProps = EditorProps & { recovery?: Recovery };
function RegularizeEditor(props: RegularizeProps) {
  const { row, application, onClose, onDone, refresh, opening, read, recovery } = props;
  const employeeId = row.employeeId!;
  const allowed = useRegularizeAllowed(application);
  const { fields, ...dateAccess } = useDateAccess();
  // 本次弹窗建 / 改过的草稿、暂存冲突重读到的申请单优先，否则沿用打开时找回的原申请单（服务端仍是草稿）：
  // 都只提交同一张单（DEC-103）
  const [own, setOwn] = useState<{ draft: ApplicationDraft; created: boolean }>();
  const [found, setFound] = useState<FoundDraft>();
  const draft = application ? (own?.draft ?? recovery?.draft) : undefined;
  const temporary = application && !draft ? recovery?.temporary : undefined;
  const [form] = Form.useForm();
  const results = useResults();
  const pending = useTemporaryResult(form, temporary, results);
  // 草稿单的已存结果名称（保存时名称）：打开时取原单，409 重读 / 暂存冲突进入别的单时取最新一次读到的
  const [names, setNames] = useState<Values>(recovery?.draft?.names ?? {});
  const options = withSaved(results.options, draft ? names : pending);
  // 第二步的 If-Match 是草稿单 revision：409 重读读草稿单并投影全部字段（同一次 GET，rf347_1 P2-1），
  // 未改的字段随最新；恢复槽仍是员工（换入口也绕不开未知锁）
  const readDraft = useDraftRead(employeeId);
  const reread = draft
    ? async (): Promise<Latest> => {
        const latest = await readDraft(draft.id);
        setNames((saved) => ({ ...saved, ...latest.names }));
        return { id: employeeId, revision: latest.revision, values: latest.values };
      }
    : read;
  // 冲突基线只来自 targetOf：草稿单的 revision 与值同一张单，否则员工打开时的同一次 GET（rf347_2，DEC-431①）
  const target = targetOf(employeeId, draft ?? opening, reread);
  const cmd = useProbationCommand(employees, target, application ? 'apply' : 'regularize', () => refresh());
  const stagedAt = { revision: recovery?.revision ?? 0, values: temporary?.values ?? opening.values };
  const staging = useStage(employeeId, stagedAt, opening.values, fields, setFound);
  const staged = application && !draft;
  useDraftRefill(cmd.form, fields, form);
  useDraftRefill(staged ? staging.cmd.form : undefined, fields, form);
  useFoundDraft(found, staging.cmd, form, (next) => {
    setOwn({ draft: next, created: false });
    setNames(next.names);
  });
  const autoSubmit = useRef(false);
  // 表单锁与暂存按钮只看命令状态与权限；暂存不校验必填，启用字典为空也能暂存（rf347_1 P2-5）
  const locked = cmd.disabled || (staged && staging.cmd.disabled) || !allowed;
  // 新建提交要有启用的试用结果；已存草稿带着已存结果提交，不受启用字典为空限制（F-347 e）
  const submitLocked = !draft && !results.options.length;
  const { destination, ...sends } = useSends(employeeId, fields, (made, values) =>
    setOwn({ draft: { ...made, values: projectFields(values, fields) }, created: true }),
  );
  const { error, submit } = useSubmit(form, async (values) => {
    validateRegularize(values, dateAccess.editable);
    // 与当前已确认 revision 的服务端值比（rf347_2 P2-1）：409 核对后改回打开时的值也要先 PATCH，不能跳过直接提交
    const confirmed = cmd.confirmedValues(fields);
    const changed = !!draft && fields.some((field) => !sameValue(values[field], confirmed[field]));
    const send = regularizeSend(sends, { application, draft, changed }, values);
    if (!(await cmd.submit(values, fields, send))) return;
    // 建草稿 / 改草稿已确认才自动进入提交（同实习）；提交失败时草稿保留，由用户显式重提同一张单
    if (application && (!draft || changed)) return void (autoSubmit.current = true);
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
      submitLocked={submitLocked}
      onClose={onClose}
      onSubmit={() => void submit()}
      okText={application ? m.submit : m.save}
      extra={staged && staging.button(form, cmd.disabled || staging.cmd.disabled || !allowed)}
    >
      {staged && <CommandStatus submission={staging.cmd.form} labels={m.fields} />}
      {draft && <Alert type="info" message={own?.created ? m.draftCreated : m.draftRecovered} />}
      {temporary && <TemporaryNotice onClear={() => form.setFieldsValue(opening.values)} />}
      {!draft && results.data && !results.options.length && <Alert type="warning" message={m.noResults} />}
      <RegularizeFields
        form={form}
        initial={draft?.values ?? temporary?.values ?? opening.values}
        results={options}
        date={dateAccess}
      />
    </Shell>
  );
}

type ResultOption = { value: string; label: string };
type DateAccess = { visible: boolean; editable: boolean };
type FieldsProps = {
  form: FormInstance;
  initial: Values;
  results: ResultOption[];
  date: DateAccess;
  dateRequired?: boolean;
};
function RegularizeFields(props: FieldsProps) {
  return (
    <Form form={props.form} layout="vertical" initialValues={props.initial}>
      {props.date.visible && (
        <Field
          name="effectiveDate"
          label={m.fields.regularizationDate!}
          required={props.date.editable && props.dateRequired !== false}
        >
          {date(m.fields.regularizationDate!, !props.date.editable)}
        </Field>
      )}
      <Field name="probationResult" label={m.fields.probationResult!} required>
        <Select aria-label={m.fields.probationResult} options={props.results} />
      </Field>
    </Form>
  );
}

/** 批量转正（PB-R8，≤100 人）：统一转正日期可不填（各按预计结束日次日）；逐人回执，失败的人列出原因。 */
export function BatchForm({ rows, onClose, onDone, refresh }: Omit<FormProps, 'row'> & { rows: Row[] }) {
  const permissions = usePermissions(object);
  const dateAccess = useDateAccess();
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
    let outcome: ReturnType<typeof regularizationReceipt> | undefined;
    const send: Send = {
      path: regularizations,
      ifMatch: false,
      body: (values) => regularizationsBody(values, items),
      accept: (raw) => void (outcome = regularizationReceipt(raw, items)),
    };
    if (!(await cmd.submit(values, dateAccess.fields, send)) || !outcome) return;
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
      <RegularizeFields form={form} initial={{}} results={results.options} date={dateAccess} dateRequired={false} />
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
