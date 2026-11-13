// F-326 F1：配置中心 › 公共变量（全局）/ 各应用 › 流程设置 › 应用变量。原站口径 docs/02_业务建模/30 §流程矩阵与变量 二、三：
// 两个页签（草稿 + 启用 / 停用）、提示文案、列表列、行操作按状态；不做删除、批量、导入导出（DEC-874）。
import { Alert, Button, Table, Tabs, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useRead } from '../../contracts/useRead.js';
import { PageState } from '../../foundation/PageState.js';
import { useSession } from '../../foundation/Session.js';
import { FormCommands } from '../../foundation/forms/useCommandForm.js';
import { variableStore } from './commands.js';
import { m, type ScopeKind } from './messages.js';
import {
  PAGE_SIZE,
  TABS,
  appFromPath,
  isAllScopes,
  listPath,
  orderedScopes,
  parsePage,
  type Tab,
  type VariableRow,
} from './model.js';
import { usePeopleNames } from './people.js';
import { ReferencesModal, useImpactConfirm } from './References.js';
import { VariableActions } from './VariableActions.js';
import { VariableForm } from './VariableForm.js';

export function PublicVariablesPage() {
  return (
    <FormCommands store={variableStore}>
      <VariableList scope="public" />
    </FormCommands>
  );
}

/** 六个应用共用一个页面：应用取自路由（app-variables-<app>），路由不识别时不发请求。 */
export function AppVariablesPage() {
  const app = appFromPath(useLocation().pathname);
  return (
    <FormCommands store={variableStore}>
      {app ? <VariableList key={app} scope="application" app={app} /> : <PageState kind="not-found" />}
    </FormCommands>
  );
}

/** 最近修改时间：租户时区 YYYY-MM-DD HH:mm（DEC-056），不用浏览器时区。 */
function minuteText(value: string, timezone: string | undefined) {
  const instant = new Date(value);
  if (!timezone || Number.isNaN(instant.getTime())) return m.missing;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** 默认值列：人员显示姓名（行上回显的 people），布尔显示是 / 否，未设置显示 --。 */
function defaultText(row: VariableRow) {
  const value = row.defaultValue;
  if (value === null || value === undefined || value === '') return m.missing;
  if (row.dataType === 'person' || row.dataType === 'persons') {
    const ids = Array.isArray(value) ? (value as string[]) : [value as string];
    return ids.map((id) => row.people.find((person) => person.userId === id)?.name ?? m.missing).join('、');
  }
  if (typeof value === 'boolean') return value ? m.booleans.true : m.booleans.false;
  return String(value);
}
const usageText = (scopes: readonly string[]) =>
  isAllScopes(scopes)
    ? m.usageAll
    : orderedScopes(scopes)
        .map((scope) => m.usage[scope])
        .join('、') || m.missing;

function useRows(scope: ScopeKind, app: string | undefined, tab: Tab, offset: number) {
  const read = useRead<unknown>(listPath(scope, app, tab, offset));
  let rows: VariableRow[] = [];
  let total = 0;
  let error = read.error;
  try {
    if (read.data !== undefined) ({ items: rows, total } = parsePage(read.data));
  } catch (cause) {
    error = cause;
  }
  return { rows, total, error, loading: read.loading, reload: read.refresh };
}

/** 列表列（规格 30 §二、三）：应用变量不显示适用范围与描述。 */
function columnsOf(
  scope: ScopeKind,
  timezone: string | undefined,
  nameOf: (id: string | null) => string,
  actions: (row: VariableRow) => ReactNode,
) {
  return [
    { key: 'code', title: m.code, render: (_: unknown, row: VariableRow) => row.code },
    { key: 'name', title: m.name, render: (_: unknown, row: VariableRow) => row.name },
    {
      key: 'dataType',
      title: m.dataType,
      render: (_: unknown, row: VariableRow) => m.dataTypes[row.dataType] ?? row.dataType,
    },
    { key: 'defaultValue', title: m.defaultValue, render: (_: unknown, row: VariableRow) => defaultText(row) },
    ...(scope === 'public'
      ? [{ key: 'usage', title: m.usageScopes, render: (_: unknown, row: VariableRow) => usageText(row.usageScopes) }]
      : []),
    { key: 'status', title: m.status, render: (_: unknown, row: VariableRow) => m.statuses[row.status] ?? row.status },
    ...(scope === 'public'
      ? [
          {
            key: 'description',
            title: m.description,
            render: (_: unknown, row: VariableRow) => (
              <Typography.Text ellipsis={{ tooltip: row.description }} style={{ maxWidth: 240 }}>
                {row.description || m.missing}
              </Typography.Text>
            ),
          },
        ]
      : []),
    { key: 'updatedBy', title: m.updatedBy, render: (_: unknown, row: VariableRow) => nameOf(row.updatedBy) },
    {
      key: 'updatedAt',
      title: m.updatedAt,
      render: (_: unknown, row: VariableRow) => minuteText(row.updatedAt, timezone),
    },
    {
      key: 'actions',
      title: m.actions,
      render: (_: unknown, row: VariableRow) => actions(row),
    },
  ];
}

function VariableList({ scope, app }: { scope: ScopeKind; app?: string }) {
  const session = useSession();
  const [tab, setTab] = useState<Tab>('active');
  const [offset, setOffset] = useState(0);
  const { rows, total, error, loading, reload } = useRows(scope, app, tab, offset);
  const [editing, setEditing] = useState<{ row?: VariableRow }>();
  const [viewing, setViewing] = useState<VariableRow>();
  const [notice, setNotice] = useState<string>();
  const impact = useImpactConfirm();
  const nameOf = usePeopleNames(rows.map((row) => row.updatedBy).filter((id): id is string => !!id));
  const labels = m.tabs(scope);
  const columns = columnsOf(scope, session.timezone, nameOf, (row) => (
    <VariableActions
      row={row}
      impact={impact}
      edit={() => setEditing({ row })}
      references={() => setViewing(row)}
      saved={reload}
      failed={setNotice}
    />
  ));
  return (
    <section className="approval-variables">
      <header className="page-heading">
        <h1>{m.kind[scope]}</h1>
        {!error && !loading && (
          <Button type="primary" onClick={() => setEditing({})}>
            {m.create}
          </Button>
        )}
      </header>
      <Tabs
        activeKey={tab}
        onChange={(key) => {
          setTab(key as Tab);
          setOffset(0);
          setNotice(undefined);
        }}
        items={TABS.map((key) => ({ key, label: labels[key] }))}
      />
      <Alert type="info" showIcon message={m.hint[scope]} />
      {notice && <Alert type="error" showIcon closable message={notice} onClose={() => setNotice(undefined)} />}
      {!!error && <PageState kind="error" error={error} retry={reload} />}
      {!error && loading && <PageState kind="loading" />}
      {!error && !loading && (
        <Table<VariableRow>
          size="small"
          rowKey="id"
          dataSource={rows}
          columns={columns}
          locale={{ emptyText: m.empty }}
          pagination={{
            current: Math.floor(offset / PAGE_SIZE) + 1,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            hideOnSinglePage: true,
            onChange: (next) => setOffset((next - 1) * PAGE_SIZE),
          }}
        />
      )}
      {editing && (
        <VariableForm
          scope={scope}
          app={app}
          row={editing.row}
          impact={impact}
          close={() => setEditing(undefined)}
          saved={reload}
        />
      )}
      {viewing && <ReferencesModal row={viewing} close={() => setViewing(undefined)} />}
      {impact.holder}
    </section>
  );
}
