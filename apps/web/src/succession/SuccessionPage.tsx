import { Tabs } from 'antd';
import { useState } from 'react';
import { CreateCommands } from '../evaluation/CreateEntry.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { MenuIcon } from '../foundation/ViewHeading.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { s } from './messages.js';
import { RECORD } from './RecordForm.js';
import { RecordList } from './RecordList.js';
import { MAP, SuccessionMap } from './SuccessionMap.js';
import './succession.css';

const tabs = [
  { key: 'positionList', object: RECORD },
  { key: 'positionMap', object: MAP },
  { key: 'orgList', object: RECORD },
  { key: 'orgMap', object: MAP },
] as const;

/** 四个页签：职位 / 组织 × 列表 / 地图；页签按权限快照里的对象显示，不写死角色。 */
function renderTab(active: string | undefined, scope: string, loading: boolean) {
  if (!active) return <PageState kind={loading ? 'loading' : 'forbidden'} />;
  const title = s.tabs[active as keyof typeof s.tabs];
  const kind = active.startsWith('org') ? 'org' : 'position';
  return active.endsWith('List') ? (
    <RecordList key={scope} type={kind} title={title} />
  ) : (
    <SuccessionMap key={scope} kind={kind} />
  );
}

export function SuccessionPage() {
  const session = useSession();
  const { snapshot, loading } = usePermissions();
  const [selected, setSelected] = useState<string>('positionList');
  const items = tabs
    .filter((tab) => !!snapshot.objects[tab.object])
    .map((tab) => ({ key: tab.key, label: s.tabs[tab.key] }));
  const active = items.some((item) => item.key === selected) ? selected : items[0]?.key;
  const scope = `${session.tenantId}/${session.identityKey}/${active}`;
  return (
    <CreateCommands>
      <div className="succession-page">
        <Tabs
          activeKey={active}
          onChange={setSelected}
          items={items}
          tabBarExtraContent={{
            // 原站页签左侧只有图标、没有视图名（UI2 对照）；页面标题挂在这里。
            left: (
              <h1 className="page-view-heading succession-heading" aria-label={s.menu.manage}>
                <span className="page-view-icon">
                  <MenuIcon />
                </span>
              </h1>
            ),
          }}
        />
        {active?.endsWith('List') && <DecisionNote id="succession-lists" />}
        {active?.endsWith('Map') && <DecisionNote id="succession-maps" />}
        {renderTab(active, scope, loading)}
      </div>
    </CreateCommands>
  );
}
