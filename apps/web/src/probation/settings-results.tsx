// FE-R2c1b 试用结果字典页签（DEC-361）：列表、新增、编辑、启停，全部经 F-123 内核 useConflictCommand。
// 恢复槽是字典集合路径（新增）或集合路径 + 行 id（修改），动作记在槽上下文（同 exit/DictionaryCommands）。
import { Button, Input, InputNumber, Switch, Table, Tag, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { useRead } from '../contracts/useRead.js';
import { ApiError, type Command } from '../foundation/client.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import type { Values } from '../foundation/forms/store.js';
import { changedFields, projectFields } from '../foundation/forms/values.js';
import { Confirm, perform } from './settings-commands.js';
import { s } from './settings-messages.js';
import {
  CODE_MAX,
  NAME_MAX,
  ORDER_MAX,
  RESULTS_PATH,
  SETTINGS_OBJECT,
  nextOrder,
  parseResultReceipt,
  parseResults,
  resultAccess,
  resultFields,
  sameCode,
  type Result,
  type ResultAccess,
} from './settings-model.js';

type Api = ReturnType<typeof useApiClient>;
const labels: Record<string, string> = { code: s.code, name: s.name, enabled: s.enable, displayOrder: s.displayOrder };
const snapshotOf = (row: Result) => ({ id: row.id, revision: row.revision, values: projectFields(row, resultFields) });
const listOf = async (api: Api) => parseResults(await api.request<unknown>(RESULTS_PATH));
/** 字典没有单条读取接口：重读整份列表（上限 200）按 id 取本行。 */
function useRow(row?: Result) {
  const api = useApiClient();
  if (!row) return undefined;
  return async () => {
    const latest = (await listOf(api)).find((entry) => entry.id === row.id);
    if (!latest) throw new Error(s.rowGone);
    return snapshotOf(latest);
  };
}
async function sendResult(api: Api, command: Command<Values>, id?: string) {
  const path = id ? `${RESULTS_PATH}/${encodeURIComponent(id)}` : RESULTS_PATH;
  const raw = await api.request<unknown>(path, { method: id ? 'PUT' : 'POST', command });
  return parseResultReceipt(raw, { id, revision: command.revision ?? 0 });
}
/**
 * 新增 409 的拒绝原因前端读不到（ApiError 不带 details.reason）：重读列表按编码核对（不分大小写），
 * 确有同编码就把原因标到编码字段，输入保留可改正重提；否则（如字典已满）按原拒绝显示。
 */
async function codeTaken(api: Api, error: unknown, code: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409 || error.kind !== 'conflict') return error;
  const rows = await listOf(api).catch(() => undefined);
  if (!rows?.some((row) => sameCode(row.code, code))) return error;
  const details = { message: s.codeTaken, details: { fieldErrors: { code: [s.codeTaken] } } };
  return new ApiError(error.status, error.code, error.kind, error.message, details);
}

