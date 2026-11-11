import { Button, Dropdown, Modal, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { KeywordFilter } from '../contracts/Filters.js';
import { RefSelect } from '../contracts/references.js';
import { useRead } from '../part-time/useRead.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { PageState } from '../foundation/PageState.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { usePermissions } from '../foundation/Permissions.js';
import { refPaths } from '../part-time/references.js';
import { exitStore } from './commands.js';
import { useExitCommand } from './ExitCommands.js';
import { ExitDetail, HandoverButton, fieldValue } from './ExitDetail.js';
import { ExitForm, type ExitFormProps } from './ExitForm.js';
import { ExitImportEntry } from './ExitImport.js';
import { x } from './messages.js';
import {
  BATCH_LIMIT,
  VIEWS,
  activationBadge,
  allowedFilters,
  batchEntryVisible,
  batchHandoverRows,
  columns,
  createEntries,
  exits,
  isView,
  listPath,
  object,
  pageSize,
  parseBatchReceipts,
  personObject,
  rowEntries,
  type BatchReceipt,
  type ExitView,
  type Filters,
  type ListResult,
  type Row,
} from './exit-model.js';
import './exit.css';

export function ExitPage() {
  return (
    <FormCommands store={exitStore}>
      <div className="exit-page">
        <DecisionNote id="exits" />
        <ExitList />
      </div>
    </FormCommands>
  );
}

/** 关键字要姓名、工号都可见，部门要任职记录部门可见；不可见就不显示控件、也不进请求。 */
function useFilterPermission() {
  const employment = usePermissions(object);
  const person = usePermissions(personObject);
  return (key: keyof Filters) =>
    key === 'keyword'
      ? person.field('name').visible && person.field('code').visible
      : employment.field('departmentId').visible;
}

type Opened = { kind: 'detail'; id: string } | { kind: 'form'; props: Pick<ExitFormProps, 'mode' | 'employee'> };
/** 行内“离职处理”（B15）：复用直接离职表单，预填该行员工。 */
const handle = (row: Row): Opened => ({
  kind: 'form',
  props: { mode: 'direct', employee: { value: row.employeeId!, label: row.name ?? x.missing } },
});

function Heading(props: { permission: ObjectPermission | undefined; open(o: Opened): void }) {
  return (
    <div className="exit-heading">
      <h1>{x.title}</h1>
      <Space>
        {createEntries(props.permission).map((mode) => (
          <Button key={mode} type="primary" onClick={() => props.open({ kind: 'form', props: { mode } })}>
            {x.entries[mode]}
          </Button>
        ))}
      </Space>
    </div>
  );
}

function Pager(props: { page: number; total: number; loading: boolean; hasNext: boolean; go(page: number): void }) {
  const { page, loading } = props;
  return (
    <Space className="exit-pagination">
      <Button disabled={page === 1 || loading} onClick={() => props.go(page - 1)}>
        {x.previous}
      </Button>
      <span>{x.page(page, props.total)}</span>
      <Button disabled={!props.hasNext || loading} onClick={() => props.go(page + 1)}>
        {x.next}
      </Button>
    </Space>
  );
}

function ExitList() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('view');
  const view: ExitView = isView(requested) ? requested : 'in_progress';
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});
  const [opened, open] = useState<Opened>();
  const allowed = useFilterPermission();
  const result = useRead<ListResult>(listPath(view, page, allowedFilters(filters, allowed)));
  const switchView = (next: ExitView) => {
    setParams({ view: next });
    setPage(1);
    setFilters({});
  };
  // 新建成功后员工进入“离职中”：切过去并重读，视图未变时直接重读
  const created = async () => (view === 'in_progress' && page === 1 ? result.reload() : switchView('in_progress'));
  // F-493 §9.1：保存受理后刷新回“离职中的员工”第 1 页
  const imported = async () => (view === 'in_progress' && page === 1 ? result.reload() : switchView('in_progress'));
  const applyFilters = (next: Filters) => {
    setPage(1);
    setFilters(next);
  };
  const permission = usePermissions(object).snapshot.objects[object];
  const items = result.data?.items ?? [];
  // 勾选只在当前视图 / 页内有效（切视图、翻页即清空）；刷新后不在本页的行自然落选
  const scope = `${view}/${page}`;
  const [picked, pick] = useState<{ scope: string; ids: string[] }>({ scope, ids: [] });
  const selected = items.filter((row) => picked.scope === scope && picked.ids.includes(row.id));
  return (
    <>
      <Heading permission={permission} open={open} />
      <nav className="exit-views" aria-label={x.title}>
        {VIEWS.map((key) => (
          <Button
            key={key}
            type={view === key ? 'primary' : 'default'}
            aria-pressed={view === key}
            onClick={() => switchView(key)}
          >
            {x.views[key]}
          </Button>
        ))}
      </nav>
      <section className="exit-card">
        <Space wrap>
          <FilterBar key={view} filters={filters} allowed={allowed} apply={applyFilters} onRefresh={result.refresh} />
          <ExitImportEntry permission={permission} onImported={imported} />
          {batchEntryVisible(permission) && (
            <BatchHandover key={scope} rows={batchHandoverRows(selected, permission)} refresh={result.reload} />
          )}
        </Space>
        {result.error ? (
          <PageState kind="error" error={result.error} retry={result.refresh} />
        ) : (
          <ExitTable
            view={view}
            rows={items}
            selected={selected.map((row) => row.id)}
            select={(ids) => pick({ scope, ids })}
            loading={result.loading}
            noScope={result.data?.hasDataPermission === false}
            open={open}
            refresh={result.reload}
          />
        )}
        <Pager
          page={page}
          total={result.data?.total ?? 0}
          loading={result.loading}
          hasNext={items.length >= pageSize}
          go={setPage}
        />
      </section>
      {opened?.kind === 'detail' && (
        <ExitDetail key={opened.id} id={opened.id} onClose={() => open(undefined)} refresh={result.reload} />
      )}
      {opened?.kind === 'form' && <ExitForm {...opened.props} onClose={() => open(undefined)} onDone={created} />}
    </>
  );
}

