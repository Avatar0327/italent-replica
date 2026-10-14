import { Alert, Button, Dropdown, Form, Select, Space, Tooltip, type TableColumnsType } from 'antd';
import { useMemo, useState, type Key, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { ListPage } from '../foundation/templates.js';
import { IDP_API, OBJECTS, useCollection } from './api.js';
import { Intervention, type InterventionKind } from './Interventions.js';
import { HeaderActions, NameSearch, useLocalPage } from './listing.js';
import { t } from './messages.js';
import {
  BUTTON_LEVEL,
  display,
  filterPlans,
  nextStage,
  period,
  PLAN_VIEWS,
  statusText,
  type PlanAction,
  type PlanFilters,
  type PlanView,
} from './model.js';
import { PlanDetailPage } from './PlanDetail.js';
import { PlanForm } from './PlanForm.js';
import { EmployeeSelect } from './selects.js';
import type { PlanSummary } from './types.js';
import { useNames } from './useNames.js';

const VIEW_LABELS: Record<PlanView, string> = {
  active: t.views.active,
  ended: t.views.ended,
  terminated: t.views.terminated,
};
type Editing = { plan?: PlanSummary } | undefined;
const DETAIL = 'plan';

type Selection = { keys: Key[]; rows: PlanSummary[] };
const NONE: Selection = { keys: [], rows: [] };

export function PlanList() {
  const permission = usePermissions(OBJECTS.plan);
  const list = useCollection<PlanSummary>(`${IDP_API}/plans`);
  const [selected, setSelected] = useState<Selection>(NONE);
  const can = (action: PlanAction) => permission.can(action, BUTTON_LEVEL[action]);
  const [params, setParams] = useSearchParams();
  const openId = params.get(DETAIL);
  const open = (id?: string) => setParams(id ? { [DETAIL]: id } : {});
  const overlays = usePlanOverlays(
    () => {
      setSelected(NONE);
      list.reload();
    },
    (ids) => {
      if (openId && ids.includes(openId)) open();
    },
  );
  return (
    <>
      {openId ? (
        <PlanDetailPage
          key={`${openId}/${overlays.version}`}
          id={openId}
          onBack={() => open()}
          can={can}
          edit={overlays.edit}
          intervene={(kind, plan) => overlays.intervene(kind, [plan])}
        />
      ) : (
        <PlanTable
          list={list}
          permission={permission}
          can={can}
          open={open}
          selection={{ value: selected, change: setSelected }}
          overlays={overlays}
        />
      )}
      {overlays.element}
    </>
  );
}

interface TableProps {
  list: ReturnType<typeof useCollection<PlanSummary>>;
  permission: ReturnType<typeof usePermissions>;
  can(action: PlanAction): boolean;
  open(id: string): void;
  selection: { value: Selection; change(value: Selection): void };
  overlays: ReturnType<typeof usePlanOverlays>;
}
function PlanTable({ list, permission, can, open, selection, overlays }: TableProps) {
  const [view, setView] = useState<PlanView>('active');
  const [filters, setFilters] = useState<PlanFilters>({});
  const rows = useMemo(() => filterPlans(list.items ?? [], view, filters), [list.items, view, filters]);
  const paging = useLocalPage(rows, list.loading);
  const employees = useNames(
    'employee',
    paging.shown.flatMap((row) => [row.employeeId, row.tutorEmployeeId]),
  );
  const restart = () => {
    paging.first();
    selection.change(NONE);
  };
  const stageOptions = useMemo(
    () => [...new Set((list.items ?? []).map((row) => row.currentStageName).filter((name) => !!name))] as string[],
    [list.items],
  );
  const selected = selection.value;
  return (
    <>
      <DecisionNote id="idp-plans" />
      <ListPage<PlanSummary>
        title={t.plans}
        view={{
          value: view,
          options: (Object.keys(PLAN_VIEWS) as PlanView[]).map((key) => ({ key, label: VIEW_LABELS[key] })),
          onChange: (value) => {
            setView(value as PlanView);
            restart();
          },
        }}
        data={{ items: paging.shown, total: rows.length, hasDataPermission: list.hasDataPermission }}
        columns={columns(permission.field, employees, open)}
        rowKey="id"
        page={paging.page}
        onPageChange={paging.change}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        filters={
          <PlanFilterBar
            value={filters}
            change={(value) => {
              setFilters(value);
              restart();
            }}
            visible={(key) => permission.field(key).visible}
            stages={stageOptions}
          />
        }
        actions={
          <HeaderActions create={permission.can('create', 'list') && overlays.create} refresh={overlays.refresh}>
            <Tooltip title={t.importPending}>
              <Button disabled>{t.actions.importExport}</Button>
            </Tooltip>
          </HeaderActions>
        }
        selection={{
          keys: selected.keys,
          onChange: (keys, picked) => selection.change({ keys, rows: picked }),
          actions: (
            <SelectionActions
              view={view}
              rows={selected.rows}
              can={can}
              intervene={(kind) => overlays.intervene(kind, selected.rows)}
            />
          ),
        }}
      />
    </>
  );
}

/** 新增 / 编辑弹窗与干预弹窗；写入后详情按新代次重读，避免继续展示旧 revision。 */
function usePlanOverlays(reload: () => void, deleted: (ids: string[]) => void) {
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Editing>();
  const [intervention, setIntervention] = useState<{ kind: InterventionKind; rows: PlanSummary[] }>();
  const refresh = () => {
    setVersion((value) => value + 1);
    reload();
  };
  const intervene = (kind: InterventionKind, rows: PlanSummary[]) => setIntervention({ kind, rows });
  const element = (
    <>
      {editing && <PlanForm plan={editing.plan} close={() => setEditing(undefined)} saved={refresh} />}
      {intervention && (
        <Intervention
          kind={intervention.kind}
          rows={intervention.rows}
          onClose={() => setIntervention(undefined)}
          done={() => {
            refresh();
            if (intervention.kind === 'delete') deleted(intervention.rows.map((row) => row.id));
          }}
        />
      )}
    </>
  );
  return {
    version,
    edit: (plan: PlanSummary) => setEditing({ plan }),
    create: () => setEditing({}),
    intervene,
    refresh,
    element,
  };
}

function SelectionActions({
  view,
  rows,
  can,
  intervene,
}: {
  view: PlanView;
  rows: PlanSummary[];
  can(action: PlanAction): boolean;
  intervene(kind: InterventionKind): void;
}) {
  if (view === 'terminated')
    return (
      <Tooltip title={t.restartPending}>
        <Button disabled>{t.actions.restart}</Button>
      </Tooltip>
    );
  if (view !== 'active') return null;
  const menu = (['urge', 'jump', 'startNext', 'terminate'] as const).filter(can);
  const single = rows.length === 1;
  return (
    <Space>
      {can('start') && (
        <Tooltip title={single ? undefined : t.selectOne}>
          <Button disabled={!single || rows[0]?.status !== 'not_started'} onClick={() => intervene('start')}>
            {t.actions.start}
          </Button>
        </Tooltip>
      )}
      {menu.length > 0 && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: menu.map((key) => ({
              key,
              label: t.actions[key],
              disabled: key === 'jump' && !single,
            })),
            onClick: ({ key }) => intervene(key as InterventionKind),
          }}
        >
          <Button>{t.actions.intervene} ▾</Button>
        </Dropdown>
      )}
    </Space>
  );
}