export function ResultsTab() {
  const permission = usePermissions(SETTINGS_OBJECT);
  const access = resultAccess(permission.snapshot.objects[SETTINGS_OBJECT], permission.menus);
  const read = useRead<unknown>(RESULTS_PATH);
  const [editing, setEditing] = useState<{ row?: Result }>();
  let rows: Result[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) rows = parseResults(read.data);
  } catch (cause) {
    error = cause;
  }
  const loading = !error && read.data === undefined;
  const editable = access.updateFields.some((field) => field !== 'enabled');
  const toggle = access.updateFields.includes('enabled');
  const reload = read.refresh;
  return (
    <>
      <header className="probation-settings-heading">
        <h1>{s.tabs.results}</h1>
        {access.create && !error && !loading && (
          <Button type="primary" onClick={() => setEditing({})}>
            {s.create}
          </Button>
        )}
      </header>
      {!access.create && !access.updateFields.length && <p className="probation-settings-hint">{s.readOnly}</p>}
      {!!error && <PageState kind="error" error={error} retry={reload} />}
      {loading && <PageState kind="loading" />}
      {!error && !loading && (
        <>
          <p className="probation-settings-hint">{s.resultsHint}</p>
          <Table<Result>
            size="small"
            rowKey="id"
            dataSource={rows}
            pagination={false}
            locale={{ emptyText: s.resultsEmpty }}
            columns={[
              { key: 'code', title: s.code, dataIndex: 'code', width: 220 },
              { key: 'name', title: s.name, dataIndex: 'name', width: 260 },
              {
                key: 'enabled',
                title: s.status,
                width: 120,
                render: (_: unknown, row: Result) =>
                  row.enabled ? <Tag color="green">{s.enabled}</Tag> : <Tag>{s.disabled}</Tag>,
              },
              { key: 'displayOrder', title: s.displayOrder, dataIndex: 'displayOrder', width: 120 },
              ...(editable || toggle
                ? [
                    {
                      key: 'operation',
                      title: s.operation,
                      render: (_: unknown, row: Result) => (
                        <ResultRowCommands
                          row={row}
                          toggle={toggle}
                          edit={editable ? () => setEditing({ row }) : undefined}
                          reload={reload}
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </>
      )}
      {editing && (
        <ResultForm row={editing.row} rows={rows} access={access} close={() => setEditing(undefined)} reload={reload} />
      )}
    </>
  );
}

function ResultForm({
  row,
  rows,
  access,
  close,
  reload,
}: {
  row?: Result;
  rows: readonly Result[];
  access: ResultAccess;
  close(): void;
  reload(): void;
}) {
  const api = useApiClient();
  const writer = useConflictCommand(RESULTS_PATH, row ? snapshotOf(row) : { revision: 0, values: {} }, useRow(row), {
    action: row ? 'edit' : 'create',
  });
  const allowed: readonly string[] = row ? access.updateFields : access.createFields;
  const field = (name: string, control: ReactNode, rules: FormField['rules'] = []): FormField => ({
    name,
    label: labels[name]!,
    control,
    // 编码保存后不可改，编辑时只读显示。
    access: { visible: true, editable: allowed.includes(name) && !(row && name === 'code') },
    display: name === 'code' ? row?.code : undefined,
    rules,
  });
  const required = { required: true, whitespace: true, message: s.required };
  const fields = [
    field('code', <Input maxLength={CODE_MAX} placeholder={s.codeHint} />, [required]),
    field('name', <Input maxLength={NAME_MAX} />, [required]),
    field('displayOrder', <InputNumber min={0} max={ORDER_MAX} precision={0} />, [
      { required: true, type: 'integer', min: 0, max: ORDER_MAX, message: s.orderRange },
    ]),
    // 启停在列表行内操作；新增时可直接设为不启用。
    ...(row ? [] : [field('enabled', <Switch aria-label={s.enable} />)]),
  ];
  const editable = fields.filter((item) => item.access.editable).map((item) => item.name);
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row ? `${RESULTS_PATH}/${row.id}` : RESULTS_PATH}
      submission={writer.form}
      title={`${row ? s.edit : s.create}${s.resultLabel}`}
      initialValues={row ? projectFields(row, resultFields) : { enabled: true, displayOrder: nextOrder(rows) }}
      groups={[{ title: s.resultLabel, fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新列表回查（DEC-067），结果未知的命令在槽上仍锁定。
        if (writer.stale) reload();
        close();
      }}
      onSubmit={async (values) => {
        // 修改是补丁语义：没有改动不发空请求（后端要求至少一个字段）。
        if (row && !changedFields(values, writer.full, editable).length) {
          void message.info(s.unchanged);
          return;
        }
        try {
          await writer.run({
            values,
            editableFields: editable,
            send: ({ command }) => sendResult(api, command, row?.id),
          });
        } catch (error) {
          throw row ? error : await codeTaken(api, error, values.code);
        }
        reload();
      }}
    />
  );
}

/** 行内启停：只改本行 enabled（PUT 补丁，带本行版本）；结果未知时同一行的编辑也锁定（同槽不同动作）。 */
function ResultRowCommands(props: { row: Result; toggle: boolean; edit?: () => void; reload(): void }) {
  const { row, toggle, edit, reload } = props;
  const api = useApiClient();
  const writer = useConflictCommand(RESULTS_PATH, snapshotOf(row), useRow(row), { action: 'toggle' });
  const text = row.enabled ? s.disable : s.enable;
  const run = () =>
    perform(writer, { enabled: !row.enabled }, s.saved, reload, (command) => sendResult(api, command, row.id));
  return (
    <>
      {edit && (
        <Button type="link" onClick={edit}>
          {s.edit}
        </Button>
      )}
      {toggle && (
        <Confirm
          title={s.toggleConfirm(text)}
          label={text}
          disabled={writer.form.locked}
          danger={row.enabled}
          onConfirm={run}
        />
      )}
      <CommandStatus submission={writer.form} labels={labels} />
    </>
  );
}
