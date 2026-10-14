import { Tabs } from 'antd';
import { useState } from 'react';
import { CreateCommands } from '../evaluation/CreateEntry.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
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
        <Tabs activeKey={active} onChange={setSelected} items={items} />
        {active?.endsWith('List') && <DecisionNote id="succession-lists" />}
        {active?.endsWith('Map') && <DecisionNote id="succession-maps" />}
        {!active ? (
          <PageState kind={loading ? 'loading' : 'forbidden'} />
        ) : active.endsWith('List') ? (
          <RecordList
            key={scope}
            type={active === 'orgList' ? 'org' : 'position'}
            title={s.tabs[active as 'orgList']}
          />
        ) : (
          <SuccessionMap key={scope} kind={active === 'orgMap' ? 'org' : 'position'} />
        )}
      </div>
    </CreateCommands>
  );
}
