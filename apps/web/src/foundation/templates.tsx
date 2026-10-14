import {
  Button,
  Drawer,
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
import { ui } from './messages.js';
import { PageState } from './PageState.js';
import { ViewHeading, type ListView } from './ViewHeading.js';

interface ListPageProps<T extends object> {
  title: string;
  icon?: ReactNode;
  view?: ListView;
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
    <section className="list-page">
      <header className="page-heading">
        <ViewHeading title={title} icon={props.icon} view={props.view} />
        <Space>
          {actions}
          <Tooltip title={ui.exportPending}>
            <Button disabled>{ui.export}</Button>
          </Tooltip>
        </Space>
      </header>
      <div className="list-card">
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
      </div>
    </section>
  );
}
export interface DetailSection {
  key: string;
  title: string;
  children: ReactNode;
}
export function DetailPage({
  open,
  onClose,
  title,
  summary,
  actions,
  tabs,
  sections = [],
}: {
  open: boolean;
  onClose(): void;
  title: string;
  summary?: ReactNode;
  actions?: ReactNode;
  tabs?: TabsProps['items'];
  sections?: DetailSection[];
}) {
  return open ? (
    <Drawer
      open
      placement="right"
      closable={{ placement: 'end' }}
      width={960}
      title={title}
      onClose={onClose}
      extra={actions}
      rootClassName="detail-drawer"
    >
      {summary}
      {tabs && <Tabs items={tabs} />}
      {sections.map((section) => (
        <section key={section.key} className="detail-section">
          <h2>{section.title}</h2>
          {section.children}
        </section>
      ))}
    </Drawer>
  ) : null;
}

function ListPagination({
  data,
  page,
  changePage,
  loading,
}: {
  data: Pick<PageResult<unknown>, 'total' | 'hasMore' | 'items'>;
  page: PageRequest;
  changePage(page: PageRequest): void;
  loading?: boolean;
}) {
  // 现有后端常只返回 items/page/pageSize：满页表示可能还有下一页，不据此捏造总数。
  const hasNext = data.hasMore ?? data.items.length >= page.pageSize;
  return (
    <>
      {data.total !== undefined ? (
        <>
          <span className="page-total">{ui.totalRows(data.total)}</span>
          <Pagination
            current={page.page}
            pageSize={page.pageSize}
            total={data.total}
            showSizeChanger={{
              labelRender: ({ value }) => `${value}${ui.perPage}`,
              optionRender: ({ value }) => `${value}${ui.perPage}`,
            }}
            pageSizeOptions={[15, 20, 50, 100, 200]}
            onChange={(next, size) => changePage({ page: size === page.pageSize ? next : 1, pageSize: size })}
          />
        </>
      ) : (
        <Space className="list-pagination">
          <Select
            size="small"
            aria-label={ui.pageSize}
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
          <Button disabled={!hasNext || loading} onClick={() => changePage({ ...page, page: page.page + 1 })}>
            {ui.next}
          </Button>
        </Space>
      )}
    </>
  );
}
