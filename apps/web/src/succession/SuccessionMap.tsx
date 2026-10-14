import { Button, Dropdown, Empty, Popconfirm, Popover, Radio, Select, Space, Switch, Tag } from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Failure, useRead, useWriter } from '../evaluation/runtime.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { ui } from '../foundation/messages.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { s } from './messages.js';
import { ReadinessTag } from './RecordList.js';
import { assignBody, BASE, mapForest, type MapNode } from './rules.js';
import type { LevelOption, LevelResult, ListResult, MapItem, MapResult, Preferences } from './types.js';

export const MAP = 'Succession.Map';
type Kind = 'position' | 'org';
const result = { position: 'Succession.RiskResult', org: 'Succession.HealthResult' } as const;
const levelOf = (item: MapItem, kind: Kind) => (kind === 'position' ? item.risk : item.health);
const depthOptions = [2, 3, 4].map((value) => ({ value, label: s.map.depthLabels[value] }));
const percent = (value?: number | null) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : s.none);

/** 地图只读服务端结果：层级、风险 / 健康度、统计都不在前端推算（docs/02_业务建模/27 §5.7、§5.8）。 */
export function SuccessionMap({ kind }: { kind: Kind }) {
  const [depth, setDepth] = useState(3);
  const [expanded, setExpanded] = useState(false);
  const [info, setInfo] = useState(true);
  const [assigning, setAssigning] = useState<MapItem>();
  const path = kind === 'position' ? `${BASE}/maps/position` : `${BASE}/maps/org?depth=${depth}`;
  const map = useRead<MapResult>(path);
  const items = map.data?.items ?? [];
  // 原站左侧是筛选，右侧是图例 / 展开 / 显示信息 / 设置 / 更多操作（UI2 对照）。
  const toolbar = (
    <div className="succession-toolbar">
      <Space wrap>
        {kind === 'position' ? (
          <PositionFilter saved={map.reload} />
        ) : (
          <label className="succession-filter">
            <span>{s.map.orgDepth}</span>
            <Select aria-label={s.map.orgDepth} value={depth} onChange={setDepth} options={depthOptions} />
          </label>
        )}
      </Space>
      <Space wrap>
        {map.data?.asOf && <span className="succession-muted">{s.map.asOf(map.data.asOf)}</span>}
        <Legend items={items} kind={kind} />
        <Button onClick={() => setExpanded(!expanded)}>{expanded ? s.map.collapse : s.map.expand}</Button>
        <label className="succession-switch">
          <Switch size="small" checked={info} onChange={setInfo} aria-label={s.map.showInfo} />
          {s.map.showInfo}
        </label>
        <SettingsMenu />
        <ComputeMenu kind={kind} done={map.reload} />
      </Space>
    </div>
  );
  let body: ReactNode;
  if (map.error) body = <Failure error={map.error} retry={map.reload} />;
  else if (map.loading) body = <PageState kind="loading" />;
  else if (map.data?.hasDataPermission === false) body = <Empty description={ui.noScope} />;
  else if (items.length === 0) body = <Empty description={ui.empty} />;
  else
    body = (
      <ul className="succession-tree">
        {mapForest(items).map((node) => (
          <Branch key={node.item.id} node={node} kind={kind} expanded={expanded} info={info} assign={setAssigning} />
        ))}
      </ul>
    );
  return (
    <section className="list-card succession-map">
      {toolbar}
      {body}
      {assigning && (
        <AssignDialog
          kind={kind}
          item={assigning}
          close={() => setAssigning(undefined)}
          saved={() => (setAssigning(undefined), map.reload())}
        />
      )}
    </section>
  );
}

function Branch(props: {
  node: MapNode<MapItem>;
  kind: Kind;
  expanded: boolean;
  info: boolean;
  assign(item: MapItem): void;
}) {
  const { node, ...rest } = props;
  return (
    <li>
      <MapCard item={node.item} {...rest} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <Branch key={child.item.id} node={child} {...rest} />
          ))}
        </ul>
      )}
    </li>
  );
}

