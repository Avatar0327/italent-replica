import { Button, Dropdown, Empty, Popconfirm, Popover, Select, Space, Switch, Tag } from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Failure, RemoteSelect, useRead, useWriter } from '../evaluation/runtime.js';
import { ui } from '../foundation/messages.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { AssignDialog, depthOptions, ORG_OBJECT, PositionFilter } from './MapForms.js';
import { s } from './messages.js';
import { targetPaths } from './RecordForm.js';
import { ReadinessTag } from './RecordList.js';
import { BASE, mapForest, orgMapItems, type MapNode } from './rules.js';
import type { LevelResult, MapItem, MapResult } from './types.js';

export const MAP = 'Succession.Map';
type Kind = 'position' | 'org';
const result = { position: 'Succession.RiskResult', org: 'Succession.HealthResult' } as const;
// 组织地图里的关键职位卡取职位风险等级（接口 keyPositions[].risk）。
const levelOf = (item: MapItem, kind: Kind) => (kind === 'position' || item.keyPosition ? item.risk : item.health);
const percent = (value?: number | null) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : s.none);

/** 地图只读服务端结果：层级、风险 / 健康度、统计都不在前端推算（docs/02_业务建模/27 §5.7、§5.8）。 */
export function SuccessionMap({ kind }: { kind: Kind }) {
  const [depth, setDepth] = useState(3);
  const [expanded, setExpanded] = useState(false);
  const [info, setInfo] = useState(true);
  const [root, setRoot] = useState<string>();
  const [assigning, setAssigning] = useState<MapItem>();
  const orgRoot = usePermissions(ORG_OBJECT).field('name').visible;
  const path = kind === 'position' ? `${BASE}/maps/position` : orgMapPath(depth, root);
  const map = useRead<MapResult>(path);
  const items = kind === 'org' ? orgMapItems(map.data?.items ?? []) : (map.data?.items ?? []);
  // 原站左侧是筛选，右侧是图例 / 展开 / 显示信息 / 设置 / 更多操作（UI2 对照）。
  const toolbar = (
    <div className="succession-toolbar">
      <Space wrap>
        {kind === 'position' ? (
          <PositionFilter saved={map.reload} />
        ) : (
          <>
            {/* 组织根：能读组织名称才给选择入口（接口 root 参数；无权时只看服务端默认根）。 */}
            {orgRoot && (
              <label className="succession-filter">
                <span>{s.map.root}</span>
                <RemoteSelect path={targetPaths.org} label={s.map.root} value={root} onChange={pickRoot(setRoot)} />
              </label>
            )}
            <label className="succession-filter">
              <span>{s.map.orgDepth}</span>
              <Select aria-label={s.map.orgDepth} value={depth} onChange={setDepth} options={depthOptions} />
            </label>
          </>
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
      <MapCanvas>
        <ul>
          {mapForest(items).map((node) => (
            <Branch key={node.item.id} node={node} kind={kind} expanded={expanded} info={info} assign={setAssigning} />
          ))}
        </ul>
      </MapCanvas>
    );
  return (
    <section className="list-card succession-map">
      {toolbar}
      {body}
      {assigning && (
        <AssignDialog
          kind={kind}
          item={assigning}
          mapPath={path}
          close={() => setAssigning(undefined)}
          saved={() => (setAssigning(undefined), map.reload())}
        />
      )}
    </section>
  );
}

function Branch(props: {
  node: MapNode<MapItem>;
  child?: boolean;
  kind: Kind;
  expanded: boolean;
  info: boolean;
  assign(item: MapItem): void;
}) {
  // 根节点的上级可能在可见范围外（parentId 非空），连线只画在画布内的父子之间。
  const { node, child, ...rest } = props;
  return (
    <li>
      {child && <span className="succession-link" aria-hidden />}
      <MapCard item={node.item} {...rest} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((entry) => (
            <Branch key={entry.item.id} node={entry} child {...rest} />
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
  const names = item.incumbents?.map((person) => person.name).join('、');
  // 关键职位卡只读：赋值入口在职位地图上，这里不重复（同一结果行两处改易冲突）。
  const canAssign = !item.keyPosition && permission.can('assign');
  const position = kind === 'position' || item.keyPosition;
  return (
    <article
      className="succession-card"
      aria-label={item.name}
      style={{ borderTopColor: level?.levelColor ?? undefined }}
    >
      <header>
        <strong>{item.name}</strong>
        {canAssign && (
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
      {item.keyPosition && <Tag>{s.map.keyPosition}</Tag>}
      {level?.levelName && <Tag color={level.levelColor ?? undefined}>{level.levelName}</Tag>}
      {info && position && item.incumbents && <p>{names ? `${s.fields.incumbents}：${names}` : s.map.vacant}</p>}
      {info && !position && (
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

/** 原站画布：自上而下排布，父子之间画连线，可缩放（0.5～2 倍，步长 0.1）。 */
function MapCanvas({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1);
  const zoom = (step: number) => setScale((value) => Math.min(2, Math.max(0.5, Math.round((value + step) * 10) / 10)));
  return (
    <div className="succession-canvas">
      <Space className="succession-zoom">
        <Button size="small" onClick={() => zoom(-0.1)}>
          {s.map.zoomOut}
        </Button>
        <Button size="small" onClick={() => zoom(0.1)}>
          {s.map.zoomIn}
        </Button>
        <Button size="small" onClick={() => setScale(1)}>
          {s.map.zoomReset}
        </Button>
      </Space>
      <div className="succession-canvas-content" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

function orgMapPath(depth: number, root?: string) {
  const query = new URLSearchParams({ depth: String(depth) });
  if (root) query.set('root', root);
  return `${BASE}/maps/org?${query}`;
}
const pickRoot = (set: (value?: string) => void) => (value: string | string[]) =>
  set(typeof value === 'string' && value ? value : undefined);

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
