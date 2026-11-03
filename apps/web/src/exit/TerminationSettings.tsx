import { EXIT_TERMINATION_FIXED, EXIT_TERMINATION_FLOWS, EXIT_TERMINATION_SETTING_KEY as KEY } from '@italent/domain';
import { Button, Checkbox, Form, message } from 'antd';
import { useEffect, useRef } from 'react';
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
import { changedFields } from '../foundation/forms/values.js';
import { useParsed } from './settings-commands.js';
import { s } from './settings-messages.js';
import { settingReadonlyHint, settingWritable } from './settings-model.js';
import { terminationMessages as t } from './termination-messages.js';
import {
  TERMINATION_FIELDS,
  TERMINATION_GROUPS,
  TERMINATION_LABELS,
  TERMINATION_PATH,
  parseTermination,
  parseTerminationReceipt,
  terminationBody,
  terminationValues,
  type TerminationSetting,
} from './termination-model.js';

export function TerminationSettings() {
  const { data, error, reload } = useParsed(TERMINATION_PATH, parseTermination);
  return (
    <>
      <DecisionNote id="exit-termination" />
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
      {!error && data && <TerminationForm key={data.revision} setting={data} reload={reload} />}
    </>
  );
}

function TerminationForm({ setting, reload }: { setting: TerminationSetting; reload(): void }) {
  const api = useApiClient();
  const permission = usePermissions();
  const [form] = Form.useForm<Values>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const initial = terminationValues(setting);
  const writer = useConflictCommand(
    '/api/tenant/settings',
    { id: KEY, revision: setting.revision, values: initial },
    async () => {
      const latest = parseTermination(await api.request<unknown>(TERMINATION_PATH));
      return { id: KEY, revision: latest.revision, values: terminationValues(latest) };
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
  useDraftRefill(submission, writable ? TERMINATION_FIELDS : [], form);
  const locked = submission.locked || !writable;
  const save = async () => {
    if (locked) return;
    const values = form.getFieldsValue(true) as Values;
    if (!changedFields(values, writer.full, TERMINATION_FIELDS).length) {
      void message.info(s.unchanged);
      return;
    }
    try {
      await writer.run({
        values,
        editableFields: TERMINATION_FIELDS,
        send: async ({ edited, command }) => {
          const body = terminationBody(writer.full, edited);
          const receipt = await api.request<unknown>(TERMINATION_PATH, {
            method: 'PUT',
            command: { ...command, body },
          });
          return parseTerminationReceipt(receipt, command.revision!);
        },
      });
    } catch {
      // 拒绝 / 冲突 / 未知均保留内核草稿，由 CommandStatus 展示原因与恢复动作。
      return;
    }
    if (!alive.current) return;
    void message.success(t.saved);
    reload();
  };
  return (
    <section className="exit-termination-form" aria-label={t.title}>
      {!writable && <p className="exit-hint">{settingReadonlyHint(permission.menus, effective)}</p>}
      <CommandStatus submission={submission} labels={TERMINATION_LABELS} />
      <FormLock locked={locked}>
        <Form form={form} initialValues={initial} disabled={!writable}>
          {TERMINATION_GROUPS.map(({ group, codes }) => (
            <section className="exit-settings-group" key={group}>
              <h2>{t.groups[group]}</h2>
              <p className="exit-hint">{t.hints[group]}</p>
              <div className="exit-termination-options">
                {codes.map((code) => (
                  <Form.Item key={code} name={code} valuePropName="checked">
                    <LockedField>
                      <Checkbox disabled={EXIT_TERMINATION_FIXED.includes(code)}>
                        {EXIT_TERMINATION_FLOWS[code].name}
                      </Checkbox>
                    </LockedField>
                  </Form.Item>
                ))}
              </div>
            </section>
          ))}
        </Form>
      </FormLock>
      <p className="exit-hint">{t.fixed}</p>
      {writable && (
        <Button type="primary" loading={submission.busy} disabled={locked} onClick={() => void save()}>
          {s.save}
        </Button>
      )}
    </section>
  );
}