/** 关键字回车 / 失焦即应用（同合同列表），部门选中即应用；筛选变了回到第 1 页。 */
function FilterBar(props: {
  filters: Filters;
  allowed: (key: keyof Filters) => boolean;
  apply(filters: Filters): void;
  onRefresh(): void;
}) {
  const { filters, apply } = props;
  return (
    <>
      {props.allowed('keyword') && (
        <KeywordFilter value={filters.keyword} apply={(keyword) => apply({ ...filters, keyword })} />
      )}
      {props.allowed('departmentId') && (
        <RefSelect
          path={refPaths.departmentId!}
          ariaLabel={x.fields.departmentId}
          value={filters.departmentId ?? null}
          onChange={(value) => apply({ ...filters, departmentId: typeof value === 'string' ? value : undefined })}
        />
      )}
      <Button onClick={props.onRefresh}>{x.refresh}</Button>
    </>
  );
}

function ExitTable(props: {
  view: ExitView;
  rows: Row[];
  selected: string[];
  select(ids: string[]): void;
  loading: boolean;
  noScope: boolean;
  open(opened: Opened): void;
  refresh(): Promise<unknown>;
}) {
  const operation = (row: Row) => (
    <Space wrap>
      <Button type="link" onClick={() => props.open({ kind: 'detail', id: row.id })}>
        {x.open}
      </Button>
      {rowEntries(row).map((entry) =>
        entry === 'handle' ? (
          <Button key={entry} type="link" onClick={() => props.open(handle(row))}>
            {x.entries.handle}
          </Button>
        ) : (
          <HandoverButton
            key={entry}
            kind="submit-from-list"
            exitId={row.id}
            target={{ id: row.id, revision: Number(row.revision) }}
            refresh={props.refresh}
          />
        ),
      )}
    </Space>
  );
  return (
    <Table<Row>
      size="small"
      rowKey="id"
      pagination={false}
      loading={props.loading}
      dataSource={props.rows}
      rowSelection={{
        selectedRowKeys: props.selected,
        onChange: (keys) => props.select(keys.map(String)),
      }}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: props.noScope ? x.noScope : x.empty }}
      columns={[
        ...columns[props.view].map((key) => ({
          key,
          title: x.fields[key],
          render: (_: unknown, row: Row) => (key === 'name' ? <NameCell row={row} /> : fieldValue(row, key)),
        })),
        {
          key: 'operation',
          title: x.operation,
          fixed: 'right' as const,
          render: (_: unknown, row: Row) => operation(row),
        },
      ]}
    />
  );
}

