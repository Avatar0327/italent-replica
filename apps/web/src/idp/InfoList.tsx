import { Alert, Button, Empty, Pagination, Select, Space, Table, type TableColumnsType } from 'antd';
import { useState, type Key } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { MenuIcon } from '../foundation/ViewHeading.js';
import { useCollection } from './api.js';
import { useLocalPage } from './listing.js';
import { InfoForm } from './InfoForm.js';
import { InfoDelete } from './InfoDelete.js';
import { INFO, infoPath, infoText as m, textValue, type InfoKind, type InfoRow } from './info-model.js';
import {
  useInfoReferences,
  ReferenceError,
  PersonName,
  PEOPLE,
  PROFILE,
  ORGS,
  POSITIONS,
  INFO_SOURCES,
} from './info-references.js';
import './info.css';

type References = ReturnType<typeof useInfoReferences>;
type Column = { key: string; title: string; field: string; person?: boolean; value(row: InfoRow): unknown };
export function TutorshipList() {
  return <InfoList kind="tutorships" />;
}
export function CareerList() {
  return <InfoList kind="careers" />;
}
export function WorkShiftList() {
  return <InfoList kind="work-shifts" />;
}

function useRelated(kind: InfoKind, rows: InfoRow[]) {
  const peopleFields = INFO[kind].fields.filter((f) => f.type === 'person').map((f) => f.name);
  const ids = [
    ...new Set(
      rows.flatMap((row) => peopleFields.map((f) => row[f])).filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const people = useInfoReferences(
    ids.flatMap((id) => [
      `${PEOPLE}/${id}`,
      ...(kind === 'careers' ? [] : [`${PROFILE}/${id}`, `${PEOPLE}/${id}/records`]),
    ]),
  );
  const current = (id: unknown) =>
    typeof id === 'string'
      ? (people.get(`${PEOPLE}/${id}/records`)?.fields as Record<string, unknown> | undefined)
      : undefined;
  const paths: string[] = [];
  const add = (base: string, id: unknown) => {
    if (typeof id === 'string') paths.push(`${base}/${id}`);
  };
  rows.forEach((r) => {
    add(ORGS, r.orgId);
    add(POSITIONS, r.positionId);
    add(POSITIONS, r.targetPositionId);
    if (kind === 'careers') {
      add(INFO_SOURCES.professionalLine, r.targetProfessionalLineId);
      add(INFO_SOURCES.level, r.targetLevelId);
      add(INFO_SOURCES.post, r.targetPostId);
      add(INFO_SOURCES.level, r.currentLevelId);
      add(POSITIONS, r.currentPositionId);
    }
  });
  ids.forEach((id) => {
    const fields = current(id);
    add(ORGS, fields?.departmentId);
    add(POSITIONS, fields?.positionId);
    add('/api/tenant/job/levels', fields?.levelId);
    add('/api/tenant/job/posts', fields?.postId);
  });
  const catalog = useInfoReferences(paths);
  return {
    people,
    catalog,
    current,
    error: people.error || catalog.error,
    loading: people.loading || catalog.loading,
    reload: () => {
      people.reload();
      catalog.reload();
    },
  };
}
function useInfoList(kind: InfoKind) {
  const spec = INFO[kind];
  const permission = usePermissions(spec.object);
  const list = useCollection<InfoRow>(infoPath(kind));
  const refs = useRelated(kind, list.items ?? []);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Key[]>([]);
  const [editing, setEditing] = useState<{ row?: InfoRow }>();
  const [deleting, setDeleting] = useState<InfoRow[]>();
  const columns = infoColumns(kind, refs).filter((c) => permission.field(c.field).visible);
  // 被裁剪 / 未读到的值不参与过滤，不能因为关联字段缺席而吞掉记录。
  const rows = (list.items ?? []).filter((row) =>
    columns.every((c) => {
      const filter = filters[c.key];
      const value = filterValue(c.value(row));
      return !filter || value === undefined || value === filter;
    }),
  );
  const paging = useLocalPage(rows, list.loading);
  const ops = permission.snapshot.objects[spec.object]?.dataOperations;
  const canCreate =
    ops?.create === true && spec.fields.filter((f) => f.required).every((f) => permission.field(f.name).editable);
  const canUpdate = ops?.update === true && spec.fields.some((f) => permission.field(f.name).editable);
  const saved = () => {
    list.reload();
    setSelected([]);
  };
  const action = (row: InfoRow, remove: boolean) => (
    <Button
      key={String(remove)}
      type="link"
      disabled={list.loading || !Number.isSafeInteger(row.revision) || (remove ? ops?.delete !== true : !canUpdate)}
      onClick={() => (remove ? setDeleting([row]) : setEditing({ row }))}
    >
      {remove ? m.remove : m.edit}
    </Button>
  );
  const tableColumns: TableColumnsType<InfoRow> = columns.map((c) => ({
    key: c.key,
    title: c.title,
    ellipsis: true,
    width: kind === 'careers' ? 155 : kind === 'tutorships' ? 130 : undefined,
    render: (_: unknown, row: InfoRow) =>
      c.person ? <PersonName person={c.value(row) as InfoRow | undefined} /> : textValue(c.value(row)),
  }));
  tableColumns.push({
    key: 'actions',
    title: m.actions,
    width: 120,
    render: (_, row) => (
      <Space size={0}>
        {(kind === 'careers' ? [true, false] : [false, true])
          .filter((remove) => permission.can(remove ? 'delete' : 'update'))
          .map((remove) => action(row, remove))}
      </Space>
    ),
  });
  return {
    spec,
    permission,
    list,
    refs,
    filters,
    setFilters,
    selected,
    setSelected,
    editing,
    setEditing,
    deleting,
    setDeleting,
    columns,
    rows,
    paging,
    canCreate,
    tableColumns,
    saved,
  };
}
function InfoList({ kind }: { kind: InfoKind }) {
  const {
    permission,
    list,
    refs,
    filters,
    setFilters,
    selected,
    setSelected,
    editing,
    setEditing,
    deleting,
    setDeleting,
    columns,
    rows,
    paging,
    canCreate,
    tableColumns,
    saved,
  } = useInfoList(kind);
  return (
    <section className={`list-page info-page info-page-${kind}`}>
      <InfoHeading
        kind={kind}
        permission={permission}
        loading={list.loading}
        canCreate={canCreate}
        hasSelection={selected.length > 0}
        create={() => setEditing({})}
        remove={() => setDeleting((list.items ?? []).filter((r) => selected.includes(r.id)))}
      />
      {kind === 'careers' && <DecisionNote id="idp-careers" />}
      <div className="list-card">
        <ReferenceError refs={refs} />
        <InfoFilters
          kind={kind}
          columns={columns}
          rows={list.items ?? []}
          filters={filters}
          loading={refs.loading}
          change={(key, value) => {
            setFilters((old) => ({ ...old, [key]: value ?? '' }));
            paging.first();
            setSelected([]);
          }}
        />
        <InfoTable
          list={list}
          paging={paging}
          kind={kind}
          rows={rows}
          columns={tableColumns}
          selected={selected}
          select={setSelected}
        />
        {list.hasDataPermission === false && <Alert type="info" message={m.noDataPermission} />}
      </div>
      {editing && <InfoForm kind={kind} row={editing.row} close={() => setEditing(undefined)} saved={saved} />}
      {deleting && <InfoDelete kind={kind} rows={deleting} close={() => setDeleting(undefined)} saved={saved} />}
    </section>
  );
}
const filterValue = (v: unknown) =>
  typeof v === 'string'
    ? v
    : v && typeof v === 'object' && typeof (v as InfoRow).name === 'string'
      ? (v as InfoRow).id
      : undefined;
function infoColumns(
  kind: InfoKind,
  refs: { people: References; catalog: References; current(id: unknown): Record<string, unknown> | undefined },
): Column[] {
  const raw = (key: string, title: string): Column => ({ key, title, field: key, value: (r) => r[key] });
  const ref = (base: string, id: unknown) =>
    typeof id === 'string' ? refs.catalog.get(`${base}/${id}`)?.name : undefined;
  const person = (field: string, title: string): Column => ({
    key: field,
    title,
    field,
    person: true,
    value: (r) => refs.people.get(`${PEOPLE}/${r[field]}`),
  });
  const email = (field: string, title: string): Column => ({
    key: `${field}Email`,
    title,
    field,
    value: (r) => refs.people.get(`${PROFILE}/${r[field]}`)?.email,
  });
  const department = (field: string, key: string, title: string): Column => ({
    key,
    title,
    field,
    value: (r) => ref(ORGS, refs.current(r[field])?.departmentId),
  });
  const named = (field: string, title: string, base: string): Column => ({
    key: field,
    title,
    field,
    value: (r) => ref(base, r[field]),
  });
  const dates = [raw('startDate', '开始时间'), raw('endDate', kind === 'tutorships' ? '结束日期' : '结束时间')];
  if (kind === 'tutorships')
    return [
      person('tutorEmployeeId', '带教人'),
      email('tutorEmployeeId', '带教人邮箱'),
      department('tutorEmployeeId', 'tutorDepartment', '带教人部门'),
      person('tuteeEmployeeId', '被带教人'),
      email('tuteeEmployeeId', '被带教人邮件'),
      department('tuteeEmployeeId', 'tuteeDepartment', '被带教人部门'),
      ...dates,
    ];
  if (kind === 'work-shifts')
    return [
      person('employeeId', '姓名'),
      email('employeeId', '邮箱'),
      department('employeeId', 'department', '部门'),
      ...dates,
      named('orgId', '轮岗部门', ORGS),
      named('positionId', '轮岗职位', POSITIONS),
      {
        ...person('mentorEmployeeId', '轮岗导师'),
        person: false,
        value: (r) => refs.people.get(`${PEOPLE}/${r.mentorEmployeeId}`)?.name,
      },
    ];

  return [
    person('employeeId', '发展员工'),
    ...dates,
    raw('strengths', '优势项'),
    raw('developmentItems', '待发展项'),
    named('currentLevelId', m.currentLevel, INFO_SOURCES.level),
    named('currentPositionId', m.currentPosition, POSITIONS),
    { ...raw('currentPostName', m.currentPost), field: 'currentPostId' },
    ...INFO.careers.fields
      .filter((field) => field.name.startsWith('target'))
      .map((field) => named(field.name, field.label, INFO_SOURCES[field.type as keyof typeof INFO_SOURCES])),
  ];
}

function InfoHeading({
  kind,
  permission,
  loading,
  canCreate,
  hasSelection,
  create,
  remove,
}: {
  kind: InfoKind;
  permission: ReturnType<typeof usePermissions>;
  loading: boolean;
  canCreate: boolean;
  hasSelection: boolean;
  create(): void;
  remove(): void;
}) {
  const ops = permission.snapshot.objects[INFO[kind].object]?.dataOperations;
  return (
    <header className="page-heading">
      <h1 className="page-view-heading">
        <span className="page-view-icon" aria-hidden="true">
          {kind === 'careers' ? '⌘' : <MenuIcon />}
        </span>
        <span>{INFO[kind].title}</span>
      </h1>
      <Space>
        {permission.can('create', 'list') && (
          <Button type="primary" disabled={!canCreate || loading} onClick={create}>
            {INFO[kind].create}
          </Button>
        )}
        {permission.can('delete') && (
          <Button type="primary" disabled={ops?.delete !== true || !hasSelection || loading} onClick={remove}>
            {m.remove}
          </Button>
        )}
      </Space>
    </header>
  );
}
function InfoFilters({
  kind,
  columns,
  rows,
  filters,
  loading,
  change,
}: {
  kind: InfoKind;
  columns: Column[];
  rows: InfoRow[];
  filters: Record<string, string>;
  loading: boolean;
  change(key: string, value: string | undefined): void;
}) {
  const filterKeys =
    kind === 'tutorships'
      ? ['tutorEmployeeId', 'tuteeEmployeeId', 'tutorDepartment', 'tuteeDepartment', 'startDate']
      : kind === 'careers'
        ? ['employeeId']
        : ['employeeId', 'department', 'orgId', 'positionId', 'mentorEmployeeId'];
  return (
    <div className="page-filters">
      <Space wrap>
        {filterKeys.flatMap((key) => {
          const column = columns.find((c) => c.key === key);
          if (!column) return [];
          const options = new Map<string, string>();
          for (const row of rows) {
            const v = column.value(row);
            const value = filterValue(v);
            if (value) options.set(value, typeof v === 'object' && v ? textValue((v as InfoRow).name) : value);
          }
          return [
            <Select
              key={key}
              aria-label={column.title}
              placeholder={column.title}
              variant="borderless"
              allowClear
              popupMatchSelectWidth={200}
              value={filters[key]}
              disabled={loading}
              options={[...options].map(([value, label]) => ({ value, label }))}
              onChange={(value: string | undefined) => change(key, value)}
            />,
          ];
        })}
      </Space>
    </div>
  );
}

function InfoTable({
  list,
  paging,
  kind,
  rows,
  columns,
  selected,
  select,
}: {
  list: ReturnType<typeof useCollection<InfoRow>>;
  paging: ReturnType<typeof useLocalPage<InfoRow>>;
  kind: InfoKind;
  rows: InfoRow[];
  columns: TableColumnsType<InfoRow>;
  selected: Key[];
  select(keys: Key[]): void;
}) {
  return (
    <>
      {' '}
      {list.error ? (
        <PageState kind="error" error={list.error} retry={list.reload} />
      ) : (
        <>
          <Table<InfoRow>
            rowKey="id"
            size="small"
            loading={list.loading}
            dataSource={paging.shown}
            columns={columns}
            pagination={false}
            scroll={{ x: kind === 'careers' ? 2150 : kind === 'tutorships' ? 1250 : undefined }}
            locale={{ emptyText: <Empty /> }}
            rowSelection={{ selectedRowKeys: selected, onChange: select }}
          />
          <div className="page-toolbar">
            <span>{m.total(rows.length)}</span>
            {rows.length > paging.page.pageSize && (
              <Pagination
                current={paging.page.page}
                pageSize={paging.page.pageSize}
                total={rows.length}
                onChange={(page) => {
                  paging.change({ ...paging.page, page });
                  select([]);
                }}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}
