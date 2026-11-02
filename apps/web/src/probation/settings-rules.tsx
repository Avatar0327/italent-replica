// FE-R2c1b 自动转正（B57）/ 自动发起考核（B58）规则页签：总开关、规则列表、新增 / 编辑 / 复制 / 删除 / 单条启停
// （DEC-533②）与立即执行（DEC-539①）。规则名称是复刻加的字段（DEC-539②）。全部写入经 F-123 内核。
import { Button, Input, InputNumber, Select, Space, Switch, Table, Tag, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { RefLabels, RefSelect, refPaths } from '../contracts/references.js';
import { useRead } from '../contracts/useRead.js';
import { ApiError, type Command } from '../foundation/client.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import type { Values } from '../foundation/forms/store.js';
import { changedFields } from '../foundation/forms/values.js';
import { Confirm, perform } from './settings-commands.js';
import { RunPanel } from './settings-run.js';
import { s } from './settings-messages.js';
import {
  ORG_MAX,
  PRIORITY_MAX,
  RESULTS_PATH,
  RULES,
  RULE_OPTIONS,
  SETTINGS_OBJECT,
  parseDeleteReceipt,
  parseResults,
  parseRuleReceipt,
  parseRules,
  ruleAccess,
  ruleBody,
  ruleTrimmed,
  ruleValues,
  type Rule,
  type RuleAccess,
  type RuleKind,
} from './settings-model.js';
import { SettingBlock, switchSpec } from './settings-switch.js';

type Api = ReturnType<typeof useApiClient>;
const LABELS: Record<string, string> = {
  name: s.ruleName,
  priority: s.priority,
  orgIds: s.orgIds,
  includeSubordinates: s.includeSubordinates,
  mode: s.mode,
  daysBefore: s.daysBefore,
  daysAfterEntry: s.daysAfterEntry,
  initiatorType: s.initiatorType,
  probationResult: s.probationResult,
  assessmentType: s.assessmentType,
  enabled: s.enable,
};
/** 新建默认值同后端 default：包含下级、启用、试用结果“正常转正”。 */
const DEFAULTS: Record<RuleKind, Values> = {
  regularization: { includeSubordinates: true, enabled: true, probationResult: 'normal' },
  assessment: { includeSubordinates: true, enabled: true },
};
const snapshotOf = (kind: RuleKind, row: Rule) => ({
  id: row.id,
  revision: row.revision,
  values: ruleValues(kind, row),
});
const rowPath = (kind: RuleKind, id: string, tail = '') => `${RULES[kind].path}/${encodeURIComponent(id)}${tail}`;
const listOf = async (api: Api, kind: RuleKind) => parseRules(await api.request<unknown>(RULES[kind].path));
/** 规则没有单条读取接口：重读整份列表按 id 取本行。 */
function useRule(kind: RuleKind, row?: Rule) {
  const api = useApiClient();
  if (!row) return undefined;
  return async () => {
    const latest = (await listOf(api, kind)).find((entry) => entry.id === row.id);
    if (!latest) throw new Error(s.rowGone);
    return snapshotOf(kind, latest);
  };
}
const optionsOf = (options: Record<string, string>) =>
  Object.entries(options).map(([value, label]) => ({ value, label }));
/** 被字段权限裁剪的列显示占位，不当空值。 */
const cell = (row: Rule, field: string, render: (value: unknown) => ReactNode) =>
  field in row ? render(row[field]) : <span className="probation-settings-hint">{s.trimmed}</span>;
const text = (options: Record<string, string>) => (value: unknown) => options[String(value)] ?? String(value);

/** 试用结果字典：编码 → 名称；表单候选只给启用项，已停用的当前值仍显示原名称。 */
function useResults(kind: RuleKind) {
  // 只有 B57 用到试用结果；B58 不读字典。
  const read = useRead<unknown>(kind === 'regularization' ? RESULTS_PATH : null);
  try {
    return read.data === undefined ? [] : parseResults(read.data);
  } catch {
    return [];
  }
}

type Column = { key: string; title: string; width?: number; render(_: unknown, row: Rule): ReactNode };
const column = (field: string, show: (value: unknown) => ReactNode, width?: number): Column => ({
  key: field,
  title: LABELS[field]!,
  width,
  render: (_, row) => cell(row, field, show),
});
const status = (value: unknown) => (value ? <Tag color="green">{s.enabled}</Tag> : <Tag>{s.disabled}</Tag>);
const orgs = (ids: unknown) => <RefLabels path={refPaths.orgId} ids={ids} />;
/** 列：B57 多业务处理规则与试用结果，B58 多考核类型；天数列按规则类型取到期前 / 入职后。 */
function ruleColumns(kind: RuleKind, resultNames: Record<string, string>): Column[] {
  const regularization = kind === 'regularization';
  return [
    column('priority', String, 80),
    column('name', String),
    column('orgIds', orgs),
    column('includeSubordinates', (value) => (value ? s.yes : s.no), 110),
    regularization
      ? column('mode', text(RULE_OPTIONS.mode))
      : column('assessmentType', text(RULE_OPTIONS.assessmentType)),
    column(RULES[kind].days, String, 130),
    column('initiatorType', text(RULE_OPTIONS.initiatorType)),
    ...(regularization ? [column('probationResult', text(resultNames))] : []),
    { ...column('enabled', status, 90), title: s.status },
  ];
}

function useRules(kind: RuleKind) {
  const read = useRead<unknown>(RULES[kind].path);
  let rows: Rule[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) rows = parseRules(read.data);
  } catch (cause) {
    error = cause;
  }
  return { rows, error, loading: !error && read.data === undefined, reload: read.refresh };
}