function MapCard({
  item,
  kind,
  expanded,
  info,
  assign,
}: {
  item: MapItem;
  kind: Kind;
  expanded: boolean;
  info: boolean;
  assign(item: MapItem): void;
}) {
  const permission = usePermissions(result[kind]);
  const level = levelOf(item, kind);
  // 人数只取服务端字段：successorCount 被隐藏时不能用名单长度补算（字段权限）。
  const count = item.successorCount;
  const showSuccessors = (expanded || kind === 'org') && !!item.successors?.length;
  return (
    <article
      className="succession-card"
      aria-label={item.name}
      style={{ borderTopColor: level?.levelColor ?? undefined }}
    >
      <header>
        <strong>{item.name}</strong>
        {permission.can('assign') && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [{ key: 'assign', label: kind === 'position' ? s.map.assignRisk : s.map.assignHealth }],
              onClick: () => assign(item),
            }}
          >
            <Button type="text" size="small" aria-label={s.map.cardActions}>
              ⋮
            </Button>
          </Dropdown>
        )}
      </header>
      {level?.levelName && <Tag color={level.levelColor ?? undefined}>{level.levelName}</Tag>}
      {info && kind === 'position' && item.incumbents && (
        <p>{item.incumbents.length ? s.map.incumbents(item.incumbents.length) : s.map.vacant}</p>
      )}
      {info && kind === 'org' && (
        <dl className="succession-stats">
          <dt>{s.fields.personInCharge}</dt>
          <dd>{item.personInCharge?.name ?? s.none}</dd>
          <dt>{s.map.greenRate}</dt>
          <dd>{percent(item.stats?.greenRate)}</dd>
          <dt>{s.map.onDuty}</dt>
          <dd>{item.stats?.onDutyCount ?? s.none}</dd>
          <dt>{s.map.capacity}</dt>
          <dd>{item.stats?.capacity ?? s.none}</dd>
        </dl>
      )}
      {count !== undefined && <p className="succession-muted">{s.map.successors(count)}</p>}
      {showSuccessors && (
        <ul className="succession-successors">
          {item.successors!.map((entry) => (
            <li key={entry.id}>
              {entry.successor?.name ?? s.none} <ReadinessTag value={entry.readiness} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function Legend({ items, kind }: { items: MapItem[]; kind: Kind }) {
  const levels = new Map<string, LevelResult>();
  for (const item of items) {
    const level = levelOf(item, kind);
    if (level?.levelName) levels.set(level.levelName, level);
  }
  const content = levels.size ? (
    <Space direction="vertical">
      {[...levels.values()].map((level) => (
        <Tag key={level.levelName} color={level.levelColor ?? undefined}>
          {level.levelName}
        </Tag>
      ))}
    </Space>
  ) : (
    s.map.noLegend
  );
  return (
    <Popover trigger="click" content={content}>
      <Button>{s.map.legend}</Button>
    </Popover>
  );
}

function SettingsMenu() {
  const { menus } = usePermissions();
  const navigate = useNavigate();
  const paths = new Set(menus.flatMap((menu) => menu.children ?? []).map((menu) => menu.path));
  const items = [
    { key: '/succession/settings/readiness', label: s.map.settingsReadiness },
    { key: '/succession/settings/map', label: s.map.settingsRisk },
  ].filter((item) => paths.has(item.key));
  return items.length ? (
    <Dropdown trigger={['click']} menu={{ items, onClick: ({ key }) => void navigate(key) }}>
      <Button>{s.map.settings}</Button>
    </Dropdown>
  ) : null;
}

/** 计算是后台任务（202）：只负责触发，结果靠刷新地图读取。 */
function ComputeMenu({ kind, done }: { kind: Kind; done(): void }) {
  const permission = usePermissions(MAP);
  const writer = useWriter(done);
  const [action, setAction] = useState<{ key: string; label: string; path: string }>();
  const [started, setStarted] = useState(false);
  const actions = (
    kind === 'position'
      ? [{ key: 'computeRisk', label: s.map.computeRisk, path: `${BASE}/maps/position/compute-risk` }]
      : [
          { key: 'computeHealth', label: s.map.computeHealth, path: `${BASE}/maps/org/compute-health` },
          { key: 'computeStats', label: s.map.computeStats, path: `${BASE}/maps/org/compute-stats` },
        ]
  ).filter((item) => permission.can(item.key, 'list'));
  if (!actions.length) return null;
  const run = async () => {
    if (!action) return;
    setStarted(false);
    try {
      await writer.write(action.path, 'POST', {}, 0);
      setStarted(true);
    } catch {
      // 失败由 writer.error 在下方 Failure 中提示。
    } finally {
      setAction(undefined);
    }
  };
  return (
    <>
      <Popconfirm open={!!action} title={s.map.computeConfirm} onConfirm={run} onCancel={() => setAction(undefined)}>
        <Dropdown
          trigger={['click']}
          menu={{ items: actions, onClick: ({ key }) => setAction(actions.find((item) => item.key === key)) }}
        >
          <Button loading={writer.busy}>{s.map.more}</Button>
        </Dropdown>
      </Popconfirm>
      {started && <Tag color="blue">{s.map.computeStarted}</Tag>}
      <Failure error={writer.error} />
    </>
  );
}

/** Q-M0-178：按规则计算发 levelId=null；手动赋值从启用等级中选；版本取结果行，未评定时为 0。 */
function AssignDialog({ kind, item, close, saved }: { kind: Kind; item: MapItem; close(): void; saved(): void }) {
  const api = useApiClient();
  const permission = usePermissions(result[kind]);
  const segment = kind === 'position' ? 'risk' : 'health';
  const path = `${BASE}/${segment}-results/${item.id}`;
  const submission = useCommandForm(path);
  const options = useRead<ListResult<LevelOption>>(`${BASE}/${segment}-levels/options`);
  const current = levelOf(item, kind);
  const access = { visible: true, editable: permission.can('assign') };
  const fields: FormField[] = [
    {
      name: 'mode',
      label: s.assign.mode,
      access,
      control: (
        <Radio.Group
          options={[
            { value: 'rule', label: s.assign.rule },
            { value: 'manual', label: s.assign.manual },
          ]}
        />
      ),
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
    },
  ];
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={path}
      submission={submission}
      title={kind === 'position' ? s.map.assignRisk : s.map.assignHealth}
      initialValues={{ mode: current?.levelId ? 'manual' : 'rule', levelId: current?.levelId ?? undefined }}
      groups={[{ title: item.name, fields }]}
      onClose={close}
      onSubmit={async (values) => {
        const body = assignBody(values.mode as 'rule' | 'manual', values.levelId as string | undefined);
        const outcome = await submission.submit({
          values,
          baseline: {},
          editableFields: ['mode', 'levelId'],
          revision: current?.revision ?? 0,
          businessId: item.id,
          send: (request) => api.request(path, { method: 'PUT', command: { ...request, body } }),
        });
        if (outcome.status !== 'done') throw outcome.error ?? new Error(ui.failed);
        submission.clear();
        saved();
      }}
    />
  );
}

/** 职位地图筛选是个人偏好（PUT 整份 + 版本）：原站左侧显示当前条件，“高级筛选”在右侧抽屉里改。 */
function PositionFilter({ saved }: { saved(): void }) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const prefsPath = `${BASE}/maps/position/preferences`;
  const prefs = useRead<Preferences>(prefsPath);
  const submission = useCommandForm(prefsPath);
  const access = { visible: true, editable: true };
  const yesNo = (value?: boolean) => (value ? s.settings.yes : s.settings.no);
  const fields: FormField[] = [
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
  return (
    <>
      <Button type="text" onClick={() => setOpen(true)}>
        {`${s.map.positionDepth}：${s.map.depthLabels[base.depth] ?? base.depth}`}
      </Button>
      <Button type="text" onClick={() => setOpen(true)}>
        {`${s.map.showWithoutSuccessor}：${yesNo(base.showPositionsWithoutSuccessor)}`}
      </Button>
      <Button type="link" onClick={() => setOpen(true)}>
        {s.map.advancedFilter}
      </Button>
      <FormOverlay
        open={open}
        mode="drawer"
        recordKey={prefsPath}
        submission={submission}
        title={s.map.advancedFilter}
        initialValues={{ ...base }}
        groups={[{ title: s.map.advancedFilter, fields }]}
        onClose={() => setOpen(false)}
        onSubmit={async (values) => {
          // 原站抽屉里没有“只看关键岗位”，按读回值原样回写，不替用户改。
          const { rootOrgId, hiddenOrgIds, showKeyPositions } = base;
          const body = {
            rootOrgId,
            hiddenOrgIds,
            showKeyPositions,
            depth: Number(values.depth),
            showPositionsWithoutSuccessor: !!values.showPositionsWithoutSuccessor,
          };
          const outcome = await submission.submit({
            values,
            baseline: {},
            editableFields: ['depth', 'showPositionsWithoutSuccessor'],
            revision: base.revision,
            send: (request) => api.request(prefsPath, { method: 'PUT', command: { ...request, body } }),
          });
          if (outcome.status !== 'done') throw outcome.error ?? new Error(ui.failed);
          submission.clear();
          prefs.reload();
          saved();
        }}
      />
    </>
  );
}
