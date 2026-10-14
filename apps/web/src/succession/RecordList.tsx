import { Alert, Button, Dropdown, Space, Tag, Tooltip, type TableColumnsType } from 'antd';
import { useState, type Key, type ReactNode } from 'react';
import { RemoteSelect, Failure, useRead } from '../evaluation/runtime.js';
import { usePermissions } from '../foundation/Permissions.js';
import { PersonSelect, type Choice } from '../foundation/selectors.js';
import { useSession } from '../foundation/Session.js';
import { ListPage } from '../foundation/templates.js';
import { DeleteButton } from './conflict.js';
import { s } from './messages.js';
import { EndForm, RECORD, RecordForm, targetPaths, useCandidateLoader } from './RecordForm.js';
import { BASE, recordKind, recordQuery } from './rules.js';
import type { ListResult, PersonView, ReadinessRef, RecordView, SuccessionType } from './types.js';

const PAGE_SIZE = 15;
const people = (list?: PersonView[]) => (list?.length ? list.map((person) => person.name).join('、') : s.none);
export const ReadinessTag = ({ value }: { value?: ReadinessRef | null }) =>
  value ? <Tag color={value.color}>{value.name}</Tag> : <>{s.none}</>;
// 修改 / 创建时间是 UTC 事件时间，按租户时区显示（DEC-056）；时区未就绪时不猜，显示空。
function dateTime(value: string | undefined, timezone: string) {
  const instant = value ? new Date(value) : undefined;
  if (!instant || !timezone || Number.isNaN(instant.getTime())) return s.none;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

interface Filters {
  targetId?: string;
  successor?: Choice;
}
/**
 * 一个页签一张列表：按钮作用于勾选行，原站没有行详情与视图名下拉（UI2 对照）；
 * 关系字段按服务端回显，隐藏字段不出列、不进筛选（docs/02_业务建模/27 §5.2）。
 */
export function RecordList({ type, title }: { type: SuccessionType; title: string }) {
  const permission = usePermissions(RECORD);
  const visible = (field: string) => permission.field(field).visible;
  const [page, setPage] = useState({ page: 1, pageSize: PAGE_SIZE });
  const [filters, setFilters] = useState<Filters>({});
  const query = recordQuery(
    { type, ...page, targetId: filters.targetId, successorEmployeeId: filters.successor?.value },
    visible,
  );
  const list = useRead<ListResult<RecordView>>(permission.loading ? undefined : `${BASE}/records?${query}`);
  const [selected, setSelected] = useState<{ keys: Key[]; rows: RecordView[] }>({ keys: [], rows: [] });
  const [form, setForm] = useState<'create' | 'edit' | 'end'>();
  const [error, setError] = useState<unknown>();
  const one = selected.rows.length === 1 ? selected.rows[0] : undefined;
  const refresh = () => {
    setSelected({ keys: [], rows: [] });
    list.reload();
  };
  const filter = (next: Filters) => (setFilters(next), setPage({ ...page, page: 1 }));
  // 删除冲突（别处改过）：报错并刷新列表、清空勾选，重选后按新版本删除（conflict.tsx DeleteButton）。
  const settled = (cause?: unknown) => {
    setError(cause);
    refresh();
  };
  const selectable = permission.can('update') || permission.can('delete') || permission.can('end', 'list');
  const actions = <RecordActions one={one} count={selected.rows.length} open={setForm} settled={settled} />;
  const typed = visible('successionType');
  return (
    <div className="succession-records">
      {!typed && <Alert type="info" showIcon message={s.mixedHint(s.kindLabels[type]!)} />}
      <Failure error={error} />
      <ListPage<RecordView>
        title={title}
        rowKey="id"
        data={{
          items: ofKind(list.data?.items ?? [], type, typed),
          total: list.data?.total ?? 0,
          hasDataPermission: list.data?.hasDataPermission,
        }}
        columns={useColumns(type, visible)}
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        filters={<RecordFilters type={type} value={filters} onChange={filter} />}
        actions={actions}
        selection={
          selectable
            ? { keys: selected.keys, onChange: (keys, rows) => setSelected({ keys, rows }), actions: null }
            : undefined
        }
      />
      {form === 'create' && <RecordForm type={type} close={() => setForm(undefined)} saved={refresh} />}
      {form === 'edit' && one && <RecordForm type={type} row={one} close={() => setForm(undefined)} saved={refresh} />}
      {form === 'end' && <EndForm rows={selected.rows} close={() => setForm(undefined)} saved={refresh} />}
    </div>
  );
}

/**
 * 无权查看继任类型时服务端不按类型过滤（rules.ts recordQuery），两张表拿到的是混合列表：
 * 前端按记录自身的目标字段判断类型，只留本页类型和无法区分的记录；分页总数仍是两类合计（页面提示里说明）。
 */
function ofKind(rows: RecordView[], type: SuccessionType, typed: boolean) {
  if (typed) return rows;
  return rows.filter((row) => {
    const kind = recordKind(row);
    return kind === undefined || kind === type;
  });
}

/** 列表右上角按钮：编辑、删除作用于唯一勾选行，更多操作里的结束作用于全部勾选行。 */
function RecordActions(props: {
  one?: RecordView;
  count: number;
  open(form: 'create' | 'edit' | 'end'): void;
  settled(error?: unknown): void;
}) {
  const permission = usePermissions(RECORD);
  const { one, count, open, settled } = props;
  return (
    <>
      {permission.can('create', 'list') && (
        <Button type="primary" onClick={() => open('create')}>
          {s.create}
        </Button>
      )}
      {permission.can('update') && (
        <Button type="primary" disabled={!one || one.status === 'ended'} onClick={() => open('edit')}>
          {s.edit}
        </Button>
      )}
      {/* 删除只对单条：后端是逐条删除，多选删除做不到整体成功或整体失败（DEC-067 批量）。 */}
      {permission.can('delete') && (
        <DeleteButton path={`${BASE}/records/${one?.id}`} row={one} settled={settled} button={{ type: 'primary' }} />
      )}
      <Tooltip title={s.importPending}>
        <Button disabled>{s.import}</Button>
      </Tooltip>
      {permission.can('end', 'list') && (
        <Dropdown
          trigger={['click']}
          disabled={!count}
          menu={{ items: [{ key: 'end', label: s.end }], onClick: () => open('end') }}
        >
          <Button type="primary">{s.more}</Button>
        </Dropdown>
      )}
    </>
  );
}

function useColumns(type: SuccessionType, visible: (field: string) => boolean): TableColumnsType<RecordView> {
  const { timezone } = useSession();
  const column = (key: string, field: string, title: string, render: (row: RecordView) => ReactNode) =>
    visible(field) ? [{ key, title, render: (_: unknown, row: RecordView) => render(row) }] : [];
  // 目标、现任人员、负责人这几列按记录自身的类型取值；类型对不上或无法区分时明确标出，绝不错列。
  const own = (render: (row: RecordView) => ReactNode) => (row: RecordView) =>
    recordKind(row) === type ? render(row) : s.unknownKind;
  const common = (row: RecordView) => ({
    successor: row.successor?.name ?? s.none,
    readiness: <ReadinessTag value={row.readiness} />,
    state: row.successorLeft ? s.left : s.onDuty,
  });
  const successor = column('successor', 'successorEmployeeId', s.fields.successor, (row) => common(row).successor);
  const readiness = column('readiness', 'readinessId', s.fields.readiness, (row) => common(row).readiness);
  const state = column('state', 'successorEmployeeId', s.fields.successorStatus, (row) => common(row).state);
  const period = [
    ...column('start', 'startDate', s.fields.startDate, (row) => row.startDate ?? s.none),
    ...column('end', 'endDate', s.fields.endDate, (row) => row.endDate ?? s.untilNow),
  ];
  // 两张表的列按原站各自的列序（UI2 对照）：组织列表有后备类型、没有修改 / 创建列。
  if (type === 'org')
    return [
      ...column(
        'target',
        'targetOrgId',
        s.fields.orgName,
        own((row) => row.targetOrg?.name ?? s.none),
      ),
      ...column(
        'owner',
        'personInCharge',
        s.fields.deptHead,
        own((row) => row.personInCharge?.name ?? s.none),
      ),
      ...successor,
      ...column('backup', 'backupType', s.fields.backupType, (row) => s.backupTypes[row.backupType ?? ''] ?? s.none),
      ...readiness,
      ...state,
      ...period,
    ];
  return [
    ...column(
      'target',
      'targetPositionId',
      s.fields.targetPosition,
      own((row) => row.targetPosition?.name ?? s.none),
    ),
    ...column(
      'incumbents',
      'incumbents',
      s.fields.incumbents,
      own((row) => people(row.incumbents)),
    ),
    ...successor,
    ...readiness,
    ...state,
    ...period,
    ...column('updated', 'updatedAt', s.fields.updatedAt, (row) => dateTime(row.updatedAt, timezone)),
    ...column('created', 'createdAt', s.fields.createdAt, (row) => dateTime(row.createdAt, timezone)),
    // 后端只回创建人 ID（后端缺口清单），先原样展示。
    ...column('creator', 'createdBy', s.fields.createdBy, (row) => row.createdBy ?? s.none),
  ];
}

/** 原站列表上方是一排字段筛选；只放后端能查的目标与继任者，其余见后端缺口清单。 */
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
  const loadCandidates = useCandidateLoader();
  const targetField = type === 'position' ? 'targetPositionId' : 'targetOrgId';
  const label = type === 'position' ? s.fields.targetPosition : s.fields.targetOrg;
  return (
    <Space wrap>
      {permission.field(targetField).visible && (
        <label className="succession-filter">
          <span>{label}</span>
          <RemoteSelect
            path={targetPaths[type]}
            label={label}
            value={value.targetId}
            onChange={(targetId) => onChange({ ...value, targetId: (targetId as string | undefined) || undefined })}
          />
        </label>
      )}
      {permission.field('successorEmployeeId').visible && (
        <label className="succession-filter">
          <span>{s.fields.successor}</span>
          <PersonSelect
            load={loadCandidates}
            value={value.successor}
            onChange={(successor) => onChange({ ...value, successor })}
          />
        </label>
      )}
    </Space>
  );
}
