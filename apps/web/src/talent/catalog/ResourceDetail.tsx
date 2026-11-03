import { Alert, Button, Descriptions, Empty, Table, Tabs, Checkbox, Space } from 'antd';
import { DetailPage } from '../../foundation/templates.js';
import { PageState } from '../../foundation/PageState.js';
import type { ObjectPermission } from '../../foundation/permission-model.js';
import { fieldAccess, canButton } from '../../foundation/permission-model.js';
import { CatalogDetail } from './CatalogDetail.js';
import { fullPageDetail } from './alignment.js';
import { StandardCells } from './StandardCells.js';
export { StandardCells } from './StandardCells.js';
import { resourcePath } from './api.js';
import { useRemote, useReferenceNames } from './hooks.js';
import { m } from './messages.js';
import type { Resource, Row } from './types.js';

export function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return m.unknown;
  if (typeof value === 'boolean') return value ? m.enabled : m.disabled;
  if (typeof value === 'string') return m.typeOptions.find((option) => option.value === value)?.label ?? value;
  if (typeof value === 'number') return String(value);
  return m.unknown;
}
const array = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : []);
const columns = (fields: [string, string][]) =>
  fields.map(([dataIndex, title]) => ({ title, dataIndex, render: display }));
function MoreDetails({ row, resource, names }: { row: Row; resource: Resource; names?: Map<string, string> }) {
  if (resource.module === 'qualification' && resource.key === 'standards') {
    const levels = Array.isArray(row.levelIds) ? (row.levelIds as string[]) : [];
    return (
      <>
        <Alert type="info" message={m.readOnlyDetail} />
        <Tabs
          tabPosition="left"
          items={levels.map((id) => ({
            key: id,
            label: names?.get(id) ?? `${m.level} · ${id}`,
            children: <StandardCells cells={array(row.details).filter((cell) => cell.levelId === id)} names={names} />,
          }))}
        />
        {!levels.length && <Empty />}
      </>
    );
  }
  if (resource.key === 'criteria') return <CriterionDetails row={row} />;
  if (resource.key === 'dimensions') return <DimensionDetails row={row} />;
  return null;
}
export function ResourceDetail({
  resource,
  id,
  permission,
  onClose,
  onEdit,
}: {
  resource: Resource;
  id: string;
  permission: ObjectPermission;
  onClose(): void;
  onEdit?(): void;
}) {
  const state = useRemote(`detail:${resource.object}:${id}`, (api, signal) =>
    api.request<Row>(`${resourcePath(resource)}/${id}`, { signal }),
  );
  const row = state.data;
  const names = useReferenceNames(resource, 0, permission);
  const Container = fullPageDetail(resource) ? CatalogDetail : DetailPage;
  return (
    <Container
      open
      onClose={onClose}
      title={row && fieldAccess(permission, 'name').visible ? (row.name ?? resource.title) : resource.title}
      actions={
        fullPageDetail(resource) ? (
          <Space>
            {resource.key === 'standards' && onEdit && canButton(permission, 'update', 'detail') && (
              <Button onClick={onEdit}>{m.editBasic}</Button>
            )}
            <Button disabled>{resource.key === 'criteria' ? m.setAssessment : m.viewGraph}</Button>
          </Space>
        ) : (
          <Button onClick={onClose}>{m.close}</Button>
        )
      }
      summary={
        state.error ? (
          <PageState kind="error" error={state.error} />
        ) : !row ? (
          <PageState kind="loading" />
        ) : (
          <Descriptions
            column={2}
            items={resource.fields
              .filter(
                (field) =>
                  fieldAccess(permission, field.key).visible &&
                  Object.hasOwn(row, field.key) &&
                  !Array.isArray(row[field.key]),
              )
              .map((field) => ({
                key: field.key,
                label: field.label,
                children: display(
                  typeof row[field.key] === 'string'
                    ? (names.data?.get(String(row[field.key])) ?? row[field.key])
                    : row[field.key],
                ),
              }))}
          />
        )
      }
      sections={
        row
          ? [
              {
                key: 'detail',
                title: m.standardDetails,
                children: <MoreDetails row={row} resource={resource} names={names.data} />,
              },
            ]
          : []
      }
    />
  );
}

