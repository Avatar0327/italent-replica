import { Alert, Button, Empty, Input, Space, Table, Tooltip } from 'antd';
import { useState } from 'react';
import { DecisionNote } from '../foundation/index.js';
import { centerText as c } from './messages.js';
import { gapPages, type GapPage, type GapView } from './page-model.js';

/**
 * 我的委托、流程管理、管理员委托：原站页面结构（视图、工具栏、提示、筛选、列序）照搬，
 * 接口待补齐，表格为空、按钮禁用，不伪造数据（后端缺口清单）。
 */
export function GapSectionPage({ page }: { page: keyof typeof gapPages }) {
  const config = gapPages[page];
  const [viewKey, setViewKey] = useState(config.views[0]!.key);
  const view = config.views.find((item) => item.key === viewKey) ?? config.views[0]!;
  return (
    <div className="approval-gap-page">
      <GapHeading config={config} view={view} onChange={setViewKey} />
      <DecisionNote id="approval-gap" />
      <GapBanner key={view.key} lines={view.banner} />
      <Alert showIcon type="warning" message={c.gap} />
      <div className="list-card">
        {config.filters.length > 0 && (
          <Space wrap className="approval-gap-filters">
            {config.filters.map((label) => (
              <Input key={label} disabled aria-label={label} placeholder={label} />
            ))}
            <Button disabled>{c.advanced}</Button>
            <Button disabled type="text">
              {c.clear}
            </Button>
          </Space>
        )}
        <Table
          size="small"
          rowKey="key"
          dataSource={[]}
          rowSelection={
            view.selectable ? { selectedRowKeys: [], getCheckboxProps: () => ({ disabled: true }) } : undefined
          }
          columns={view.columns.map((title, index) => ({ key: `${index}`, title }))}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={c.empty} /> }}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      </div>
    </div>
  );
}
/** 原站：标题位为横向视图（流程管理只有一个视图，显示为标题），工具栏在右上，均无接口故禁用。 */
function GapHeading({ config, view, onChange }: { config: GapPage; view: GapView; onChange(key: string): void }) {
  return (
    <header className="approval-gap-head">
      <nav className="approval-views" aria-label={config.title}>
        {config.views.map((item) => (
          <Button
            key={item.key}
            type="text"
            aria-pressed={item.key === view.key}
            className={item.key === view.key ? 'approval-view approval-view-active' : 'approval-view'}
            onClick={() => onChange(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      <Space wrap>
        {view.tools.map((tool) => (
          <Tooltip key={tool} title={c.pendingTool}>
            <Button disabled>{tool}</Button>
          </Tooltip>
        ))}
      </Space>
    </header>
  );
}
function GapBanner({ lines }: { lines: readonly string[] }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <Alert
      type="info"
      closable={{ closeIcon: c.closeMark, 'aria-label': c.closeBanner }}
      onClose={() => setOpen(false)}
      message={
        <div className="approval-banner">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <Button type="link" disabled>
            {c.learnMore}
          </Button>
        </div>
      }
    />
  );
}
