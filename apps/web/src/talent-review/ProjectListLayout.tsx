import { Button, Empty, Pagination, Space, Table, Tabs } from 'antd';
import { useState, type ComponentProps, type Key } from 'react';
import type { ListPage } from '../foundation/templates.js';
import { PageState } from '../foundation/PageState.js';
import { MenuIcon } from '../foundation/ViewHeading.js';
import { ui } from '../foundation/messages.js';
import type { ReviewRecord } from './types.js';
import { tr } from './messages.js';

/** 项目专用容器：并列视图、仅选择不提供批量命令，保持其他配置页的公共列表行为。 */
export function ProjectListLayout(props: ComponentProps<typeof ListPage<ReviewRecord>>) {
  const { view, data, columns, page, onPageChange, loading, error, retry } = props;
  const [selection, setSelection] = useState<{ view?: string; page: number; keys: Key[] }>({ page: 1, keys: [] });
  const keys =
    selection.view === view?.value && selection.page === page.page
      ? selection.keys.filter((key) => data.items.some((row) => row.id === key))
      : [];
  return (
    <section className="list-page review-project-list">
      <header className="page-heading">
        {/* 原站项目列表无页面级 h1，以两种项目视图代替标题；带名导航同 /transfer、/approval（F-170，F-495）。 */}
        <nav className="review-project-views" aria-label={tr.projectViews}>
          <span className="page-view-icon">
            <MenuIcon />
          </span>
          <Tabs
            activeKey={view?.value}
            items={view?.options}
            onChange={(value) => {
              setSelection({ page: 1, keys: [] });
              view?.onChange(value);
            }}
          />
        </nav>
        <Space>
          {props.actions}
          <Button type="primary" disabled title={tr.unverified}>
            {tr.createWizard}
          </Button>
        </Space>
      </header>
      <div className="list-card">
        <div className="page-filters" aria-label={ui.filter}>
          {props.filters}
        </div>
        {error ? (
          <PageState kind="error" error={error} retry={retry} />
        ) : (
          <>
            <Table<ReviewRecord>
              rowKey="id"
              loading={loading}
              columns={columns}
              dataSource={data.items}
              pagination={false}
              scroll={{ x: 'max-content' }}
              rowSelection={{
                columnWidth: 30,
                selectedRowKeys: keys,
                onChange: (keys) => setSelection({ view: view?.value, page: page.page, keys }),
              }}
              locale={{ emptyText: <Empty description={data.hasDataPermission === false ? ui.noScope : ui.empty} /> }}
            />
            <div className="page-toolbar">
              <span className="page-total">
                {keys.length > 0 && `${tr.selectedCount(keys.length)}，`}
                {ui.totalRows(data.total ?? 0)}
              </span>
              <Space>
                <span>{tr.pageCount(Math.max(1, Math.ceil((data.total ?? 0) / page.pageSize)))}</span>
                <Pagination
                  current={page.page}
                  pageSize={page.pageSize}
                  total={data.total}
                  showSizeChanger={false}
                  onChange={(next) => {
                    setSelection({ page: next, keys: [] });
                    onPageChange({ ...page, page: next });
                  }}
                />
                <span>{`${page.pageSize}${ui.perPage}`}</span>
              </Space>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