function columns(
  field: (name: string) => { visible: boolean },
  employees: (id: string | null | undefined) => string,
  open: (id: string) => void,
): TableColumnsType<PlanSummary> {
  const cell = (key: string, title: string, render: (row: PlanSummary) => ReactNode, width = 130) => ({
    key,
    title,
    width,
    ellipsis: true,
    render: (_: unknown, row: PlanSummary) => render(row),
  });
  const all = [
    // 列顺序按原站：名称、姓名、邮箱…
    field('name').visible &&
      cell(
        'name',
        t.fields.planName,
        (row) => (
          <Button type="link" onClick={() => open(row.id)}>
            {display(row.name)}
          </Button>
        ),
        200,
      ),
    field('employeeId').visible && cell('employeeId', t.fields.employeeId, (row) => employees(row.employeeId), 120),
    // 邮箱、部门、下个阶段开启方式：计划列表接口未提供，如实显示 --（后端缺口清单）
    cell('email', t.fields.email, () => t.noValue, 160),
    field('tutorRole').visible &&
      cell('tutorRole', t.fields.tutorRole, (row) => t.tutorRoles[row.tutorRole ?? ''] ?? t.noValue),
    field('tutorEmployeeId').visible &&
      cell('tutorEmployeeId', t.fields.tutorEmployeeId, (row) => employees(row.tutorEmployeeId)),
    // 状态列始终保留：字段被裁剪时按“无权查看”展示，记录不因此消失（DEC-431①）
    cell('status', t.fields.status, (row) => statusText(t.status, row.status), 90),
    cell('currentStageName', t.fields.currentStageName, (row) => display(row.currentStageName)),
    cell('currentNodeName', t.fields.currentNodeName, (row) => display(row.currentNodeName)),
    cell('nextStage', t.fields.nextStage, (row) => display(nextStage(row.stages ?? [])?.name)),
    cell('nextStartMode', t.fields.nextStartMode, () => t.noValue, 140),
    (field('startDate').visible || field('endDate').visible) &&
      cell('period', t.fields.period, (row) => period(row.startDate, row.endDate), 190),
  ];
  return all.filter((column) => !!column) as TableColumnsType<PlanSummary>;
}

