// FE-R2c1b 两层配置的单例表单：B57 / B58 总开关与 B59 考核并行规则共用（tenant-settings/routes.ts）。
// 整份提交 { value }，If-Match 为回显版本；回执同形，版本 = 提交版本 + 1（同 F-327 账号停用时间的内嵌表单）。
import { Button, Checkbox, Form, Switch, message, type FormInstance } from 'antd';
import type { ReactNode } from 'react';
import { useRead } from '../contracts/useRead.js';
import { ApiError } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import type { Values } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { s } from './settings-messages.js';
import {
  PARALLEL_BLOCKERS,
  SETTINGS_OBJECT,
  SETTINGS_RESOURCE,
  isSwitchValue,
  parallelBody,
  parallelCandidates,
  parallelKey,
  parallelValid,
  parseSetting,
  parseSettingReceipt,
  settingPath,
  settingWritable,
  type Setting,
} from './settings-model.js';

interface Spec {
  key: string;
  label: string;
  hint: string;
  fields: readonly string[];
  valid(value: unknown): boolean;
  /** 配置值 → 表单值。 */
  values(value: unknown): Values;
  /** 未改项取 full、已改项取 edited，整理成要提交的配置值。 */
  body(full: Values, edited: Values): unknown;
  extra?(form: FormInstance<Values>): ReactNode;
}

/** 总开关：配置值就是布尔。 */
export const switchSpec = (key: string, label: string): Spec => ({
  key,
  label,
  hint: s.switchHint,
  fields: ['enabled'],
  valid: isSwitchValue,
  values: (value) => ({ enabled: value === true }),
  body: (full, edited) => ({ ...full, ...edited }).enabled === true,
});

export function SettingBlock({ spec }: { spec: Spec }) {
  const read = useRead<unknown>(settingPath(spec.key));
  let row: Setting | undefined;
  let error = read.error;
  try {
    if (read.data !== undefined) row = parseSetting(read.data, spec.key, spec.valid);
  } catch (cause) {
    error = cause;
  }
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <section className="probation-settings-block" aria-label={spec.label}>
      {forbidden && <PageState kind="forbidden" />}
      {!!error && !forbidden && <PageState kind="error" error={error} retry={read.refresh} />}
      {!error && !row && <PageState kind="loading" />}
      {/* 版本变了（保存成功后刷新）就按新回显重建表单；未确认的命令在模块级存储里，重建后仍锁定。 */}
      {!error && row && <SettingForm key={row.revision} spec={spec} row={row} reload={read.refresh} />}
    </section>
  );
}

function SettingForm({ spec, row, reload }: { spec: Spec; row: Setting; reload(): void }) {
  const api = useApiClient();
  const permission = usePermissions(SETTINGS_OBJECT);
  const writable = settingWritable(permission.snapshot.objects[SETTINGS_OBJECT], permission.menus, row);
  const [form] = Form.useForm<Values>();
  const writer = useConflictCommand(
    SETTINGS_RESOURCE,
    { id: spec.key, revision: row.revision, values: spec.values(row.value) },
    async () => {
      const latest = parseSetting(await api.request<unknown>(settingPath(spec.key)), spec.key, spec.valid);
      return { id: spec.key, revision: latest.revision, values: spec.values(latest.value) };
    },
  );
  const submission = writer.form;
  useDraftRefill(submission, writable ? spec.fields : [], form);
  const locked = submission.locked || !writable;

  const save = async () => {
    if (locked || !(await form.validateFields().catch(() => undefined))) return;
    const values = form.getFieldsValue(true) as Values;
    // 隐藏的勾选不算输入：按提交口径整理后再比对。
    if (JSON.stringify(spec.body({}, values)) === JSON.stringify(spec.body(writer.full, {}))) {
      void message.info(s.unchanged);
      return;
    }
    try {
      await writer.run({
        values,
        editableFields: spec.fields,
        send: async ({ edited, command }) => {
          const body = { value: spec.body(writer.full, edited) };
          const raw = await api.request<unknown>(settingPath(spec.key), {
            method: 'PUT',
            command: { ...command, body },
          });
          return parseSettingReceipt(raw, spec.key, spec.valid, command.revision ?? row.revision);
        },
      });
    } catch {
      // 结果未知、冲突、明确拒绝都由 CommandStatus 提示，输入保留。
      return;
    }
    void message.success(s.saved);
    reload();
  };

  return (
    <>
      <CommandStatus submission={submission} labels={{ enabled: spec.label, allowed: s.parallelAllowed }} />
      {!row.overridable && <p className="probation-settings-hint">{s.settingReadOnly}</p>}
      <FormLock locked={locked}>
        <Form
          form={form}
          name={spec.key.replace(/\W/g, '_')}
          layout="vertical"
          initialValues={spec.values(row.value)}
          disabled={!writable}
        >
          <Form.Item name="enabled" label={spec.label} extra={spec.hint} valuePropName="checked">
            <LockedField>
              <Switch aria-label={spec.label} />
            </LockedField>
          </Form.Item>
          {spec.extra?.(form)}
        </Form>
      </FormLock>
      {writable && (
        <Button type="primary" loading={submission.busy} disabled={locked} onClick={() => void save()}>
          {s.save}
        </Button>
      )}
    </>
  );
}

type Blocker = (typeof PARALLEL_BLOCKERS)[number];
/** B59：开关打开后才出现可发起流程的多选；候选取 PARALLEL_CANDIDATES，关闭时按 allowed = [] 提交。 */
function parallelSpec(blocker: Blocker): Spec {
  const label = s.parallel[blocker]!;
  return {
    key: parallelKey(blocker),
    label,
    hint: s.parallelHint,
    fields: ['enabled', 'allowed'],
    valid: parallelValid(blocker),
    values: (value) => ({ ...(value as Values) }),
    body: (full, edited) => parallelBody(blocker, full, edited),
    extra: (form) => <ParallelAllowed blocker={blocker} form={form} />,
  };
}
function ParallelAllowed({ blocker, form }: { blocker: Blocker; form: FormInstance<Values> }) {
  const enabled = Form.useWatch('enabled', form) === true;
  if (!enabled) return null;
  const options = parallelCandidates(blocker).map((value) => ({ value, label: s.processes[value] ?? value }));
  return (
    <Form.Item name="allowed" label={s.parallelAllowed}>
      <LockedField>
        <Checkbox.Group options={options} />
      </LockedField>
    </Form.Item>
  );
}

export function ParallelTab() {
  return (
    <>
      <header className="probation-settings-heading">
        <h1>{s.tabs.parallel}</h1>
      </header>
      {PARALLEL_BLOCKERS.map((blocker) => (
        <SettingBlock key={blocker} spec={parallelSpec(blocker)} />
      ))}
    </>
  );
}
