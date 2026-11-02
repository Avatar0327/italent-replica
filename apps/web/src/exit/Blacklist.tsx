// B68 黑名单名单页（FE-R2c2b）：在名单 / 已移出两种状态，按姓名、证件号码、手机号、加黑原因、数据来源筛选，
// 上一页 / 下一页翻页（接口无总数）；手工加黑、编辑、移出、删除按对象权限与按钮给出。被裁剪的字段列显示占位，
// 不出现在筛选里（服务端按不可查看字段筛选回 403）。选择员工加黑与导入未做（未决）。
import { BLACKLIST_NOTE_MAX, BLACKLIST_REASONS, BLACKLIST_SOURCES } from '@italent/domain';
import { Button, Form, Input, Radio, Select, Space, Table, type FormInstance } from 'antd';
import { useState, type ReactNode } from 'react';
import type { Command } from '../foundation/client.js';
import type { FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import type { Values } from '../foundation/forms/store.js';
import { projectFields } from '../foundation/forms/values.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import {
  RecordForm,
  RowActions,
  cell,
  fieldColumn,
  label,
  options,
  rowReader,
  useParsed,
  type RowAction,
} from './settings-commands.js';
import { s } from './settings-messages.js';
import {
  BLACKLIST_CREATE_FIELDS,
  BLACKLIST_FILTER_FIELDS,
  BLACKLIST_IDENTITIES,
  BLACKLIST_OBJECT,
  BLACKLIST_PATH,
  BLACKLIST_UPDATE_FIELDS,
  batchBody,
  blacklistAccess,
  blacklistQuery,
  hasIdentity,
  parseBlacklistDeleteReceipt,
  parseBlacklistPage,
  parseRemoveReceipt,
  parseRowReceipt,
  rowPath,
  type BlacklistAccess,
  type BlacklistFilter,
  type BlacklistStatus,
  type Row,
} from './settings-model.js';

const b = s.blacklist;
const LABELS: Record<string, string> = b;
// 有选项的列按原站文案显示，筛选也给下拉。
const CHOICES: Record<string, Readonly<Record<string, string>>> = {
  reason: BLACKLIST_REASONS,
  source: BLACKLIST_SOURCES,
};
const COLUMNS = ['name', 'idNumber', 'mobilePhone', 'reason', 'blacklistDate', 'expiryDate', 'email', 'source'];
/** 批量移出 / 删除逐条带版本、不用 If-Match：版本从命令里取出放进请求体。 */
const batch = ({ revision, ...command }: Command<Values>, id: string, fallback: number) => {
  const at = revision ?? fallback;
  return { at, command: { ...command, body: batchBody(id, at) } };
};