export function RulesTab({ kind }: { kind: RuleKind }) {
  const permission = usePermissions(SETTINGS_OBJECT);
  const access = ruleAccess(kind, permission.snapshot.objects[SETTINGS_OBJECT], permission.menus);
  const { rows, error, loading, reload } = useRules(kind);
  const results = useResults(kind);
  const [editing, setEditing] = useState<{ row?: Rule }>();
  const forbidden = error instanceof ApiError && error.status === 403;
  const ready = !error && !loading;
  const ruleNames = Object.fromEntries(rows.map((row) => [row.id, String(row.name ?? row.id)]));
  const resultNames = Object.fromEntries(results.map((row) => [row.code, row.name]));
  const operations = access.update || access.copy || access.toggle || access.remove;
  const operation: Column = {
    key: 'operation',
    title: s.operation,
    render: (_, row) => (
      <RuleRowCommands
        kind={kind}
        row={row}
        access={access}
        edit={access.update && !ruleTrimmed(kind, row) ? () => setEditing({ row }) : undefined}
        reload={reload}
      />
    ),
  };
  return (
    <>
      <SettingBlock spec={switchSpec(RULES[kind].setting, s.rules[kind].switch)} />
      <header className="probation-settings-heading">
        <h1>{s.rules[kind].rule}</h1>
        {ready && access.create && (
          <Button type="primary" onClick={() => setEditing({})}>
            {s.create}
          </Button>
        )}
      </header>
      <p className="probation-settings-hint">{s.priorityHint}</p>
      {ready && access.run && <RunPanel kind={kind} ruleNames={ruleNames} />}
      {forbidden && <PageState kind="forbidden" />}
      {!!error && !forbidden && <PageState kind="error" error={error} retry={reload} />}
      {loading && <PageState kind="loading" />}
      {ready && (
        <Table<Rule>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: s.rulesEmpty }}
          columns={[...ruleColumns(kind, resultNames), ...(operations ? [operation] : [])]}
        />
      )}
      {editing && (
        <RuleForm kind={kind} row={editing.row} results={results} close={() => setEditing(undefined)} reload={reload} />
      )}
    </>
  );
}

async function sendRule(api: Api, kind: RuleKind, command: Command<Values>, id?: string) {
  const raw = await api.request<unknown>(id ? rowPath(kind, id) : RULES[kind].path, {
    method: id ? 'PUT' : 'POST',
    command,
  });
  return parseRuleReceipt(raw, { id, revision: command.revision ?? 0 });
}

const field = (name: string, control: ReactNode, rules: FormField['rules'] = []): FormField => ({
  name,
  label: LABELS[name]!,
  control,
  access: { visible: true, editable: true },
  rules,
});
const required = { required: true, message: s.required };
const select = (options: Record<string, string>) => <Select options={optionsOf(options)} />;
/** 表单项：新增 / 编辑都是整份规则（ruleAccess 已要求全部字段可编辑）。 */
function ruleFields(kind: RuleKind, results: ReturnType<typeof useResults>, row?: Rule): FormField[] {
  const conf = RULES[kind];
  // 停用的试用结果不再可选；本行已保存的旧值仍显示原名称（resultsHint）。
  const resultOptions = results
    .filter((item) => item.enabled || item.code === row?.probationResult)
    .map((item) => ({ value: item.code, label: item.name, disabled: !item.enabled }));
  return [
    field('name', <Input maxLength={conf.nameMax} />, [{ ...required, whitespace: true }]),
    field('priority', <InputNumber precision={0} />, [
      { required: true, type: 'integer', min: 0, max: PRIORITY_MAX, message: s.priorityRange },
    ]),
    field('orgIds', <RefSelect path={refPaths.orgId} multiple ariaLabel={s.orgIds} />, [
      { ...required, type: 'array', min: 1 },
      { type: 'array', max: ORG_MAX, message: s.orgLimit },
    ]),
    field('includeSubordinates', <Switch aria-label={s.includeSubordinates} />),
    kind === 'regularization'
      ? field('mode', select(RULE_OPTIONS.mode), [required])
      : field('assessmentType', select(RULE_OPTIONS.assessmentType), [required]),
    // 天数不设控件上下限：越界值保留在输入框里，由规则报原站原文（AC-PB-12 / B57）。
    field(conf.days, <InputNumber precision={0} />, [
      { required: true, type: 'integer', min: conf.daysMin, max: conf.daysMax, message: conf.daysMessage },
    ]),
    ...(kind === 'regularization' ? [field('probationResult', <Select options={resultOptions} />, [required])] : []),
    field('initiatorType', select(RULE_OPTIONS.initiatorType), [required]),
    // 启停在列表行内操作；新增时可直接设为不启用。
    ...(row ? [] : [field('enabled', <Switch aria-label={s.enable} />)]),
  ];
}

