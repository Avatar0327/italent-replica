import { Alert, Button, Dropdown, Form, Select, Space, Tooltip, type TableColumnsType } from 'antd';
import { useMemo, useState, type Key, type ReactNode } from 'react';
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
  type PlanAction,
  type PlanFilters,
  type PlanView,
} from './model.js';
import { PlanDetailDrawer } from './PlanDetail.js';
import { PlanForm } from './PlanForm.js';
import type { PlanSummary } from './types.js';
import { useNames } from './useNames.js';

const VIEW_LABELS: Record<PlanView, string> = {
  active: t.views.active,
  ended: t.views.ended,
  terminated: t.views.terminated,
};
type Editing = { plan?: PlanSummary } | undefined;

export function PlanList() {
  const permission = usePermissions(OBJECTS.plan);
  const list = useCollection<PlanSummary>(`${IDP_API}/plans`);
  const [view, setView] = useState<PlanView>('active');
  const [filters, setFilters] = useState<PlanFilters>({});
  const [selected, setSelected] = useState<{ keys: Key[]; rows: PlanSummary[] }>({ keys: [], rows: [] });
  const can = (action: PlanAction) => permission.can(action, BUTTON_LEVEL[action]);
  const rows = useMemo(() => filterPlans(list.items ?? [], view, filters), [list.items, view, filters]);
  const paging = useLocalPage(rows, list.loading);
  const employees = useNames(
    'employee',
    paging.shown.flatMap((row) => [row.employeeId, row.tutorEmployeeId]),
  );
  const clearSelection = () => setSelected({ keys: [], rows: [] });
  const overlays = usePlanOverlays(can, () => {
    clearSelection();
    list.reload();
  });
  const restart = () => {
    paging.first();
    clearSelection();
  };
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
        columns={columns(permission.field, employees, overlays.open)}
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
          onChange: (keys, picked) => setSelected({ keys, rows: picked }),
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
      {overlays.element}
    </>
  );
}

/** 详情抽屉、新增 / 编辑表单与干预弹窗；写入后详情按新代次重读，避免抽屉继续展示旧 revision。 */
function usePlanOverlays(can: (action: PlanAction) => boolean, reload: () => void) {
  const [openId, setOpenId] = useState<string>();
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
      {openId && (
        <PlanDetailDrawer
          key={`${openId}/${version}`}
          id={openId}
          onClose={() => setOpenId(undefined)}
          can={can}
          edit={(plan) => setEditing({ plan })}
          intervene={(kind, plan) => intervene(kind, [plan])}
        />
      )}
      {editing && <PlanForm plan={editing.plan} close={() => setEditing(undefined)} saved={refresh} />}
      {intervention && (
        <Intervention
          kind={intervention.kind}
          rows={intervention.rows}
          onClose={() => setIntervention(undefined)}
          done={() => {
            refresh();
            if (intervention.kind === 'delete') setOpenId(undefined);
          }}
        />
      )}
    </>
  );
  return { open: setOpenId, create: () => setEditing({}), intervene, refresh, element };
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
    field('status').visible && cell('status', t.fields.status, (row) => t.status[row.status ?? ''] ?? t.noValue, 90),
    cell('currentStageName', t.fields.currentStageName, (row) => display(row.currentStageName)),
    cell('currentNodeName', t.fields.currentNodeName, (row) => display(row.currentNodeName)),
    cell('nextStage', t.fields.nextStage, (row) => display(nextStage(row.stages ?? [])?.name)),
    cell('nextStartMode', t.fields.nextStartMode, () => t.noValue, 140),
    (field('startDate').visible || field('endDate').visible) &&
      cell('period', t.fields.period, (row) => period(row.startDate, row.endDate), 190),
  ];
  return all.filter((column) => !!column) as TableColumnsType<PlanSummary>;
}

/** 名称快速搜索 + 500 宽高级筛选抽屉（状态、指导人角色、起止日期）；日期是租户业务日期字符串。 */
function PlanFilterBar({ value, change, visible }: FilterProps) {
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
        <PlanFilterFields value={draft} change={setDraft} visible={visible} />
      </FilterDrawer>
    </Space>
  );
}

interface FilterProps {
  value: PlanFilters;
  change(value: PlanFilters): void;
  visible(field: string): boolean;
}
const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([key, label]) => ({ value: key, label }));

function PlanFilterFields({ value: draft, change: setDraft, visible }: FilterProps) {
  return (
    <Form layout="vertical">
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
