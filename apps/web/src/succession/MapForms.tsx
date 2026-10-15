import { Button, Radio, Select } from 'antd';
import { useState } from 'react';
import { RemoteSelect, Failure, useRead } from '../evaluation/runtime.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { s } from './messages.js';
import { targetPaths } from './RecordForm.js';
import {
  assignBody,
  assignLatest,
  assignValues,
  BASE,
  preferenceBody,
  preferenceLatest,
  preferenceReceipt,
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
  const results = `${BASE}/${segment}-results`;
  const path = `${results}/${item.id}`;
  const options = useRead<ListResult<LevelOption>>(`${BASE}/${segment}-levels/options`);
  const current = kind === 'position' ? item.risk : item.health;
  const baseline = assignValues(current?.levelId);
  // 没有单条读取接口：冲突后重读整张地图，按节点取结果行（重读 → 核对差异 → 继续编辑）。
  const writer = useConflictCommand(
    results,
    { id: item.id, revision: current?.revision ?? 0, values: baseline },
    async () => assignLatest(await api.request<MapResult>(props.mapPath), item.id, kind),
  );
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
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={path}
      submission={writer.form}
      title={kind === 'position' ? s.map.assignRisk : s.map.assignHealth}
      initialValues={baseline}
      groups={[{ title: item.name, fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新地图回查，重开即按新版本解锁。
        if (writer.stale) props.saved();
        props.close();
      }}
      onSubmit={async (values) => {
        const editableFields = editableNames(fields);
        if (!editableFields.length) throw new Error(s.errors.readonly);
        // 赋值方式与等级是一组：两项都在表单里，按当前表单值组装（手动未选等级时本地即报错）。
        const merged = { ...writer.full, ...values };
        const mode = merged.mode as 'rule' | 'manual';
        const levelId = merged.levelId as string | undefined;
        if (mode === 'manual' && !levelId) throw new Error(s.errors.levelRequired);
        const body = assignBody(mode, levelId);
        await writer.run({
          values,
          editableFields,
          send: ({ command }) => api.request(path, { method: 'PUT', command: { ...command, body } }),
        });
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
  const [open, setOpen] = useState(false);
  const prefs = useRead<Preferences>(PREFS_PATH);
  if (!prefs.data) return <Failure error={prefs.error} retry={prefs.reload} />;
  const view = prefs.data;
  const show = () => setOpen(true);
  return (
    <>
      <Button type="text" onClick={show}>
        {`${s.map.positionDepth}：${s.map.depthLabels[view.depth] ?? view.depth}`}
      </Button>
      <Button type="text" onClick={show}>
        {`${s.map.showWithoutSuccessor}：${yesNo(view.showPositionsWithoutSuccessor)}`}
      </Button>
      <Button type="link" onClick={show}>
        {s.map.advancedFilter}
      </Button>
      <PreferenceDrawer
        view={view}
        open={open}
        close={(changed) => {
          // 先显式关闭：重读偏好期间本组件渲染加载态、表单随之卸载，等不到 FormOverlay 的 onClose。
          setOpen(false);
          if (!changed) return;
          prefs.reload();
          saved();
        }}
      />
    </>
  );
}
const yesNo = (value?: boolean) => (value ? s.settings.yes : s.settings.no);

/**
 * 偏好抽屉：快照是读回的整份偏好（含抽屉外的隐藏组织、只看关键岗位），冲突重读后取最新整份，
 * 提交时只有用户改过的项取表单值（rules.ts preferenceBody）。冲突后直接关闭也会重读偏好，重开即按新版本解锁。
 */
function PreferenceDrawer({ view, open, close }: { view: Preferences; open: boolean; close(changed: boolean): void }) {
  const api = useApiClient();
  const org = usePermissions(ORG_OBJECT);
  const current = preferenceLatest(view);
  const writer = useConflictCommand(PREFS_PATH, current, async () =>
    preferenceLatest(await api.request<Preferences>(PREFS_PATH)),
  );
  const access = { visible: true, editable: true };
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
  return (
    <FormOverlay
      open={open}
      mode="drawer"
      recordKey={PREFS_PATH}
      submission={writer.form}
      title={s.map.advancedFilter}
      initialValues={current.values}
      groups={[{ title: s.map.advancedFilter, fields }]}
      onClose={() => close(writer.stale)}
      onSubmit={async (values) => {
        await writer.run({
          values,
          editableFields: editableNames(fields),
          send: async ({ edited, command }) => {
            const body = preferenceBody(writer.full, edited);
            return preferenceReceipt(await api.request(PREFS_PATH, { method: 'PUT', command: { ...command, body } }));
          },
        });
        close(true);
      }}
    />
  );
}