function CriterionDetails({ row }: { row: Row }) {
  return (
    <Tabs
      items={(['ability', 'potential', 'experience', 'achievement'] as const).map((type) => {
        const data = array(row.dimensions)
          .filter((item) => item.type === type)
          .map((item) => ({ ...((item.dimension as object | undefined) ?? {}), ...item }));
        return {
          key: type,
          label: m[type],
          children: (
            <>
              <Alert type="info" message={display(row[`${type}Note`])} />
              {type === 'potential' && (
                <section className="catalog-overview">
                  <h2>{m.potentialOverview}</h2>
                  <Button disabled>{m.modelSettings}</Button>
                </section>
              )}
              {type === 'ability' && data.length > 0 && (
                <div className="catalog-overview">
                  <h2>{m.abilityOverview}</h2>
                  {data.map((item) => (
                    <article key={String(item.dimensionId)}>
                      <h3>{display(item.name)}</h3>
                      <p>{display(item.definition)}</p>
                      <span>
                        {m.weight}：{display(item.weight)}
                      </span>
                    </article>
                  ))}
                </div>
              )}
              {type !== 'achievement' && (
                <section className="catalog-indicators">
                  <h2>{m[type]}</h2>
                  <Space className="catalog-detail-toolbar">
                    {(type === 'ability'
                      ? [m.chooseIndicators, m.setIndicatorCategory, m.export]
                      : [m.batchChoose]
                    ).map((label) => (
                      <Button key={label} disabled>
                        {label}
                      </Button>
                    ))}
                  </Space>
                  <Table
                    rowKey="dimensionId"
                    size="small"
                    pagination={false}
                    dataSource={data}
                    locale={{ emptyText: <Empty description={m.empty} /> }}
                    scroll={{ x: 'max-content' }}
                    columns={criterionColumns(type)}
                  />
                </section>
              )}
            </>
          ),
        };
      })}
    />
  );
}

function criterionColumns(type: string) {
  return [
    {
      key: 'selection',
      width: 30,
      title: <Checkbox disabled aria-label={m.selectAll} />,
      render: () => <Checkbox disabled aria-label={m.selectRow} />,
    },
    ...columns([
      ['name', m.indicatorName],
      [
        type === 'experience' ? 'dimensionCategory' : 'definition',
        type === 'experience' ? m.experienceCategory : m.indicatorDefinition,
      ],
      ...(type === 'ability'
        ? ([
            ['dimensionCategory', m.indicatorCategory],
            ['target', m.goal],
            ['weight', m.weight],
          ] as [string, string][])
        : []),
    ]).map((column) => ({
      ...column,
      width: type === 'ability' ? 196 : 495,
      render: (value: unknown) =>
        typeof value === 'number' && ['target', 'weight'].includes(column.dataIndex)
          ? value.toFixed(1)
          : display(value),
    })),
    {
      key: 'actions',
      title: m.actions,
      width: 160,
      render: () => (
        <Space>
          {type === 'ability' && (
            <Button type="link" disabled>
              {m.edit}
            </Button>
          )}
          {type !== 'experience' && (
            <Button type="link" disabled>
              {m.delete}
            </Button>
          )}
        </Space>
      ),
    },
  ];
}

function DimensionDetails({ row }: { row: Row }) {
  return (
    <Tabs
      items={[
        {
          key: 'grades',
          label: m.grade,
          fields: [
            ['gradeOrder', m.order],
            ['alias', m.name],
            ['description', m.description],
          ],
        },
        {
          key: 'behaviors',
          label: m.behavior,
          fields: [
            ['description', m.description],
            ['keyPoints', m.content],
          ],
        },
        {
          key: 'suggestions',
          label: m.suggestion,
          fields: [
            ['typeName', m.type],
            ['description', m.description],
          ],
        },
        {
          key: 'questions',
          label: m.question,
          fields: [
            ['question', m.question],
            ['keyPoints', m.content],
          ],
        },
      ]
        .filter((tab) => Object.hasOwn(row, tab.key))
        .map((tab) => ({
          key: tab.key,
          label: tab.label,
          children: (
            <Table
              rowKey={(_, index) => String(index)}
              size="small"
              pagination={false}
              dataSource={array(row[tab.key])}
              columns={columns(tab.fields as [string, string][])}
            />
          ),
        }))}
    />
  );
}
