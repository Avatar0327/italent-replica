import { Button, Descriptions, Form, Popconfirm, Select, Tag, type TableColumnsType } from 'antd';
import { useState, type Key, type ReactNode } from 'react';
import { RemoteSelect, Failure, useRead } from '../evaluation/runtime.js';
import { newCommand } from '../foundation/client.js';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { DetailPage, ListPage } from '../foundation/templates.js';
import { s } from './messages.js';
import { EndForm, RECORD, RecordForm, targetName } from './RecordForm.js';
import { BASE, recordQuery } from './rules.js';
import type { ListResult, PersonView, ReadinessRef, RecordView, SuccessionType } from './types.js';

const PAGE_SIZE = 15;
const people = (list?: PersonView[]) => (list?.length ? list.map((person) => person.name).join('、') : s.none);
export const ReadinessTag = ({ value }: { value?: ReadinessRef | null }) =>
  value ? <Tag color={value.color}>{value.name}</Tag> : <>{s.none}</>;
const dateTime = (value?: string) => value?.slice(0, 16).replace('T', ' ') ?? s.none;

interface Filters {
  status: string;
  targetId?: string;
}
/** 一个页签一张列表：目标、继任者等关系字段按服务端回显；隐藏字段不出列、不进筛选（docs/02_业务建模/27 §5.2）。 */
export function RecordList({ type, title }: { type: SuccessionType; title: string }) {
  const permission = usePermissions(RECORD);
  const visible = (field: string) => permission.field(field).visible;
  const [page, setPage] = useState({ page: 1, pageSize: PAGE_SIZE });
  const [filters, setFilters] = useState<Filters>({ status: 'active' });
  const query = recordQuery({ type, ...page, ...filters }, visible);
  const list = useRead<ListResult<RecordView>>(permission.loading ? undefined : `${BASE}/records?${query}`);
  const [selected, setSelected] = useState<{ keys: Key[]; rows: RecordView[] }>({ keys: [], rows: [] });
  const [detail, setDetail] = useState<RecordView>();
  const [form, setForm] = useState<'create' | 'edit' | 'end'>();
  const refresh = () => {
    setSelected({ keys: [], rows: [] });
    list.reload();
  };
  const columns = useColumns(type, visible, setDetail);
  return (
    <>
      <ListPage<RecordView>
        title={title}
        rowKey="id"
        data={{
          items: list.data?.items ?? [],
          total: list.data?.total ?? 0,
          hasDataPermission: list.data?.hasDataPermission,
        }}
        columns={columns}
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        actions={
          <>
            <Button onClick={refresh}>{s.refresh}</Button>
            <RecordFilters
              type={type}
              value={filters}
              onChange={(next) => (setFilters(next), setPage({ ...page, page: 1 }))}
            />
            {permission.can('create', 'list') && (
              <Button type="primary" onClick={() => setForm('create')}>
                {s.create}
              </Button>
            )}
          </>
        }
        selection={
          permission.can('end', 'list')
            ? {
                keys: selected.keys,
                onChange: (keys, rows) => setSelected({ keys, rows }),
                actions: <Button onClick={() => setForm('end')}>{s.end}</Button>,
              }
            : undefined
        }
      />
      {detail && (
        <RecordDetail
          row={detail}
          type={type}
          onEdit={() => setForm('edit')}
          onClose={() => setDetail(undefined)}
          onDeleted={() => (setDetail(undefined), refresh())}
        />
      )}
      {form === 'create' && <RecordForm type={type} close={() => setForm(undefined)} saved={refresh} />}
      {form === 'edit' && detail && (
        <RecordForm
          type={type}
          row={detail}
          close={() => setForm(undefined)}
          saved={() => (setDetail(undefined), refresh())}
        />
      )}
      {form === 'end' && <EndForm rows={selected.rows} close={() => setForm(undefined)} saved={refresh} />}
    </>
  );
}

function useColumns(
  type: SuccessionType,
  visible: (field: string) => boolean,
  open: (row: RecordView) => void,
): TableColumnsType<RecordView> {
  const column = (key: string, field: string, title: string, render: (row: RecordView) => ReactNode) =>
    visible(field) ? [{ key, title, render: (_: unknown, row: RecordView) => render(row) }] : [];
  const target =
    type === 'position'
      ? [
          ...column('target', 'targetPositionId', s.fields.targetPosition, (row) => (
            <Button type="link" onClick={() => open(row)}>
              {targetName(row) ?? s.none}
            </Button>
          )),
          ...column('incumbents', 'incumbents', s.fields.incumbents, (row) => people(row.incumbents)),
        ]
      : [
          ...column('target', 'targetOrgId', s.fields.targetOrg, (row) => (
            <Button type="link" onClick={() => open(row)}>
              {targetName(row) ?? s.none}
            </Button>
          )),
          ...column('owner', 'personInCharge', s.fields.personInCharge, (row) => row.personInCharge?.name ?? s.none),
        ];
  return [
    ...target,
    ...column('successor', 'successorEmployeeId', s.fields.successor, (row) => row.successor?.name ?? s.none),
    ...column('readiness', 'readinessId', s.fields.readiness, (row) => <ReadinessTag value={row.readiness} />),
    ...column('state', 'successorEmployeeId', s.fields.successorStatus, (row) =>
      row.successorLeft ? s.left : s.onDuty,
    ),
    ...column('backup', 'backupType', s.fields.backupType, (row) => s.backupTypes[row.backupType ?? ''] ?? s.none),
    ...column('start', 'startDate', s.fields.startDate, (row) => row.startDate ?? s.none),
    ...column('end', 'endDate', s.fields.endDate, (row) => row.endDate ?? s.untilNow),
    ...column('updated', 'updatedAt', s.fields.updatedAt, (row) => dateTime(row.updatedAt)),
    ...column('created', 'createdAt', s.fields.createdAt, (row) => dateTime(row.createdAt)),
    // 后端只回创建人 ID（后端缺口清单），先原样展示。
    ...column('creator', 'createdBy', s.fields.createdBy, (row) => row.createdBy ?? s.none),
  ];
}

