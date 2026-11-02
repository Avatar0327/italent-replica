// B68 自动加黑规则页（FE-R2c2b）：总开关“离职后自动加入黑名单”（租户设置 exit.auto_blacklist_enabled）与规则增删改。
// 规则执行在后端（离职生效时匹配），前端不做。条件只实现“离职次数 ≥ N”，期限只有永久 / 离职当月（“指定期限”后端未实现，未决）。
import {
  AUTO_BLACKLIST_SETTING_KEY as SWITCH_KEY,
  BLACKLIST_REASONS,
  BLACKLIST_RULE_TERMS,
  BLACKLIST_RULE_TEXT_MAX,
} from '@italent/domain';
import { Button, Input, InputNumber, Radio, Select, Switch, Table } from 'antd';
import { useState } from 'react';
import { RefLabels, RefSelect, refPaths } from '../contracts/references.js';
import { ApiError } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand, type Run } from '../foundation/forms/ConflictCommands.js';
import { projectFields } from '../foundation/forms/values.js';
import {
  RecordForm,
  configField,
  configOperation,
  fieldColumn,
  label,
  options,
  rowReader,
  runInline,
  useParsed,
} from './settings-commands.js';
import { s } from './settings-messages.js';
import {
  AUTO_BLACKLIST_PATH,
  BLACKLIST_RULES_PATH,
  RULE_FIELDS,
  configAccess,
  otherSettingsEditable,
  parseAutoBlacklist,
  parseRowReceipt,
  parseRows,
  parseSettingReceipt,
  rowPath,
  ruleBody,
  ruleValues,
  type Row,
  type Setting,
} from './settings-model.js';
import { EXIT_SETTINGS_OBJECT } from './model.js';

const r = s.rules;
const FORM_FIELDS = ['name', 'priority', 'orgIds', 'description', 'exitCount', 'term', 'reason', 'note'] as const;
const LABELS: Record<string, string> = r;
const field = configField(LABELS);
const parse = (raw: unknown) => parseRows(raw, 'rule');
const formValues = (row: Row) => ({ ...projectFields(ruleValues(row), FORM_FIELDS), conditions: row.conditions });
const conditionText = (value: unknown) =>
  (value as { value: number }[]).map((condition) => s.conditionText(condition.value)).join('；');

export function BlacklistRules() {
  const api = useApiClient();
  const permission = usePermissions(EXIT_SETTINGS_OBJECT);
  const access = configAccess(permission.snapshot.objects[EXIT_SETTINGS_OBJECT], permission.menus, RULE_FIELDS);
  const { data: rows, error, loading, reload } = useParsed(BLACKLIST_RULES_PATH, parse);
  const [editing, setEditing] = useState<{ row?: Row }>();
  const operation = { api, collection: BLACKLIST_RULES_PATH, parse, labels: LABELS, reload };
  const columns = [
    fieldColumn('name', r.name),
    fieldColumn('priority', r.priority, undefined, 80),
    fieldColumn('orgIds', r.orgIds, (ids) => <RefLabels path={refPaths.orgId} ids={ids} />),
    fieldColumn('conditions', r.conditions, conditionText),
    fieldColumn('term', r.term, label(BLACKLIST_RULE_TERMS), 100),
    fieldColumn('reason', r.reason, label(BLACKLIST_REASONS)),
    ...(access.update ? [configOperation({ ...operation, edit: (row) => setEditing({ row }) })] : []),
  ];
  return (
    <section aria-label={s.tabs['blacklist-rules']}>
      <header className="exit-heading">
        <h1>{s.tabs['blacklist-rules']}</h1>
        {access.create && rows && (
          <Button type="primary" onClick={() => setEditing({})}>
            {s.create}
          </Button>
        )}
      </header>
      <AutoBlacklistSwitch />
      <p className="exit-hint">{access.create || access.update ? r.priorityHint : s.readonlyHint}</p>
      {!!error && <PageState kind="error" error={error} retry={reload} />}
      {loading && <PageState kind="loading" />}
      {rows && (
        <Table<Row>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: s.empty }}
          columns={columns}
        />
      )}
      {editing && <RuleForm row={editing.row} close={() => setEditing(undefined)} reload={reload} />}
    </section>
  );
}

