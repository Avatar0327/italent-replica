import { Button, type TableColumnsType } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import type { PageResult } from '../foundation/client.js';
import { display, filterProjects, matchesFilters, type ReviewFilters } from './model.js';
import { tr } from './messages.js';
import { ProjectListLayout } from './ProjectListLayout.js';
import { ProjectFilters } from './ProjectFilters.js';
import { objects, type ReviewRecord } from './types.js';

interface ReviewListProps {
  data: PageResult<ReviewRecord>;
  loading: boolean;
  error?: unknown;
  retry(): void;
  open(row: ReviewRecord): void;
  actions: ReactNode;
  rowActions(row: ReviewRecord): ReactNode;
}
export function ReviewList(props: ReviewListProps) {
  const { data, loading, error, retry, open, actions, rowActions } = props;
  const permission = usePermissions(objects.projects);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [view, setView] = useState('active');
  const [filters, setFilters] = useState<ReviewFilters>({});
  const visible = (key: string) => permission.field(key).visible;
  const changeFilters = (value: ReviewFilters) => {
    setFilters(value);
    setPage({ ...page, page: 1 });
  };
  const actualView = permission.field('status').visible ? view : 'all';
  const rows = filterProjects(data.items, actualView, '').filter((row) => matchesFilters(row, filters, visible));
  const pageNumber = Math.min(page.page, Math.max(1, Math.ceil(rows.length / page.pageSize)));
  const effectivePage = { ...page, page: pageNumber };
  useEffect(() => {
    // 刷新中的空数组不是最终结果；只在读取完成后记住校正页码，避免错误退回首页。
    if (!loading && !error)
      setPage((current) => (current.page === pageNumber ? current : { ...current, page: pageNumber }));
  }, [pageNumber, loading, error]);
  return (
    <ProjectListLayout
      title={tr.projects}
      data={{
        ...data,
        items: rows.slice(
          (effectivePage.page - 1) * effectivePage.pageSize,
          effectivePage.page * effectivePage.pageSize,
        ),
        total: rows.length,
      }}
      page={effectivePage}
      onPageChange={setPage}
      rowKey="id"
      columns={listColumns(actualView, permission, open, rowActions)}
      loading={loading}
      error={error}
      retry={retry}
      view={{
        value: actualView,
        options: [
          { key: 'active', label: tr.active },
          { key: 'ended', label: tr.ended },
          { key: 'all', label: tr.all },
        ].filter((option) => (permission.field('status').visible ? option.key !== 'all' : option.key === 'all')),
        onChange: (value) => {
          setView(value);
          setPage({ ...page, page: 1 });
        },
      }}
      actions={actions}
      filters={<ProjectFilters value={filters} change={changeFilters} visible={visible} />}
    />
  );
}

function listColumns(
  actualView: string,
  permission: ReturnType<typeof usePermissions>,
  open: (row: ReviewRecord) => void,
  rowActions: (row: ReviewRecord) => ReactNode,
): TableColumnsType<ReviewRecord> {
  const keys = [
    'name',
    'categoryId',
    'scene',
    'ownerOrgId',
    ...(actualView === 'ended' ? ['sharedOrgIds', 'population'] : []),
    'report',
    'periodStartDate',
    'periodEndDate',
    'year',
    'calcRuleId',
    'status',
    ...(actualView === 'ended' ? ['application'] : ['resultFlow']),
  ];
  const presentationOnly = ['scene', 'report', 'resultFlow', 'population', 'application'];
  const columns: TableColumnsType<ReviewRecord> = keys
    .filter((key) => presentationOnly.includes(key) || permission.field(key).visible)
    .map((key) => ({
      title: key === 'name' && actualView === 'ended' ? tr.projectName : tr.fields[key as keyof typeof tr.fields],
      dataIndex: key,
      width: key.endsWith('Date') ? 93 : 128,
      ellipsis: true,
      render: (value: unknown, record: ReviewRecord) => {
        if (key === 'name')
          return (
            <Button type="link" onClick={() => open(record)}>
              {display(value)}
            </Button>
          );
        if (key === 'status') return tr.states[value as keyof typeof tr.states] ?? tr.missing;
        return presentationOnly.includes(key) ? tr.missing : display(value);
      },
    }));
  columns.push({
    title: tr.actions,
    key: 'actions',
    width: 160,
    render: (_, row) => rowActions(row),
  });
  columns.push({
    title: (
      <Button type="text" disabled aria-label={tr.columnSettings}>
        ⚙
      </Button>
    ),
    key: 'settings',
    width: 24,
    render: () => null,
  });
  return columns;
}