function RuleForm({
  kind,
  row,
  results,
  close,
  reload,
}: {
  kind: RuleKind;
  row?: Rule;
  results: ReturnType<typeof useResults>;
  close(): void;
  reload(): void;
}) {
  const api = useApiClient();
  const writer = useConflictCommand(
    RULES[kind].path,
    row ? snapshotOf(kind, row) : { revision: 0, values: DEFAULTS[kind] },
    useRule(kind, row),
    { action: row ? 'edit' : 'create' },
  );
  const fields = ruleFields(kind, results, row);
  const editable = fields.map((item) => item.name);
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row ? rowPath(kind, row.id) : RULES[kind].path}
      submission={writer.form}
      title={`${row ? s.edit : s.create}${s.rules[kind].rule}`}
      initialValues={row ? ruleValues(kind, row) : DEFAULTS[kind]}
      groups={[{ title: s.rules[kind].rule, fields }]}
      onClose={() => {
        if (writer.stale) reload();
        close();
      }}
      onSubmit={async (values) => {
        if (row && !changedFields(values, writer.full, editable).length) {
          void message.info(s.unchanged);
          return;
        }
        // 整份严格提交：未改项取最新全量（冲突重读后即最新版本），不让后端默认值覆盖未改字段。
        const body = (edited: Values) => ruleBody(kind, { ...DEFAULTS[kind], ...writer.full }, edited);
        await writer.run({
          values,
          editableFields: editable,
          send: ({ edited, command }) => sendRule(api, kind, { ...command, body: body(edited) }, row?.id),
        });
        reload();
      }}
    />
  );
}

/**
 * 行内复制 / 启停 / 删除。复制是新建（集合槽、If-Match 0）；启停、删除是本对象命令（对象槽、本行版本），
 * 同对象不同动作互斥（forAction）。
 */
function RuleRowCommands(props: { kind: RuleKind; row: Rule; access: RuleAccess; edit?: () => void; reload(): void }) {
  const { kind, row, access, edit, reload } = props;
  const api = useApiClient();
  const read = useRule(kind, row);
  const path = RULES[kind].path;
  const copier = useConflictCommand(path, { revision: 0, values: {} }, undefined, { action: 'copy' });
  const toggler = useConflictCommand(path, snapshotOf(kind, row), read, { action: 'toggle' });
  const remover = useConflictCommand(path, snapshotOf(kind, row), read, { action: 'remove' });
  const locked = toggler.form.locked || remover.form.locked;
  const request = (tail: string, method: 'POST' | 'PUT' | 'DELETE', command: Command<Values>) =>
    api.request<unknown>(rowPath(kind, row.id, tail), { method, command });
  const copy = () =>
    perform(copier, {}, s.copied, reload, async (command) =>
      parseRuleReceipt(await request('/copy', 'POST', command), { revision: 0 }),
    );
  const toggle = () =>
    perform(toggler, { enabled: !row.enabled }, s.saved, reload, async (command) =>
      parseRuleReceipt(await request('/enabled', 'PUT', command), { id: row.id, revision: command.revision ?? 0 }),
    );
  const remove = () =>
    perform(remover, {}, s.removed, reload, async (command) =>
      parseDeleteReceipt(await request('', 'DELETE', { ...command, body: {} }), row.id),
    );
  const toggleText = row.enabled ? s.disable : s.enable;
  return (
    <>
      <Space size={4} wrap>
        {edit && (
          <Button type="link" onClick={edit}>
            {s.edit}
          </Button>
        )}
        {access.copy && <Confirm title={s.copyConfirm} label={s.copy} disabled={copier.form.locked} onConfirm={copy} />}
        {access.toggle && 'enabled' in row && (
          <Confirm
            title={s.toggleConfirm(toggleText)}
            label={toggleText}
            disabled={locked}
            danger={row.enabled === true}
            onConfirm={toggle}
          />
        )}
        {access.remove && (
          <Confirm title={s.removeConfirm} label={s.remove} disabled={locked} danger onConfirm={remove} />
        )}
      </Space>
      <CommandStatus submission={copier.form} labels={LABELS} />
      <CommandStatus submission={toggler.form} labels={LABELS} />
      <CommandStatus submission={remover.form} labels={LABELS} />
    </>
  );
}
