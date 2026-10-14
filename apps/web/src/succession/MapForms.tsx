import { Button, Radio, Select } from 'antd';
import { useState } from 'react';
import { RemoteSelect, Failure, useRead } from '../evaluation/runtime.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { ui } from '../foundation/messages.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { s } from './messages.js';
import { targetPaths } from './RecordForm.js';
import {
  assignBody,
  assignLatest,
  assignValues,
  BASE,
  preferenceLatest,
  preferenceReceipt,
  PREFS_RECEIPT,
} from './rules.js';
import type { LevelOption, ListResult, MapItem, MapResult, Preferences } from './types.js';

type Kind = 'position' | 'org';
export const ORG_OBJECT = 'TenantBase.Organization';
const result = { position: 'Succession.RiskResult', org: 'Succession.HealthResult' } as const;
export const depthOptions = [2, 3, 4].map((value) => ({ value, label: s.map.depthLabels[value] }));
const editableNames = (fields: FormField[]) =>
  fields.filter((field) => field.access.visible && field.access.editable).map((field) => field.name);

/**
 * Q-M0-178：按规则计算发 levelId=null；手动赋值从启用等级中选；版本取结果行，未评定时为 0。
 * 编辑权只看结果对象 levelId 的 editableFields；赋值方式不是接口字段，跟随 levelId。
 */
export function AssignDialog(props: { kind: Kind; item: MapItem; mapPath: string; close(): void; saved(): void }) {
  const { kind, item } = props;
  const api = useApiClient();
  const permission = usePermissions(result[kind]);
  const segment = kind === 'position' ? 'risk' : 'health';
  const path = `${BASE}/${segment}-results/${item.id}`;
  const submission = useCommandForm(path);
  const options = useRead<ListResult<LevelOption>>(`${BASE}/${segment}-levels/options`);
  const current = kind === 'position' ? item.risk : item.health;
  const baseline = assignValues(current?.levelId);
  const access = permission.field('levelId');
  const modes = [
    { value: 'rule', label: s.assign.rule },
    { value: 'manual', label: s.assign.manual },
  ];
  const fields: FormField[] = [
    {
      name: 'mode',
      label: s.assign.mode,
      access,
      control: <Radio.Group options={modes} />,
      display: modes.find((mode) => mode.value === baseline.mode)?.label,
    },
    {
      name: 'levelId',
      label: kind === 'position' ? s.assign.riskLevel : s.assign.healthLevel,
      access,
      control: (
        <Select
          allowClear
          loading={options.loading}
          options={(options.data?.items ?? []).map((level) => ({ value: level.id, label: level.name }))}
        />
      ),
      display: current?.levelName ?? s.map.noLevel,
    },
  ];
  // 没有单条读取接口：冲突后重读整张地图，按节点取结果行（重读 → 核对差异 → 继续编辑）。
  const reload = () =>
    submission.reread(async () => assignLatest(await api.request<MapResult>(props.mapPath), item.id, kind));
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={path}
      submission={{ ...submission, reload }}
      title={kind === 'position' ? s.map.assignRisk : s.map.assignHealth}
      initialValues={baseline}
      groups={[{ title: item.name, fields }]}
      onClose={props.close}
      onSubmit={async (values) => {
        const editableFields = editableNames(fields);
        if (!editableFields.length) throw new Error(s.errors.readonly);
        const outcome = await submission.submit({
          values,
          baseline,
          editableFields,
          revision: current?.revision ?? 0,
          businessId: item.id,
          send: (request) => {
            const body = assignBody(request.body.mode as 'rule' | 'manual', request.body.levelId as string | undefined);
            return api.request(path, { method: 'PUT', command: { ...request, body } });
          },
        });
        if (outcome.status !== 'done') throw outcome.error ?? new Error(ui.failed);
        submission.clear();
        props.saved();
      }}
    />
  );
}

