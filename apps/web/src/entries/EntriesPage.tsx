import { Alert, Button, Dropdown, Space, Tabs, Tooltip, type TableColumnsType } from 'antd';
import { useCallback, useEffect, useRef, useState, type Key } from 'react';
import dayjs from 'dayjs';
import { EMPLOYEE_STATUS_LABELS, ENTRY_STATUS_LABELS } from '@italent/domain';
import { ListPage } from '../foundation/templates.js';
import { validObject } from '../foundation/forms/ConflictCommands.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import type { PageResult } from '../foundation/client.js';
import { NameOf, refPaths, useToday } from '../contracts/references.js';
import { CompleteLoader } from './CompleteForm.js';
import { collection, request, type Row, type View } from './model.js';
import { useEntryAccess } from './commands.js';
import { m } from './messages.js';
import './entries.css';

export function EntriesPage() {
  const session = useSession();
  return (
    <FormCommands key={`${session.tenantId}/${session.identityKey}`}>
      <EntryList />
    </FormCommands>
  );
}
function useEntries(view: View, page: { page: number; pageSize: number }) {
  const api = useApiClient();
  const path = `${collection}?view=${view}&page=${page.page}&pageSize=${page.pageSize}`;
  const epoch = useRef(0);
  const [state, setState] = useState<{ path: string; data?: PageResult<Row>; error?: unknown }>();
  const read = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const data = await request<PageResult<Row>>(api, path);
      if (current === epoch.current) setState({ path, data });
    } catch (error) {
      if (current === epoch.current) setState({ path, error });
      throw error;
    }
  }, [api, path]);
  useEffect(() => {
    void read().catch(() => {});
    return () => {
      epoch.current++;
    };
  }, [read]);
  const current = state?.path === path ? state : undefined;
  return { data: current?.data ?? { items: [] }, loading: !current, error: current?.error, read };
}
function EntryList() {
  const [view, setView] = useState<View>('all');
  const [page, setPage] = useState({ page: 1, pageSize: 30 });
  const [keys, setKeys] = useState<Key[]>([]);
  const [open, setOpen] = useState<Row>();
  const read = useEntries(view, page);
  const refresh = async () => {
    await read.read();
    setKeys([]);
  };
  const columns: TableColumnsType<Row> = m.columns[view].split('|').map((title) => ({
    title,
    key: title,
    width: m.columnWidths[title] ?? 140,
    ellipsis: true,
    render: (_, row) => cell(title, row),
  }));
  columns.push({
    title: (
      <Space>
        {'操作'}
        <Button size="small" disabled aria-label={m.settings}>
          ⚙
        </Button>
      </Space>
    ),
    key: 'actions',
    fixed: 'right',
    width: 164,
    render: (_, row) => <RowActions row={row} view={view} open={() => setOpen(row)} />,
  });
  return (
    <div className="entries-page">
      <Tabs
        activeKey={view}
        items={Object.entries(m.views).map(([key, label]) => ({ key, label }))}
        onChange={(key) => {
          setView(key as View);
          setPage({ ...page, page: 1 });
          setKeys([]);
          setOpen(undefined);
        }}
        tabBarExtraContent={
          <Space>
            {m.toolbar[view].map((label) => (
              <Button key={label} disabled>
                {label}
              </Button>
            ))}
            {view !== 'hired' && <Button disabled>{m.more} ▾</Button>}
          </Space>
        }
      />
      <Alert key={view} className="entry-notice" showIcon type="info" closable message={m.notices[view]} />
      <ListPage
        title={m.title}
        data={read.data}
        columns={columns}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={read.loading}
        error={read.error}
        retry={() => void read.read().catch(() => {})}
        filters={<Filters view={view} />}
        selection={{ keys, onChange: setKeys, actions: null }}
      />
      {open && <CompleteLoader row={open} onClose={() => setOpen(undefined)} refresh={refresh} />}
    </div>
  );
}
function Filters({ view }: { view: View }) {
  const today = useToday();
  return (
    <Space wrap>
      {m.filters[view].map((label) => (
        <Button key={label} type="text" disabled>
          {label}
          {view === 'hired' && label === '入职日期' && today
            ? `：${dayjs(today).subtract(6, 'month').format('YYYY-MM-DD')} ~ ${today}`
            : ' ▾'}
        </Button>
      ))}
    </Space>
  );
}
function cell(title: string, row: Row) {
  if (['人员', '姓名'].includes(title)) return <span className="entry-link">{row.name ?? '--'}</span>;
  if (['计划入职日期', '入职日期', '原定入职日期'].includes(title))
    return <span className="entry-link">{row.effectiveDate ?? '--'}</span>;
  if (['待入职部门', '部门'].includes(title))
    return <NameOf path={refPaths.departmentId} id={row.departmentId} asOf={row.effectiveDate} />;
  if (title === '入职类型') return row.kind ? (m.kind[row.kind as keyof typeof m.kind] ?? '--') : '--';
  if (title === '入职状态')
    return row.entryStatus === null || row.entryStatus === undefined ? '--' : ENTRY_STATUS_LABELS[row.entryStatus];
  if (title === '当前状态')
    return row.employeeStatus === null || row.employeeStatus === undefined
      ? '--'
      : EMPLOYEE_STATUS_LABELS[row.employeeStatus];
  return '--';
}
function RowActions({ row, view, open }: { row: Row; view: View; open(): void }) {
  const p = useEntryAccess();
  if (view === 'hired') return null;
  return (
    <Space size={0}>
      <Tooltip title={m.pending}>
        <Button type="link" disabled>
          {m.edit}
        </Button>
      </Tooltip>
      {view !== 'cancelled' && (
        <>
          <Button type="link" disabled>
            {m.application}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                ...(p.edit && row.entryStatus !== 1 && validObject(row) && row.employeeId
                  ? [{ key: 'complete', label: m.complete, onClick: open }]
                  : []),
                { key: 'sign', label: m.sign, disabled: true },
              ],
            }}
          >
            <Button type="link" aria-label={m.more}>
              ▾
            </Button>
          </Dropdown>
        </>
      )}
    </Space>
  );
}
