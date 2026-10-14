import { Alert, Button, Descriptions, Empty, Table, Tabs } from 'antd';
import { DetailPage } from '../../foundation/templates.js';
import { PageState } from '../../foundation/PageState.js';
import type { ObjectPermission } from '../../foundation/permission-model.js';
import { fieldAccess } from '../../foundation/permission-model.js';
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
}: {
  resource: Resource;
  id: string;
  permission: ObjectPermission;
  onClose(): void;
}) {
  const state = useRemote(`detail:${resource.object}:${id}`, (api, signal) =>
    api.request<Row>(`${resourcePath(resource)}/${id}`, { signal }),
  );
  const row = state.data;
  const names = useReferenceNames(resource);
  return (
    <DetailPage
      open
      onClose={onClose}
      title={row && fieldAccess(permission, 'name').visible ? (row.name ?? resource.title) : resource.title}
      actions={<Button onClick={onClose}>{m.close}</Button>}
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
      items={(['ability', 'potential', 'experience', 'achievement'] as const).map((type) => ({
        key: type,
        label: m[type],
        children: (
          <>
            <p>{display(row[`${type}Note`])}</p>
            <Table
              rowKey="dimensionId"
              size="small"
              pagination={false}
              dataSource={array(row.dimensions)
                .filter((item) => item.type === type)
                .map((item) => ({ ...item, ...((item.dimension as object | undefined) ?? {}) }))}
              columns={columns([
                ['name', m.name],
                ['definition', m.definition],
                ['dimensionCategory', m.category],
                ...(type === 'ability'
                  ? ([
                      ['target', m.targetValue],
                      ['weight', m.weight],
                    ] as [string, string][])
                  : []),
              ])}
            />
          </>
        ),
      }))}
    />
  );
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