/** 生效失败 / 挂起（exit-queries.ts activation）：列表只给通用标记，原因在详情。 */
function NameCell({ row }: { row: Row }) {
  const badge = activationBadge(row);
  return (
    <>
      {fieldValue(row, 'name')}
      {badge && <Tag color="error">{badge}</Tag>}
    </>
  );
}

type BatchResult = { receipts: BatchReceipt[]; names: Map<string, string> };
/**
 * 批量发起交接（F-317 / F-386）：收在“离职处理▾”菜单里，只对已勾选且带行动作的单，逐人回执列出失败原因；
 * 版本逐条在请求体里，不带 If-Match。写后刷新可能让已勾选的行不再有可发起的行（整批未发起成功也会被服务端
 * 摘掉行动作）：菜单项随之不可点，回执与状态条保留。
 */
function BatchHandover({ rows, refresh }: { rows: Row[]; refresh(): Promise<unknown> }) {
  const pinned = rows.slice(0, BATCH_LIMIT).map((row) => ({ id: row.id, revision: Number(row.revision) }));
  const ids = pinned.map((item) => item.id);
  const cmd = useExitCommand(exits, { revision: undefined, baseline: {} }, 'batch-handover', refresh, pinned);
  const [result, setResult] = useState<BatchResult>();
  const run = async () => {
    // 提交时的姓名快照：刷新后行可能不在本页
    const names = new Map(rows.map((row) => [row.id, row.name ?? row.id]));
    let parsed: BatchReceipt[] = [];
    try {
      const done = await cmd.submit({}, [], {
        path: `${exits}/handover/batch-submit`,
        method: 'POST',
        noRevision: true,
        confirmable: false,
        body: () => ({ items: pinned.map((item) => ({ exitRequestId: item.id, revision: item.revision })) }),
        accept: (raw) => void (parsed = parseBatchReceipts(raw, ids)),
      });
      if (done) setResult({ receipts: parsed, names });
    } catch {
      // 拒绝 / 结果未知由内核状态条显示
    }
  };
  return (
    <Space direction="vertical">
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            {
              key: 'batch-handover',
              // 没有勾选带行动作的行时不可点（服务端逐条复核，这里只是不发空批）
              disabled: rows.length === 0 || cmd.disabled,
              label: x.entries.batchHandover + (rows.length > BATCH_LIMIT ? ` ${x.batchLimit(BATCH_LIMIT)}` : ''),
            },
          ],
          onClick: () => void run(),
        }}
      >
        <Button loading={cmd.form.busy}>{x.entries.handleMenu} ▾</Button>
      </Dropdown>
      <CommandStatus submission={cmd.form} />
      {result && (
        <Modal open title={x.batchResult} footer={null} onCancel={() => setResult(undefined)}>
          <ul aria-label={x.batchResult}>
            {result.receipts.map((item) => (
              <li key={item.exitRequestId}>
                {result.names.get(item.exitRequestId)}：{x.outcomes[item.outcome] ?? item.outcome}
                {item.reason && `（${item.reason}）`}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </Space>
  );
}