function RecordFilters({
  type,
  value,
  onChange,
}: {
  type: SuccessionType;
  value: Filters;
  onChange(next: Filters): void;
}) {
  const permission = usePermissions(RECORD);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const targetField = type === 'position' ? 'targetPositionId' : 'targetOrgId';
  const targetPath = type === 'position' ? '/api/tenant/job/positions' : '/api/tenant/org/organizations';
  const label = type === 'position' ? s.fields.targetPosition : s.fields.targetOrg;
  return (
    <>
      <Button onClick={() => (setDraft(value), setOpen(true))}>{s.filter}</Button>
      <FilterDrawer
        open={open}
        onClose={() => setOpen(false)}
        onClear={() => setDraft({ status: 'active' })}
        onApply={() => (onChange(draft), setOpen(false))}
      >
        <Form layout="vertical">
          <Form.Item label={s.fields.status}>
            <Select
              aria-label={s.fields.status}
              value={draft.status}
              onChange={(status) => setDraft({ ...draft, status })}
              options={Object.entries(s.statuses).map(([key, text]) => ({ value: key, label: text }))}
            />
          </Form.Item>
          {permission.field(targetField).visible && (
            <Form.Item label={label}>
              <RemoteSelect
                path={targetPath}
                label={label}
                value={draft.targetId}
                onChange={(targetId) => setDraft({ ...draft, targetId: targetId as string | undefined })}
              />
            </Form.Item>
          )}
        </Form>
      </FilterDrawer>
    </>
  );
}

function RecordDetail(props: {
  row: RecordView;
  type: SuccessionType;
  onEdit(): void;
  onClose(): void;
  onDeleted(): void;
}) {
  const { row, type } = props;
  const permission = usePermissions(RECORD);
  const api = useApiClient();
  const [error, setError] = useState<unknown>();
  const current = useRead<RecordView>(`${BASE}/records/${row.id}`);
  const view = current.data ?? row;
  const visible = (field: string) => permission.field(field).visible;
  const remove = async () => {
    setError(undefined);
    try {
      await api.request(`${BASE}/records/${view.id}`, {
        method: 'DELETE',
        command: newCommand(undefined, view.revision),
      });
      props.onDeleted();
    } catch (cause) {
      setError(cause);
    }
  };
  const items: { key: string; field: string; label: string; children: ReactNode }[] = [
    type === 'position'
      ? { key: 'target', field: 'targetPositionId', label: s.fields.targetPosition, children: targetName(view) }
      : { key: 'target', field: 'targetOrgId', label: s.fields.targetOrg, children: targetName(view) },
    type === 'position'
      ? { key: 'incumbents', field: 'incumbents', label: s.fields.incumbents, children: people(view.incumbents) }
      : { key: 'owner', field: 'personInCharge', label: s.fields.personInCharge, children: view.personInCharge?.name },
    { key: 'successor', field: 'successorEmployeeId', label: s.fields.successor, children: view.successor?.name },
    {
      key: 'readiness',
      field: 'readinessId',
      label: s.fields.readiness,
      children: <ReadinessTag value={view.readiness} />,
    },
    { key: 'backup', field: 'backupType', label: s.fields.backupType, children: s.backupTypes[view.backupType ?? ''] },
    { key: 'start', field: 'startDate', label: s.fields.startDate, children: view.startDate },
    { key: 'end', field: 'endDate', label: s.fields.endDate, children: view.endDate ?? s.untilNow },
    { key: 'reason', field: 'endReason', label: s.fields.endReason, children: view.endReason },
    { key: 'status', field: 'status', label: s.fields.status, children: s.statuses[view.status ?? ''] },
  ];
  return (
    <DetailPage
      open
      onClose={props.onClose}
      title={targetName(view) ?? s.none}
      actions={
        <>
          {permission.can('update') && view.status !== 'ended' && <Button onClick={props.onEdit}>{s.edit}</Button>}
          {permission.can('delete') && (
            <Popconfirm title={s.deleteConfirm} onConfirm={remove}>
              <Button danger>{s.delete}</Button>
            </Popconfirm>
          )}
        </>
      }
      summary={
        <>
          <Failure error={error ?? current.error} retry={current.error ? current.reload : undefined} />
          <Descriptions
            column={2}
            items={items
              .filter((item) => visible(item.field))
              .map(({ key, label, children }) => ({ key, label, children: children ?? s.none }))}
          />
        </>
      }
    />
  );
}
