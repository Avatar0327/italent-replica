// B65 交接发起规则（FE-R2c2b）：租户设置 exit.handover_trigger（两层配置，整份替换）。读写接口都有，做成内嵌表单，
// 同账号停用时间：只有其他设置权可保存，其余只读。发起人只开放“员工本人”（F-250 / DEC-683，其他发起人后补）；
// 审批节点没有候选接口，只能填节点标识（未决）。
import { EXIT_HANDOVER_TRIGGER_KEY as KEY, HANDOVER_METHODS, type HandoverTriggerSetting } from '@italent/domain';
import { Button, Form, Input, InputNumber, Select, Switch, message, type FormItemProps } from 'antd';
import type { ReactNode } from 'react';
import { ApiError } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { FormLock, LockedField } from '../foundation/forms/FormLock.js';
import type { Values } from '../foundation/forms/store.js';
import { useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { projectFields } from '../foundation/forms/values.js';
import { useParsed } from './settings-commands.js';
import { s } from './settings-messages.js';
import {
  FIELD_MAX,
  TRIGGER_PATH,
  otherSettingsEditable,
  parseSettingReceipt,
  parseTrigger,
  settingWritable,
  triggerBody,
  triggerValues,
  triggerVisibleFields,
  type Setting,
} from './settings-model.js';

const t = s.trigger;
const LABELS: Record<string, string> = t;
const DAYS_MAX = FIELD_MAX.trigger.days;
const days = { required: true, type: 'integer' as const, min: 0, max: DAYS_MAX, message: t.daysRange };

export function HandoverTrigger() {
  const { data, error, reload } = useParsed(TRIGGER_PATH, parseTrigger);
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <>
      <header className="exit-heading">
        <h1>{s.tabs['handover-trigger']}</h1>
      </header>
      {forbidden && <PageState kind="forbidden" />}
      {!!error && !forbidden && <PageState kind="error" error={error} retry={reload} />}
      {!error && !data && <PageState kind="loading" />}
      {/* 保存成功后按新版本重建表单；未确认的命令在模块级存储里，重建后仍锁定。 */}
      {!error && data && <TriggerForm key={data.revision} setting={data} reload={reload} />}
    </>
  );
}

function TriggerForm({ setting, reload }: { setting: Setting<HandoverTriggerSetting>; reload(): void }) {
  const api = useApiClient();
  const permission = usePermissions();
  const writable = settingWritable(permission.menus, setting);
  const [form] = Form.useForm<Values>();
  const initial = triggerValues(setting.value);
  const writer = useConflictCommand(
    TRIGGER_PATH,
    { id: KEY, revision: setting.revision, values: initial },
    async () => {
      const latest = parseTrigger(await api.request<unknown>(TRIGGER_PATH));
      return { id: KEY, revision: latest.revision, values: triggerValues(latest.value) };
    },
  );
  const submission = writer.form;
  const method = Form.useWatch('method', form) as string | undefined;
  const remind = Form.useWatch('remindEnabled', form) === true;
  // 只有可见字段可校验、可提交、重读时保留草稿；隐藏字段由 triggerBody 取最新全量的有效值（后端必填）。
  const visible = triggerVisibleFields({ method, remindEnabled: remind });
  useDraftRefill(submission, writable ? visible : [], form);
  const locked = submission.locked || !writable;

  const save = async () => {
    if (locked) return;
    const values = form.getFieldsValue(true) as Values;
    const fields = triggerVisibleFields(values);
    // 校验失败都落在可见字段上，由表单项显示原因。
    if (!(await form.validateFields(fields).catch(() => undefined))) return;
    if (
      JSON.stringify(triggerBody(writer.full, projectFields(values, fields))) ===
      JSON.stringify(triggerBody(writer.full, {}))
    ) {
      void message.info(s.unchanged);
      return;
    }
    try {
      await writer.run({
        values,
        editableFields: fields,
        send: async ({ edited, command }) => {
          const body = { value: triggerBody(writer.full, edited) };
          const receipt = await api.request<unknown>(TRIGGER_PATH, { method: 'PUT', command: { ...command, body } });
          return parseSettingReceipt(receipt, KEY, command.revision ?? setting.revision);
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.length) form.setFields(error.fieldErrors);
      return;
    }
    void message.success(s.saved);
    reload();
  };

  return (
    <section className="exit-settings-form" aria-label={s.tabs['handover-trigger']}>
      {!writable && <p className="exit-hint">{readonlyHint(permission.menus, setting)}</p>}
      {writable && setting.source === 'system' && <p className="exit-hint">{t.systemValue}</p>}
      <CommandStatus submission={submission} labels={LABELS} />
      <FormLock locked={locked}>
        <Form form={form} layout="vertical" initialValues={initial} disabled={!writable}>
          <TriggerFields method={method} remind={remind} />
        </Form>
      </FormLock>
      {writable && (
        <Button type="primary" loading={submission.busy} disabled={locked} onClick={() => void save()}>
          {s.save}
        </Button>
      )}
    </section>
  );
}

// 每项都经 LockedField：结果未知 / 无写权时整表锁定。开关类按 checked 取值。
function Field({ name, control, ...props }: FormItemProps & { name: string; control: ReactNode }) {
  return (
    <Form.Item name={name} label={LABELS[name]} {...props}>
      <LockedField>{control}</LockedField>
    </Form.Item>
  );
}
const toggle = (name: string) => (
  <Field name={name} valuePropName="checked" control={<Switch aria-label={LABELS[name]} />} />
);
const dayCount = (name: string) => (
  <Field name={name} rules={[days]} control={<InputNumber min={0} max={DAYS_MAX} precision={0} />} />
);
const methods = HANDOVER_METHODS.map((value) => ({ value, label: s.methods[value] }));

/** 发起方式决定显示哪些附加项：最后工作日前 N 天要天数，某节点通过后要节点标识。 */
function TriggerFields({ method, remind }: { method?: string; remind: boolean }) {
  return (
    <>
      {toggle('enabled')}
      <Field
        name="method"
        rules={[{ required: true, message: s.required }]}
        control={<Select aria-label={t.method} options={methods} />}
      />
      {method === 'days_before_last_work_date' && dayCount('daysBeforeLastWorkDate')}
      {method === 'on_node_approved' && (
        <Field
          name="nodeKey"
          extra={t.nodeKeyHint}
          rules={[{ required: true, whitespace: true, message: s.required }]}
          control={<Input maxLength={FIELD_MAX.trigger.nodeKey} />}
        />
      )}
      {toggle('includePastLastWorkDate')}
      <Form.Item label={t.initiator}>{t.initiatorSelf}</Form.Item>
      {toggle('remindEnabled')}
      {/* 催办关闭时天数只隐藏、不校验也不提交；整份提交取最新全量的有效值（后端必填）。 */}
      <div hidden={!remind}>
        {dayCount('remindBefore')}
        {dayCount('remindAfter')}
      </div>
    </>
  );
}
/** 只读原因：没有其他设置权，或该键不可覆盖（系统统一管控）。 */
export function readonlyHint(menus: Parameters<typeof otherSettingsEditable>[0], setting: { overridable: boolean }) {
  return otherSettingsEditable(menus) && !setting.overridable ? s.notOverridable : s.readonlyHint;
}