/** 总开关：单个布尔租户设置，切换即保存（带版本）；读不到（无其他设置权 403）只提示，不挡规则列表。 */
function AutoBlacklistSwitch() {
  const { data, error, reload } = useParsed(AUTO_BLACKLIST_PATH, parseAutoBlacklist);
  if (error instanceof ApiError && error.status === 403) return <p className="exit-hint">{r.switchForbidden}</p>;
  if (error) return <PageState kind="error" error={error} retry={reload} />;
  return data ? <SwitchCommand key={data.revision} setting={data} reload={reload} /> : null;
}

function SwitchCommand({ setting, reload }: { setting: Setting<boolean>; reload(): void }) {
  const api = useApiClient();
  const writable = otherSettingsEditable(usePermissions().menus);
  const writer = useConflictCommand(
    AUTO_BLACKLIST_PATH,
    { id: SWITCH_KEY, revision: setting.revision, values: { enabled: setting.value } },
    async () => {
      const latest = parseAutoBlacklist(await api.request<unknown>(AUTO_BLACKLIST_PATH));
      return { id: SWITCH_KEY, revision: latest.revision, values: { enabled: latest.value } };
    },
    { action: 'row' },
  );
  const send: Run['send'] = async ({ edited, command }) => {
    const body = { value: edited.enabled === true };
    const raw = await api.request<unknown>(AUTO_BLACKLIST_PATH, { method: 'PUT', command: { ...command, body } });
    return parseSettingReceipt(raw, SWITCH_KEY, command.revision ?? setting.revision);
  };
  const toggle = (enabled: boolean) =>
    runInline(writer, { values: { enabled }, editableFields: ['enabled'], send }, reload);
  return (
    <div className="exit-settings-switch">
      <label>
        <Switch
          aria-label={r.enabled}
          checked={setting.value}
          disabled={!writable || writer.form.locked}
          onChange={(checked) => void toggle(checked)}
        />
        <span>{r.enabled}</span>
      </label>
      <p className="exit-hint">{r.switchHint}</p>
      <CommandStatus submission={writer.form} labels={LABELS} />
    </div>
  );
}

function RuleForm({ row, close, reload }: { row?: Row; close(): void; reload(): void }) {
  const api = useApiClient();
  const required = { required: true, message: s.required };
  const integer = (min: number, max: number, text: string) => [
    { required: true, type: 'integer' as const, min, max, message: text },
  ];
  return (
    <RecordForm
      resource={BLACKLIST_RULES_PATH}
      title={`${row ? s.edit : s.create}${s.tabs['blacklist-rules']}`}
      row={row}
      values={row ? formValues(row) : { term: 'permanent', priority: 1, orgIds: [] }}
      read={row && rowReader(api, BLACKLIST_RULES_PATH, parse, row.id, formValues)}
      fields={[
        field('name', <Input maxLength={100} />, [{ ...required, whitespace: true }]),
        field('priority', <InputNumber min={0} max={9999} precision={0} />, integer(0, 9999, r.priorityRange)),
        field('orgIds', <RefSelect path={refPaths.orgId} multiple ariaLabel={r.orgIds} />, [
          { ...required, type: 'array', min: 1 },
        ]),
        field('description', <Input.TextArea maxLength={BLACKLIST_RULE_TEXT_MAX} rows={2} />),
        field('exitCount', <InputNumber min={1} max={999} precision={0} />, integer(1, 999, r.exitCountRange)),
        field('term', <Radio.Group options={options(BLACKLIST_RULE_TERMS)} />, [required]),
        field('reason', <Select aria-label={r.reason} options={options(BLACKLIST_REASONS)} />, [required]),
        field('note', <Input.TextArea maxLength={BLACKLIST_RULE_TEXT_MAX} rows={2} />),
      ]}
      send={async (full, edited, command) => {
        const path = row ? rowPath(BLACKLIST_RULES_PATH, row.id) : BLACKLIST_RULES_PATH;
        const body = ruleBody(full, edited);
        const raw = await api.request<unknown>(path, { method: row ? 'PUT' : 'POST', command: { ...command, body } });
        return parseRowReceipt(raw, 'rule', { id: row?.id, revision: command.revision ?? 0 });
      }}
      close={close}
      reload={reload}
    />
  );
}