const PREFS_PATH = `${BASE}/maps/position/preferences`;
/**
 * 职位地图筛选是个人偏好（PUT 整份 + 版本）：原站左侧显示当前条件，“高级筛选”在右侧抽屉里改。
 * 偏好不是对象字段、没有 editableFields：能读地图即可改自己的偏好（服务端同口径）；组织根还要能读组织名称。
 * 回执不带 id，按真实形状核对（rules.ts preferenceReceipt）。
 */
export function PositionFilter({ saved }: { saved(): void }) {
  const api = useApiClient();
  const org = usePermissions(ORG_OBJECT);
  const [open, setOpen] = useState(false);
  const prefs = useRead<Preferences>(PREFS_PATH);
  const submission = useCommandForm(PREFS_PATH);
  const access = { visible: true, editable: true };
  const yesNo = (value?: boolean) => (value ? s.settings.yes : s.settings.no);
  const fields: FormField[] = [
    {
      name: 'rootOrgId',
      label: s.map.root,
      access: org.field('name').visible ? access : { visible: false, editable: false },
      control: <RemoteSelect path={targetPaths.org} label={s.map.root} />,
    },
    {
      name: 'depth',
      label: s.map.positionDepth,
      access,
      control: <Select aria-label={s.map.positionDepth} options={depthOptions} />,
    },
    {
      name: 'showPositionsWithoutSuccessor',
      label: s.map.showWithoutSuccessor,
      access,
      control: <Radio.Group options={[true, false].map((value) => ({ value, label: yesNo(value) }))} />,
    },
  ];
  if (!prefs.data) return <Failure error={prefs.error} retry={prefs.reload} />;
  const base = prefs.data;
  const baseline = preferenceLatest(base).values;
  const reload = () => submission.reread(async () => preferenceLatest(await api.request<Preferences>(PREFS_PATH)));
  const show = () => setOpen(true);
  return (
    <>
      <Button type="text" onClick={show}>
        {`${s.map.positionDepth}：${s.map.depthLabels[base.depth] ?? base.depth}`}
      </Button>
      <Button type="text" onClick={show}>
        {`${s.map.showWithoutSuccessor}：${yesNo(base.showPositionsWithoutSuccessor)}`}
      </Button>
      <Button type="link" onClick={show}>
        {s.map.advancedFilter}
      </Button>
      <FormOverlay
        open={open}
        mode="drawer"
        recordKey={PREFS_PATH}
        submission={{ ...submission, reload }}
        title={s.map.advancedFilter}
        initialValues={baseline}
        groups={[{ title: s.map.advancedFilter, fields }]}
        onClose={() => setOpen(false)}
        onSubmit={async (values) => {
          const outcome = await submission.submit({
            values,
            baseline,
            editableFields: editableNames(fields),
            revision: base.revision,
            businessId: PREFS_RECEIPT,
            send: async (request) => {
              const body = preferenceBody(base, request.body);
              return preferenceReceipt(await api.request(PREFS_PATH, { method: 'PUT', command: { ...request, body } }));
            },
          });
          if (outcome.status !== 'done') throw outcome.error ?? new Error(ui.failed);
          submission.clear();
          // 先显式关闭：重读偏好期间本组件渲染加载态、表单随之卸载，等不到 FormOverlay 的 onClose。
          setOpen(false);
          prefs.reload();
          saved();
        }}
      />
    </>
  );
}

/** 接口要整份偏好：抽屉里没有的项（隐藏组织、只看关键岗位）按读回值原样回写，不替用户改。 */
function preferenceBody(base: Preferences, edited: Record<string, unknown>) {
  return {
    rootOrgId: 'rootOrgId' in edited ? ((edited.rootOrgId as string | undefined) ?? null) : base.rootOrgId,
    hiddenOrgIds: base.hiddenOrgIds,
    showKeyPositions: base.showKeyPositions,
    depth: Number(edited.depth ?? base.depth),
    showPositionsWithoutSuccessor: !!(edited.showPositionsWithoutSuccessor ?? base.showPositionsWithoutSuccessor),
  };
}
