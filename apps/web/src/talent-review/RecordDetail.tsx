import { Alert, Collapse, Descriptions, Empty, Table, Tag } from 'antd';
import type { ReactNode } from 'react';
import { DetailPage } from '../foundation/templates.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { DemoPanel } from './DemoPanels.js';
import { display } from './model.js';
import { tr } from './messages.js';
import { objects, type Collection, type ReviewRecord } from './types.js';

export function RecordDetail({
  collection,
  record,
  actions,
  onClose,
}: {
  collection: Collection;
  record: ReviewRecord;
  actions: ReactNode;
  onClose(): void;
}) {
  const permission = usePermissions(objects[collection]);
  const summary = <RecordSummary collection={collection} record={record} />;
  const tabs = detailTabs(collection, record);
  return (
    <DetailPage
      open
      title={permission.field('name').visible ? display(record.name) : tr.missing}
      onClose={onClose}
      actions={actions}
      summary={summary}
      tabs={tabs}
      sections={
        collection === 'matrices'
          ? [{ key: 'matrix', title: tr.matrices, children: <MatrixPreview record={record} /> }]
          : collection === 'templates'
            ? [{ key: 'notice', title: tr.settings, children: <Alert message={tr.templateNote} type="info" /> }]
            : []
      }
    />
  );
}
function StructureTable({
  record,
  field,
  columns,
}: {
  record: ReviewRecord;
  field: string;
  columns: [string, string][];
}) {
  const permission = usePermissions(objects.templates);
  if (!permission.field(field).visible) return null;
  const rows = (record[field] ?? []) as Record<string, unknown>[];
  return (
    <Table
      rowKey={(row) => String(row.id ?? JSON.stringify([row.nodeKey, row.roleId, row.moduleName]))}
      pagination={false}
      dataSource={rows}
      columns={columns.map(([dataIndex, title]) => ({
        dataIndex,
        title,
        render: (value: unknown) => (tr.values as Record<string, string>)[String(value)] ?? display(value),
      }))}
      locale={{ emptyText: tr.empty }}
    />
  );
}
function MatrixPreview({ record }: { record: ReviewRecord }) {
  const permission = usePermissions(objects.matrices);
  if (!permission.field('cells').visible) return null;
  const cells = (record.cells ?? []) as { cellNo: number; xLevelNo: number; yLevelNo: number; name: string }[];
  if (!cells.length) return <Empty description={tr.noCells} />;
  // 服务端 checkCells 保证从 1 连续铺满全部轴段；直接使用已授权格子的坐标，不假定三档。
  const xLevels = Math.max(...cells.map((cell) => cell.xLevelNo));
  const yLevels = Math.max(...cells.map((cell) => cell.yLevelNo));
  return (
    <>
      <Alert message={tr.gridNote} type="info" />
      <div
        className="review-grid"
        style={{ gridTemplateColumns: `repeat(${xLevels}, 1fr)`, gridTemplateRows: `repeat(${yLevels}, auto)` }}
      >
        {[...cells]
          .sort((a, b) => b.yLevelNo - a.yLevelNo || a.xLevelNo - b.xLevelNo)
          .map((cell) => (
            <div
              className="review-cell blue"
              key={cell.cellNo}
              style={{ gridColumn: cell.xLevelNo, gridRow: yLevels - cell.yLevelNo + 1 }}
            >
              <strong>{cell.name}</strong>
            </div>
          ))}
      </div>
    </>
  );
}

function RecordSummary({ collection, record }: { collection: Collection; record: ReviewRecord }) {
  const permission = usePermissions(objects[collection]);
  const fields = (
    collection === 'projects'
      ? [
          'code',
          'ownerOrgId',
          'year',
          'period',
          'periodStartDate',
          'periodEndDate',
          'categoryId',
          'calcRuleId',
          'criterionId',
          'downwardPublic',
          'sharedOrgIds',
        ]
      : ['ownerOrgId', 'flowId', 'enabled', 'currentVersionNo']
  ).filter((key) => permission.field(key).visible);
  const summary = (
    <>
      <DecisionNote id={`talent-review-${collection}`} />
      {record.accessLevel === 'readonly' && <Tag>{tr.readonly}</Tag>}
      <Collapse
        ghost
        items={[
          {
            key: 'config',
            label: tr.settings,
            children: (
              <Descriptions
                size="small"
                column={3}
                items={fields.map((key) => ({
                  key,
                  label: tr.fields[key as keyof typeof tr.fields],
                  children:
                    key === 'enabled' && typeof record[key] === 'boolean'
                      ? [tr.disabled, tr.enabled][Number(record[key])]
                      : display(record[key]),
                }))}
              />
            ),
          },
        ]}
      />
      {collection === 'projects' && (
        <div className="review-summary">
          {[tr.progress, tr.fields.scene, tr.fields.criterionId, tr.dimension].map((label, i) => (
            <div key={label}>
              <span className={`review-summary-icon tone-${i}`}>{['▤', '◇', '♧', '⌘'][i]}</span>
              <div>
                <strong>{i === 0 ? tr.progress : tr.missing}</strong>
                <p>{i === 0 ? tr.progressHint : label}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
  return summary;
}
function detailTabs(collection: Collection, record: ReviewRecord) {
  let tabs;
  if (collection === 'projects')
    tabs = tr.tabs.map((label, index) => ({ key: String(index), label, children: <DemoPanel tab={index} /> }));
  if (collection === 'templates')
    tabs = [
      {
        key: 'steps',
        label: tr.steps,
        children: (
          <StructureTable
            record={record}
            field="steps"
            columns={[
              ['name', tr.fields.name],
              ['stepType', tr.type],
              ['mode', tr.node],
            ]}
          />
        ),
      },
      {
        key: 'modules',
        label: tr.modules,
        children: (
          <StructureTable
            record={record}
            field="modules"
            columns={[
              ['name', tr.fields.name],
              ['kind', tr.type],
              ['scoring', tr.column.score],
            ]}
          />
        ),
      },
      {
        key: 'permissions',
        label: tr.permissions,
        children: (
          <StructureTable
            record={record}
            field="permissions"
            columns={[
              ['nodeKey', tr.node],
              ['moduleName', tr.module],
              ['visible', tr.visible],
              ['weight', tr.weight],
            ]}
          />
        ),
      },
    ];
  return tabs;
}
