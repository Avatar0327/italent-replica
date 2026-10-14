import { Button, Input, type TableColumnsType } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { ListPage } from '../foundation/templates.js';
import { usePermissions } from '../foundation/Permissions.js';
import type { PageResult } from '../foundation/client.js';
import { display, filterProjects, matchesFilters, type ReviewFilters } from './model.js';
import { tr } from './messages.js';
import { ProjectFilters } from './ProjectFilters.js';
import { objects, type Collection, type ReviewRecord } from './types.js';

interface ReviewListProps {
  collection: Collection;
  data: PageResult<ReviewRecord>;
  loading: boolean;
  error?: unknown;
  retry(): void;
  open(row: ReviewRecord): void;
  actions: ReactNode;
  rowActions(row: ReviewRecord): ReactNode;
}
export function ReviewList(props: ReviewListProps) {
  const { collection, data, loading, error, retry, open, actions, rowActions } = props;
  const permission = usePermissions(objects[collection]);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [view, setView] = useState('active');
  const [filters, setFilters] = useState<ReviewFilters>({});
  const visible = (key: string) => permission.field(key).visible;
  const changeFilters = (value: ReviewFilters) => {
    setFilters(value);
    setPage({ ...page, page: 1 });
  };
  const project = collection === 'projects';
  const actualView = permission.field('status').visible ? view : 'all';
  const rows = filterProjects(data.items, project ? actualView : 'all', '').filter((row) =>
    matchesFilters(row, filters, visible),
  );
  const pageNumber = Math.min(page.page, Math.max(1, Math.ceil(rows.length / page.pageSize)));
  const effectivePage = { ...page, page: pageNumber };
  useEffect(() => {
    // 刷新中的空数组不是最终结果；只在读取完成后记住校正页码，避免错误退回首页。
    if (!loading && !error)
      setPage((current) => (current.page === pageNumber ? current : { ...current, page: pageNumber }));
  }, [pageNumber, loading, error]);
  return (
    <>
      <ListPage
        title={tr[collection]}
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
        columns={listColumns(collection, actualView, permission, open, rowActions)}
        loading={loading}
        error={error}
        retry={retry}
        view={
          project
            ? {
                value: actualView,
                options: [
                  { key: 'active', label: tr.active },
                  { key: 'ended', label: tr.ended },
                  { key: 'all', label: tr.all },
                ].filter((option) => permission.field('status').visible || option.key === 'all'),
                onChange: (value) => {
                  setView(value);
                  setPage({ ...page, page: 1 });
                },
              }
            : undefined
        }
        actions={
          <>
            {actions}
            <Button onClick={retry}>{tr.refresh}</Button>
          </>
        }
        filters={
          project ? (
            <ProjectFilters value={filters} change={changeFilters} visible={visible} />
          ) : visible('name') ? (
            <Input.Search
              value={filters.name}
              allowClear
              placeholder={tr.search}
              aria-label={tr.search}
              onChange={(event) => changeFilters({ name: event.target.value })}
            />
          ) : undefined
        }
      />
    </>
  );
}

function listColumns(
  collection: Collection,
  actualView: string,
  permission: ReturnType<typeof usePermissions>,
  open: (row: ReviewRecord) => void,
  rowActions: (row: ReviewRecord) => ReactNode,
): TableColumnsType<ReviewRecord> {
  const project = collection === 'projects';
  const keys = project
    ? [
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
      ]
    : collection === 'templates'
      ? ['name', 'ownerOrgId', 'flowId', 'downwardPublic', 'enabled', 'currentVersionNo']
      : ['name', 'code', 'enabled'];
  const presentationOnly = ['scene', 'report', 'resultFlow', 'population', 'application'];
  const columns: TableColumnsType<ReviewRecord> = keys
    .filter((key) => presentationOnly.includes(key) || permission.field(key).visible)
    .map((key) => ({
      title: tr.fields[key as keyof typeof tr.fields],
      dataIndex: key,
      width: key === 'name' ? 190 : 130,
      ellipsis: true,
      render: (value: unknown, record: ReviewRecord) => {
        if (key === 'name')
          return (
            <Button type="link" onClick={() => open(record)}>
              {display(value)}
            </Button>
          );
        if (key === 'status') return tr.states[value as keyof typeof tr.states] ?? tr.missing;
        if (key === 'enabled' && typeof value === 'boolean') return value ? tr.enabled : tr.disabled;
        return presentationOnly.includes(key) ? tr.missing : display(value);
      },
    }));
  columns.push({ title: tr.actions, key: 'actions', fixed: 'right', width: 150, render: (_, row) => rowActions(row) });
  return columns;
}
