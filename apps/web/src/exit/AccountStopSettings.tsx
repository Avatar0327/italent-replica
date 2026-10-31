// F-327：离职退休设置的“账号停用时间”页签（DEC-685④；docs/02_业务建模/30 DM-R9）。
// 单例配置，内嵌表单直接保存：原站设置页是分节表单 + 保存，不弹窗。
import { Button, Form, Input, Radio, Switch, message } from 'antd';
import { useRead } from '../contracts/useRead.js';
import { ApiError } from '../foundation/client.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import type { Values } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { a } from './account-stop-messages.js';
import {
  ACCOUNT_STOP_FIELDS,
  ACCOUNT_STOP_ID,
  ACCOUNT_STOP_PATH,
  ACCOUNT_STOP_RESOURCE,
  BASES,
  TIME_PATTERN,
  accountStopBody,
  accountStopValues,
  accountStopWritable,
  parseAccountStop,
  parseAccountStopReceipt,
  type AccountStop,
} from './account-stop.js';
import { EXIT_SETTINGS_OBJECT } from './model.js';
import './account-stop.css';

const LABELS = { earlyEnabled: a.earlyEnabled, basis: a.basis, time: a.time, inReview: a.inReview };
const required = { required: true, message: a.required };
const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

export function AccountStopSettings() {
  const read = useRead<unknown>(ACCOUNT_STOP_PATH);
  let row: AccountStop | undefined;
  let error = read.error;
  try {
    if (read.data !== undefined) row = parseAccountStop(read.data);
  } catch (cause) {
    error = cause;
  }
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <>
      <DecisionNote id="exit-account-stop" />
      <header className="exit-heading">
        <h1>{a.tab}</h1>
      </header>
      {forbidden && <PageState kind="forbidden" />}
      {!!error && !forbidden && <PageState kind="error" error={error} retry={read.refresh} />}
      {!error && !row && <PageState kind="loading" />}
      {/* 版本变了（保存成功后刷新）就按新回显重建表单；未确认的命令在模块级存储里，重建后仍锁定。 */}
      {!error && row && <AccountStopForm key={row.revision} row={row} reload={read.refresh} />}
    </>
  );
}

function AccountStopForm({ row, reload }: { row: AccountStop; reload(): void }) {
  const api = useApiClient();
  const permission = usePermissions(EXIT_SETTINGS_OBJECT);
  const writable = accountStopWritable(permission.snapshot.objects[EXIT_SETTINGS_OBJECT], permission.menus);
  const [form] = Form.useForm<Values>();
  const writer = useConflictCommand(
    ACCOUNT_STOP_RESOURCE,
    { id: ACCOUNT_STOP_ID, revision: row.revision, values: accountStopValues(row) },
    async () => {
      const latest = parseAccountStop(await api.request<unknown>(ACCOUNT_STOP_PATH));
      return { id: ACCOUNT_STOP_ID, revision: latest.revision, values: accountStopValues(latest) };
    },
  );
  const submission = writer.form;
  useDraftRefill(submission, writable ? ACCOUNT_STOP_FIELDS : [], form);
  const early = Form.useWatch('earlyEnabled', form) === true;
  const locked = submission.locked || !writable;

  const save = async () => {
    if (locked || !(await form.validateFields().catch(() => undefined))) return;
    // 隐藏的依据与时间不算输入：按后端口径整理后再比对、再提交。
    const values: Values = accountStopBody({}, form.getFieldsValue(true) as Values);
    const current = accountStopBody(writer.full, {});
    if (ACCOUNT_STOP_FIELDS.every((field) => values[field] === current[field])) {
      void message.info(a.unchanged);
      return;
    }
    try {
      await writer.run({
        values,
        editableFields: ACCOUNT_STOP_FIELDS,
        send: async ({ edited, command }) => {
          const body = accountStopBody(writer.full, edited);
          const sent = { method: 'PUT' as const, command: { ...command, body } };
          const receipt = await api.request<unknown>(ACCOUNT_STOP_PATH, sent);
          return parseAccountStopReceipt(receipt, command.revision ?? row.revision);
        },
      });
    } catch (error) {
      // 结果未知、冲突、明确拒绝都由 CommandStatus 提示；拒绝时输入保留，后端给了字段错误就标到字段上。
      if (error instanceof ApiError && error.fieldErrors.length) form.setFields(error.fieldErrors);
      return;
    }
    void message.success(a.saved);
    reload();
  };

  return (
    <section className="exit-account-stop" aria-label={a.tab}>
      <p className="exit-hint">{a.intro}</p>
      <CommandStatus submission={submission} labels={LABELS} />
      <FormLock locked={locked}>
        <Form form={form} layout="vertical" initialValues={accountStopValues(row)} disabled={!writable}>
          <Form.Item name="earlyEnabled" label={a.earlyEnabled} valuePropName="checked">
            <LockedField>
              <Switch aria-label={a.earlyEnabled} />
            </LockedField>
          </Form.Item>
          {early && <EarlyFields />}
          <Form.Item name="inReview" label={a.inReview} extra={a.inReviewHint} valuePropName="checked">
            <LockedField>
              <Switch aria-label={a.inReview} />
            </LockedField>
          </Form.Item>
        </Form>
      </FormLock>
      {writable && (
        <Button type="primary" loading={submission.busy} disabled={locked} onClick={() => void save()}>
          {a.save}
        </Button>
      )}
    </section>
  );
}

/** 开启提前停用后才显示、才必填的停用依据与停用时间。 */
function EarlyFields() {
  return (
    <>
      <Form.Item name="basis" label={a.basis} extra={a.basisHint} rules={[required]}>
        <LockedField>
          <Radio.Group options={BASES.map((value) => ({ value, label: a.basisOptions[value] }))} />
        </LockedField>
      </Form.Item>
      <Form.Item
        name="time"
        label={a.time}
        extra={a.timeHint}
        rules={[
          { ...required, whitespace: true },
          { pattern: TIME_PATTERN, message: a.timeFormat, transform: trim },
        ]}
      >
        <LockedField>
          <Input className="exit-account-stop-time" placeholder="HH:mm" maxLength={5} />
        </LockedField>
      </Form.Item>
    </>
  );
}