/** 名称快速搜索 + 500 宽高级筛选抽屉（姓名、指导人、当前阶段、状态、指导人角色、起止日期）；日期是租户业务日期字符串。 */
function PlanFilterBar({ value, change, visible, stages }: FilterProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState(false);
  const apply = () => {
    if (draft.startFrom && draft.endTo && draft.endTo < draft.startFrom) return setError(true);
    setError(false);
    change(draft);
    setOpen(false);
  };
  return (
    <Space wrap>
      {visible('name') && <NameSearch value={value.name} change={(name) => change({ ...value, name })} />}
      <Button
        type="text"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        {t.actions.filter}
      </Button>
      <FilterDrawer
        open={open}
        onClose={() => setOpen(false)}
        onClear={() => setDraft({ name: value.name })}
        onApply={apply}
      >
        {error && <Alert type="error" showIcon message={t.dateOrder} />}
        <PlanFilterFields value={draft} change={setDraft} visible={visible} stages={stages} />
      </FilterDrawer>
    </Space>
  );
}

interface FilterProps {
  value: PlanFilters;
  change(value: PlanFilters): void;
  visible(field: string): boolean;
  /** 当前阶段候选：取自已读取的授权结果（后端没有阶段目录接口）。 */
  stages: string[];
}
const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([key, label]) => ({ value: key, label }));

function PlanFilterFields({ value: draft, change: setDraft, visible, stages }: FilterProps) {
  return (
    <Form layout="vertical">
      {visible('employeeId') && (
        <Form.Item label={t.fields.employeeId} htmlFor="idp-filter-employee">
          <EmployeeSelect
            id="idp-filter-employee"
            value={draft.employeeId}
            onChange={(employeeId) => setDraft({ ...draft, employeeId: employeeId ?? undefined })}
          />
        </Form.Item>
      )}
      {visible('tutorEmployeeId') && (
        <Form.Item label={t.fields.tutorEmployeeId} htmlFor="idp-filter-tutor">
          <EmployeeSelect
            id="idp-filter-tutor"
            value={draft.tutorEmployeeId}
            onChange={(tutorEmployeeId) => setDraft({ ...draft, tutorEmployeeId: tutorEmployeeId ?? undefined })}
          />
        </Form.Item>
      )}
      {visible('currentStageName') && (
        <Form.Item label={t.fields.currentStageName}>
          <Select
            allowClear
            value={draft.currentStageName}
            options={stages.map((name) => ({ value: name, label: name }))}
            onChange={(currentStageName) => setDraft({ ...draft, currentStageName })}
          />
        </Form.Item>
      )}
      {visible('status') && (
        <Form.Item label={t.fields.status}>
          <Select
            allowClear
            value={draft.status}
            options={options(t.status)}
            onChange={(status) => setDraft({ ...draft, status })}
          />
        </Form.Item>
      )}
      {visible('tutorRole') && (
        <Form.Item label={t.fields.tutorRole}>
          <Select
            allowClear
            value={draft.tutorRole}
            options={options(t.tutorRoles)}
            onChange={(tutorRole) => setDraft({ ...draft, tutorRole })}
          />
        </Form.Item>
      )}
      {visible('startDate') && (
        <Form.Item label={t.startFrom}>
          <TenantDatePicker
            value={draft.startFrom}
            onChange={(date) => setDraft({ ...draft, startFrom: date ?? undefined })}
          />
        </Form.Item>
      )}
      {visible('endDate') && (
        <Form.Item label={t.endTo}>
          <TenantDatePicker value={draft.endTo} onChange={(date) => setDraft({ ...draft, endTo: date ?? undefined })} />
        </Form.Item>
      )}
    </Form>
  );
}
