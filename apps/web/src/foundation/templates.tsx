import {
  Button,
  Empty,
  Pagination,
  Select,
  Space,
  Table,
  Tabs,
  Tooltip,
  type TableColumnsType,
  type TabsProps,
} from 'antd';
import type { Key, ReactNode } from 'react';
import type { PageRequest, PageResult } from './client.js';
import { ListViewTitle } from './ListViews.js';
import { ui } from './messages.js';
import { PageState } from './PageState.js';

interface ListPageProps<T extends object> {
  title: string;
  data: PageResult<T>;
  columns: TableColumnsType<T>;
  rowKey: string | ((row: T) => string);
  page: PageRequest;
  onPageChange(page: PageRequest): void;
  filters?: ReactNode;
  actions?: ReactNode;
  loading?: boolean;
  error?: unknown;
  retry?: () => void;
  selection?: { keys: Key[]; onChange(keys: Key[], rows: T[]): void; actions: ReactNode };
}
export function ListPage<T extends object>(props: ListPageProps<T>) {
  const { title, data, columns, rowKey, page, onPageChange, filters, actions, loading, error, retry, selection } =
    props;
  const changePage = (next: PageRequest) => {
    selection?.onChange([], []);
    onPageChange(next);
  };
  return (
    <section>
      <header className="page-heading">
        <ListViewTitle title={title} />
        <Space>
          {actions}
          <Tooltip title={ui.exportPending}>
            <Button disabled>{ui.export}</Button>
          </Tooltip>
        </Space>
      </header>
      {filters && (
        <div className="page-filters" aria-label={ui.filter}>
          {filters}
        </div>
      )}
      {error ? (
        <PageState kind="error" error={error} retry={retry} />
      ) : (
        <>
          {selection && (
            <div className="page-toolbar">
              <Space>
                <span>
                  {ui.selected} {selection.keys.length} {ui.count}
                </span>
                <Button type="link" onClick={() => selection.onChange([], [])}>
                  {ui.clear}
                </Button>
              </Space>
              {selection.keys.length > 0 && selection.actions}
            </div>
          )}
          <Table<T>
            columns={columns}
            dataSource={data.items}
            rowKey={rowKey}
            loading={loading}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: <Empty description={data.hasDataPermission === false ? ui.noScope : ui.empty} /> }}
            rowSelection={selection ? { selectedRowKeys: selection.keys, onChange: selection.onChange } : undefined}
          />
          <div className="page-toolbar">
            <ListPagination data={data} page={page} changePage={changePage} loading={loading} />
          </div>
        </>
      )}
    </section>
  );
}
export interface DetailSection {
  key: string;
  title: string;
  children: ReactNode;
}
export function DetailPage({
  title,
  summary,
  actions,
  tabs,
  sections = [],
}: {
  title: string;
  summary?: ReactNode;
  actions?: ReactNode;
  tabs?: TabsProps['items'];
  sections?: DetailSection[];
}) {
  return (
    <section>
      <header className="page-heading">
        <h1>{title}</h1>
        <Space>{actions}</Space>
      </header>
      {summary}
      {tabs && <Tabs items={tabs} />}
      {sections.map((section) => (
        <section key={section.key} className="detail-section">
          <h2>{section.title}</h2>
          {section.children}
        </section>
      ))}
    </section>
  );
}

function ListPagination({
  data,
  page,
  changePage,
  loading,
}: {
  data: Pick<PageResult<unknown>, 'total' | 'hasMore'>;
  page: PageRequest;
  changePage(page: PageRequest): void;
  loading?: boolean;
}) {
  return (
    <>
      {' '}
      {data.total !== undefined ? (
        <Pagination
          current={page.page}
          pageSize={page.pageSize}
          total={data.total}
          showSizeChanger
          pageSizeOptions={[15, 20, 30, 50, 100, 200]}
          onChange={(next, size) => changePage({ page: size === page.pageSize ? next : 1, pageSize: size })}
        />
      ) : (
        <Space className="list-pagination">
          <Select
            aria-label={ui.pageSize}
            size="small"
            value={page.pageSize}
            options={[...new Set([15, 30, 50, page.pageSize])]
              .sort((a, b) => a - b)
              .map((value) => ({ value, label: `${value}${ui.perPage}` }))}
            onChange={(pageSize) => changePage({ page: 1, pageSize })}
          />
          <Button disabled={page.page <= 1 || loading} onClick={() => changePage({ ...page, page: page.page - 1 })}>
            {ui.previous}
          </Button>
          <span>{page.page}</span>
          <Button disabled={!data.hasMore || loading} onClick={() => changePage({ ...page, page: page.page + 1 })}>
            {ui.next}
          </Button>
        </Space>
      )}
    </>
  );
}