export function Blacklist() {
  const api = useApiClient();
  const permission = usePermissions(BLACKLIST_OBJECT);
  const object = permission.snapshot.objects[BLACKLIST_OBJECT];
  const [applied, setApplied] = useState<BlacklistFilter>({ status: 'active' });
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ row?: Row }>();
  // 筛选项只看字段权限；换筛选或状态时回到第 1 页，不把别的条件的页码带过去。
  const filterable = blacklistAccess(object, false).viewable;
  const path = blacklistQuery(applied, page, filterable);
  const parse = (raw: unknown) => parseBlacklistPage(raw, page);
  const { data, error, loading, reload } = useParsed(path, parse);
  const access = blacklistAccess(object, data?.hasDataPermission ?? false);
  const apply = (next: BlacklistFilter) => {
    setApplied(next);
    setPage(1);
  };
  const read = (id: string, values: (row: Row) => Values) =>
    rowReader(api, path, (raw) => parse(raw).items, id, values);
  const operable = access.updateFields.length > 0 || access.remove || access.delete;
  const actions = (_: unknown, row: Row) => (
    <RowActions
      resource={BLACKLIST_PATH}
      row={row}
      read={read(row.id, () => ({}))}
      edit={access.updateFields.length && row.status !== 'removed' ? () => setEditing({ row }) : undefined}
      actions={rowActions(api, row, access)}
      labels={LABELS}
      reload={reload}
    />
  );
  const columns = [
    ...COLUMNS.map((field) => fieldColumn(field, LABELS[field]!, CHOICES[field] && label(CHOICES[field]))),
    ...(operable ? [{ key: 'operation', title: s.operation, width: 180, render: actions }] : []),
  ];
  return (
    <section aria-label={s.tabs.blacklist}>
      <header className="exit-heading">
        <h1>{s.tabs.blacklist}</h1>
        {access.create && (
          <Button type="primary" onClick={() => setEditing({})}>
            {b.create}
          </Button>
        )}
      </header>
      <Filters applied={applied} filterable={filterable} apply={apply} />
      {data && !data.hasDataPermission && <p className="exit-hint">{b.noScope}</p>}
      {!!error && <PageState kind="error" error={error} retry={reload} />}
      {loading && <PageState kind="loading" />}
      {data && (
        <>
          <Table<Row>
            size="small"
            rowKey="id"
            dataSource={data.items}
            pagination={false}
            locale={{ emptyText: s.empty }}
            columns={columns}
          />
          <Pager page={page} hasNext={data.hasNext} go={setPage} />
        </>
      )}
      {editing && (
        <EntryForm
          row={editing.row}
          access={access}
          read={editing.row && read(editing.row.id, (row) => projectFields(row, BLACKLIST_UPDATE_FIELDS))}
          close={() => setEditing(undefined)}
          reload={reload}
        />
      )}
    </section>
  );
}

/** 筛选：草稿在表单里，点“查询”才生效；只给可查看的字段（服务端按不可查看字段筛选回 403）。 */
function Filters(props: {
  applied: BlacklistFilter;
  filterable(field: string): boolean;
  apply(next: BlacklistFilter): void;
}) {
  const { applied, filterable, apply } = props;
  const [draft] = Form.useForm<BlacklistFilter>();
  return (
    <Space className="exit-settings-filter" wrap>
      <Radio.Group
        optionType="button"
        value={applied.status}
        options={(['active', 'removed'] as const).map((value) => ({ value, label: s.blacklistStatus[value]! }))}
        onChange={(event) => apply({ ...applied, status: event.target.value as BlacklistStatus })}
      />
      <Form form={draft} layout="inline" onFinish={(values) => apply({ ...values, status: applied.status })}>
        {BLACKLIST_FILTER_FIELDS.filter(filterable).map((field) => (
          <Form.Item key={field} name={field}>
            {CHOICES[field] ? (
              <Select allowClear placeholder={b[field]} aria-label={b[field]} options={options(CHOICES[field])} />
            ) : (
              <Input allowClear placeholder={b[field]} aria-label={b[field]} maxLength={64} />
            )}
          </Form.Item>
        ))}
        <Button type="primary" htmlType="submit">
          {b.search}
        </Button>
        <Button
          onClick={() => {
            draft.resetFields();
            apply({ status: applied.status });
          }}
        >
          {b.reset}
        </Button>
      </Form>
    </Space>
  );
}

function Pager({ page, hasNext, go }: { page: number; hasNext: boolean; go(page: number): void }) {
  return (
    <Space className="exit-settings-pager">
      <Button disabled={page === 1} onClick={() => go(page - 1)}>
        {b.prev}
      </Button>
      <span>{s.page(page)}</span>
      <Button disabled={!hasNext} onClick={() => go(page + 1)}>
        {b.next}
      </Button>
    </Space>
  );
}

