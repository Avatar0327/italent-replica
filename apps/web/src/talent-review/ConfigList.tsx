import { Button, Empty, Pagination, Space, Table, type TableColumnsType, type TableProps } from 'antd';
import { useEffect, useState, type Key, type ReactNode } from 'react';
import { PageState } from '../foundation/PageState.js';
import { ui } from '../foundation/messages.js';
import { tr } from './messages.js';
import type { ReviewRecord } from './types.js';

interface ConfigListProps {
  className: string;
  title: string;
  actions: ReactNode;
  filters?: ReactNode;
  columns: TableColumnsType<ReviewRecord>;
  /** 已按筛选过滤的完整集合；本组件只负责分页。 */
  rows: ReviewRecord[];
  loading: boolean;
  error?: unknown;
  retry(): void;
  hasDataPermission?: boolean;
  selectable?: boolean;
  /** 原站模板列表只有一页时不显示页码（R3cd spec §3.3）。 */
  hideOnSinglePage?: boolean;
}

/** 盘点配置列表（模板 / 计算规则）：与项目列表同一套容器与底栏，复选只选不提供批量命令。 */
export function ConfigList(props: ConfigListProps) {
  const { rows, loading, error, selectable, hideOnSinglePage } = props;
  const pageSize = 15;
  const [page, setPage] = useState(1);
  const [keys, setKeys] = useState<Key[]>([]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  useEffect(() => {
    // 刷新中的空数组不是最终结果；只在读取完成后记住校正页码。
    if (!loading && !error && page !== current) setPage(current);
  }, [page, current, loading, error]);
  const [sort, setSort] = useState<{ key?: Key; order?: 'ascend' | 'descend' | null }>({});
  // 排序作用于全部筛选结果再分页，不只排当前页（表格本身不分页）。
  const columns = props.columns.map((column) =>
    column.sorter ? { ...column, sortOrder: sort.key === column.key ? sort.order : null } : column,
  );
  const compare = props.columns.find((column) => column.key === sort.key && sort.order)?.sorter;
  const sorted =
    typeof compare === 'function'
      ? [...rows].sort((a, b) => (sort.order === 'descend' ? -1 : 1) * compare(a, b))
      : rows;
  const onChange: TableProps<ReviewRecord>['onChange'] = (_, __, sorter) => {
    const single = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort({ key: single?.columnKey, order: single?.order });
  };
  const shown = sorted.slice((current - 1) * pageSize, current * pageSize);
  const selected = keys.filter((key) => shown.some((row) => row.id === key));
  return (
    <section className={`list-page review-config-list ${props.className}`}>
      <header className="page-heading">
        <h1>{props.title}</h1>
        <Space>{props.actions}</Space>
      </header>
      <div className="list-card">
        {props.filters && (
          <div className="page-filters" aria-label={ui.filter}>
            {props.filters}
          </div>
        )}
        {error ? (
          <PageState kind="error" error={error} retry={props.retry} />
        ) : (
          <>
            <Table<ReviewRecord>
              rowKey="id"
              loading={loading}
              columns={columns}
              dataSource={shown}
              onChange={onChange}
              pagination={false}
              scroll={{ x: 'max-content' }}
              rowSelection={selectable ? { columnWidth: 30, selectedRowKeys: selected, onChange: setKeys } : undefined}
              locale={{ emptyText: <Empty description={props.hasDataPermission === false ? ui.noScope : ui.empty} /> }}
            />
            <div className="page-toolbar">
              <span className="page-total">
                {selected.length > 0 && `${tr.selectedCount(selected.length)}，`}
                {ui.totalRows(rows.length)}
              </span>
              {!(hideOnSinglePage && pages === 1) && (
                <Space>
                  <span>{tr.pageCount(pages)}</span>
                  <Pagination
                    current={current}
                    pageSize={pageSize}
                    total={rows.length}
                    showSizeChanger={false}
                    onChange={(next) => {
                      setKeys([]);
                      setPage(next);
                    }}
                  />
                  <span>{`${pageSize}${ui.perPage}`}</span>
                </Space>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** 列表时间列：租户时区 YYYY-MM-DD HH:mm:ss（DEC-056），不用浏览器时区。 */
export function dateTime(value: unknown, timezone: string | undefined) {
  const instant = typeof value === 'string' ? new Date(value) : undefined;
  if (!instant || !timezone || Number.isNaN(instant.getTime())) return tr.missing;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
/** 列设置齿轮：原站有入口，复刻未取证，禁用。 */
export const settingsColumn = (width: number) => ({
  title: (
    <Button type="text" disabled aria-label={tr.columnSettings}>
      ⚙
    </Button>
  ),
  key: 'settings',
  width,
  render: () => null,
});
