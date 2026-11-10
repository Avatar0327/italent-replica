import { Button } from 'antd';
import { RemoteContent, type RemoteState } from './page-support.js';
import { chartText as t, pageText as m } from './messages.js';
import { chartFigures, type ServerOrgNode, type ServerOrgTree } from './page-model.js';
import './chart.css';

function Card({ node, onOpen }: { node: ServerOrgNode; onOpen(id: string): void }) {
  const figures = chartFigures(node);
  return (
    <div className="org-chart-card" data-enabled={node.enabled === false ? 'false' : undefined}>
      <Button type="link" className="org-chart-name" onClick={() => onOpen(node.id)}>
        {node.name ?? m.unavailable}
      </Button>
      {/* 「负责人」键缺省 = 无字段查看权，整行不出；有权限但无负责人 / 无姓名显示占位 */}
      {node.personInChargeName !== undefined && (
        <div className="org-chart-line">
          {t.head}：{node.personInChargeName ?? t.none}
        </div>
      )}
      {figures && <div className="org-chart-line">{figures}</div>}
      {node.enabled === false && <div className="org-chart-line">{t.disabled}</div>}
    </div>
  );
}

function Branch({ node, onOpen }: { node: ServerOrgNode; onOpen(id: string): void }) {
  return (
    <li>
      <Card node={node} onOpen={onOpen} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <Branch key={child.id} node={child} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 架构卡片图（R1a §2.3）：服务端按查看人范围组装的树，自上而下。缩放 / 全屏 / 导出原站行为未验证，不做。 */
export function OrgChart({ chart, onOpen }: { chart: RemoteState<ServerOrgTree>; onOpen(id: string): void }) {
  return (
    <RemoteContent state={chart}>
      {chart.data?.roots.length ? (
        <div className="org-chart" role="tree" aria-label={m.chart}>
          <ul>
            {chart.data.roots.map((root) => (
              <Branch key={root.id} node={root} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="org-chart-empty">{t.empty}</p>
      )}
    </RemoteContent>
  );
}