function rowActions(api: ReturnType<typeof useApiClient>, row: Row, access: BlacklistAccess): RowAction[] {
  const remove: RowAction = {
    label: b.removeAction,
    confirm: b.removeConfirm,
    send: async (command) => {
      const sent = batch(command, row.id, row.revision);
      const raw = await api.request<unknown>(`${BLACKLIST_PATH}/remove`, { method: 'POST', command: sent.command });
      return parseRemoveReceipt(raw, { id: row.id, revision: sent.at });
    },
  };
  const deletion: RowAction = {
    label: s.remove,
    confirm: b.deleteConfirm,
    send: async (command) => {
      const sent = batch(command, row.id, row.revision);
      const raw = await api.request<unknown>(`${BLACKLIST_PATH}/delete`, { method: 'POST', command: sent.command });
      return parseBlacklistDeleteReceipt(raw, row.id);
    },
  };
  return [...(access.remove && row.status !== 'removed' ? [remove] : []), ...(access.delete ? [deletion] : [])];
}

/** 新增只带填了的项（后端严格 DTO、文本至少 1 字）；编辑是补丁，清空的说明 / 截止日期提交 null。 */
function entryBody(edited: Values, create: boolean) {
  const entries = Object.entries(edited).map(([field, value]) => {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return [field, trimmed === '' || trimmed === undefined ? null : trimmed] as const;
  });
  return Object.fromEntries(create ? entries.filter(([, value]) => value !== null) : entries);
}

function EntryForm(props: {
  row?: Row;
  access: BlacklistAccess;
  read?: () => Promise<{ id: string; revision: number; values: Values }>;
  close(): void;
  reload(): void;
}) {
  const api = useApiClient();
  const { row, access } = props;
  const allowed: readonly string[] = row ? access.updateFields : access.createFields;
  const shown: readonly string[] = row ? ['name', ...BLACKLIST_UPDATE_FIELDS] : BLACKLIST_CREATE_FIELDS;
  const firstIdentity = BLACKLIST_IDENTITIES.find((field) => allowed.includes(field));
  const required = { required: true, whitespace: true, message: s.required };
  const controls: Record<string, ReactNode> = {
    name: <Input maxLength={100} />,
    idNumber: <Input maxLength={64} />,
    mobilePhone: <Input maxLength={32} />,
    email: <Input maxLength={254} />,
    reason: <Select aria-label={b.reason} options={options(BLACKLIST_REASONS)} />,
    expiryDate: <TenantDatePicker />,
    note: <Input.TextArea maxLength={BLACKLIST_NOTE_MAX} rows={3} />,
  };
  const rules: Record<string, FormField['rules']> = {
    name: [required],
    reason: [{ required: true, message: s.required }],
    ...(firstIdentity && !row
      ? {
          [firstIdentity]: [
            (form: FormInstance) => ({
              validator: () =>
                hasIdentity(form.getFieldsValue([...BLACKLIST_IDENTITIES]) as Values)
                  ? Promise.resolve()
                  : Promise.reject(new Error(b.identity)),
            }),
          ],
        }
      : {}),
  };
  const fields: FormField[] = shown.map((name) => ({
    name,
    label: LABELS[name]!,
    control: controls[name],
    // 编辑时姓名只读回显；其余按字段权限可看、按写能力可改。
    access: { visible: access.viewable(name), editable: allowed.includes(name) },
    display: row ? cell(row, name, name === 'reason' ? label(BLACKLIST_REASONS) : String) : undefined,
    rules: rules[name] ?? [],
  }));
  return (
    <RecordForm
      resource={BLACKLIST_PATH}
      title={row ? `${s.edit}${s.tabs.blacklist}` : b.create}
      row={row}
      values={row ? projectFields(row, BLACKLIST_UPDATE_FIELDS) : {}}
      read={props.read}
      fields={fields}
      send={async (_full, edited, command) => {
        const path = row ? rowPath(BLACKLIST_PATH, row.id) : BLACKLIST_PATH;
        const body = entryBody(edited, !row);
        const raw = await api.request<unknown>(path, { method: row ? 'PUT' : 'POST', command: { ...command, body } });
        return parseRowReceipt(raw, 'blacklist', { id: row?.id, revision: command.revision ?? 0 });
      }}
      close={props.close}
      reload={props.reload}
    />
  );
}
