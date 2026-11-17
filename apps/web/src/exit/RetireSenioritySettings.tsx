import { Button, Form, Switch, message } from 'antd';
import { useEffect, useRef } from 'react';
import { ApiError } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import type { Values } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { changedFields } from '../foundation/forms/values.js';
import { retireSeniorityMessages as t } from './retire-seniority-messages.js';
import {
  RETIRE_SENIORITY_FIELDS as FIELDS,
  RETIRE_SENIORITY_KEY as KEY,
  RETIRE_SENIORITY_LABELS,
  RETIRE_SENIORITY_PATH as PATH,
  parseRetireSeniority,
  parseRetireSeniorityReceipt,
  retireSeniorityBody,
  retireSeniorityValues,
  type RetireSenioritySetting,
} from './retire-seniority-model.js';
import { useParsed } from './settings-commands.js';
import { s } from './settings-messages.js';
import { settingReadonlyHint, settingWritable } from './settings-model.js';

/** F-478 S7 “退休返聘累计司龄”开关（AC-EMP-F478-27，设计 §7.2）：结构与 F-419 终止在途设置一致。 */
export function RetireSenioritySettings() {
  const { data, error, reload } = useParsed(PATH, parseRetireSeniority);
  return (
    <>
      <header className="exit-heading">
        <h1>{t.title}</h1>
      </header>
      {!!error && (
        <PageState
          kind={error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error'}
          error={error}
          retry={reload}
        />
      )}
      {!error && !data && <PageState kind="loading" />}
      {!error && data && <RetireSeniorityForm key={data.revision} setting={data} reload={reload} />}
    </>
  );
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

function RetireSeniorityForm({ setting, reload }: { setting: RetireSenioritySetting; reload(): void }) {
  const api = useApiClient();
  const permission = usePermissions();
  const [form] = Form.useForm<Values>();
  const alive = useAlive();
  const initial = retireSeniorityValues(setting);
  const writer = useConflictCommand(
    '/api/tenant/settings',
    { id: KEY, revision: setting.revision, values: initial },
    async () => {
      const latest = parseRetireSeniority(await api.request<unknown>(PATH));
      return { id: KEY, revision: latest.revision, values: retireSeniorityValues(latest) };
    },
  );
  const effective = { overridable: writer.full.overridable === true };
  const writable = settingWritable(permission.menus, effective);
  const submission = writer.form;
  // 旧表单发出的命令还在途时重新打开：旧回调不能刷新这里，由当前表单在内核确认成功后重读。
  const resumedPending = useRef(submission.busy);
  useEffect(() => {
    if (!resumedPending.current || submission.busy) return;
    resumedPending.current = false;
    if (submission.status === 'idle' || submission.status === 'done') reload();
  }, [submission.busy, submission.status, reload]);
  useDraftRefill(submission, writable ? FIELDS : [], form);
  const locked = submission.locked || !writable;
  const save = async () => {
    if (locked) return;
    const values = form.getFieldsValue(true) as Values;
    if (!changedFields(values, writer.full, FIELDS).length) {
      void message.info(s.unchanged);
      return;
    }
    try {
      await writer.run({
        values,
        editableFields: FIELDS,
        send: async ({ edited, command }) => {
          const body = retireSeniorityBody(writer.full, edited);
          const receipt = await api.request<unknown>(PATH, { method: 'PUT', command: { ...command, body } });
          return parseRetireSeniorityReceipt(receipt, command.revision!, body.value);
        },
      });
    } catch {
      // 拒绝 / 冲突 / 未知均保留内核草稿，由 CommandStatus 展示原因与恢复动作；409 只提示刷新，不自动重提。
      return;
    }
    if (!alive.current) return;
    void message.success(t.saved);
    reload();
  };
  return (
    <section className="exit-termination-form" aria-label={t.title}>
      {!writable && <p className="exit-hint">{settingReadonlyHint(permission.menus, effective)}</p>}
      <CommandStatus submission={submission} labels={RETIRE_SENIORITY_LABELS} />
      <FormLock locked={locked}>
        <Form form={form} initialValues={initial} disabled={!writable}>
          <Form.Item name="enabled" label={t.title} valuePropName="checked">
            <LockedField>
              <Switch aria-label={t.title} />
            </LockedField>
          </Form.Item>
        </Form>
      </FormLock>
      <p className="exit-hint">{t.effect}</p>
      <p className="exit-hint">{t.hint}</p>
      {writable && (
        <Button type="primary" loading={submission.busy} disabled={locked} onClick={() => void save()}>
          {s.save}
        </Button>
      )}
    </section>
  );
}
