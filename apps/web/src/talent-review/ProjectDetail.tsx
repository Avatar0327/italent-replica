import { Alert, Button, Space, Table, Tabs } from 'antd';
import type { ReactNode } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { display } from './model.js';
import { tr } from './messages.js';
import { objects, type ReviewRecord } from './types.js';

export function ProjectDetail({
  record,
  actions,
  onClose,
}: {
  record: ReviewRecord;
  actions: ReactNode;
  onClose(): void;
}) {
  const permission = usePermissions(objects.projects);
  const title = permission.field('name').visible ? display(record.name) : tr.missing;
  const standard = permission.field('criterionId').visible ? display(record.criterionId) : tr.missing;
  return (
    <section className="review-project-detail" aria-label={title}>
      <header className="page-heading">
        <h1>{title}</h1>
        <Space>
          <Button onClick={onClose}>{tr.back}</Button>
          {actions}
        </Space>
      </header>
      <div className="review-board-heading">
        <Button type="link" disabled title={tr.unverified}>
          {tr.collapseBoard}
        </Button>
      </div>
      <div className="review-summary">
        {[tr.progress, tr.fields.scene, tr.fields.criterionId, tr.dimension].map((label, index) => (
          <div key={label}>
            <span className={`review-summary-icon tone-${index}`}>{['▤', '◇', '♧', '⌘'][index]}</span>
            <div>
              <strong>{index === 0 ? tr.progress : index === 2 ? standard : tr.missing}</strong>
              <p>{index === 0 ? tr.progressHint : label}</p>
            </div>
            {index !== 1 && (
              <Button type="link" disabled title={tr.unavailable}>
                {tr.view}
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="list-card">
        <Tabs
          items={tr.tabs.map((label, index) => ({
            key: String(index),
            label,
            children: <ProjectPanel index={index} />,
          }))}
        />
      </div>
    </section>
  );
}

/** 执行子资源尚无后端契约；保留已取证结构，但不以空数组或合成值冒充真实盘点结果。 */
function ProjectPanel({ index }: { index: number }) {
  const panel = tr.projectPanels[index]!;
  const columns = 'columns' in panel ? panel.columns : undefined;
  return (
    <section className="review-project-panel">
      {'note' in panel && <p className="review-panel-note">{panel.note}</p>}
      <div className="review-panel-toolbar">
        <Space wrap>
          {panel.filters.map((label) => (
            <Button key={label} type="text" disabled>
              {label} ▾
            </Button>
          ))}
        </Space>
        <Space wrap>
          {panel.actions.map((label) => (
            <Button key={label} type="primary" disabled>
              {label}
            </Button>
          ))}
        </Space>
      </div>
      <Alert type="info" showIcon message={tr.unavailable} description={tr.executionUnavailable} />
      {columns && (
        <Table
          rowKey="id"
          pagination={false}
          dataSource={[]}
          scroll={{ x: 'max-content' }}
          rowSelection={index === 2 ? undefined : { columnWidth: 30, hideSelectAll: true }}
          columns={[
            ...columns.map((title) => ({ title, key: title, width: 128, ellipsis: true })),
            {
              title: (
                <Button type="text" disabled aria-label={tr.columnSettings}>
                  ⚙
                </Button>
              ),
              key: 'settings',
              width: 24,
            },
          ]}
          locale={{ emptyText: tr.unavailable }}
        />
      )}
      {index === 6 && (
        <div className="review-dashboard-sections">
          {tr.dashboardSections.map((title) => (
            <section key={title}>
              <h3>{title}</h3>
              <p>{tr.unavailable}</p>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
