import { Card, Empty, Statistic, Table, type TableColumnsType } from 'antd';
import { Link } from 'react-router';
import { ReadState, ServiceHeading } from './parts.js';
import { teamDashboardText as text } from './team-dashboard-messages.js';
import { useRead } from './useRead.js';

export const TEAM_DASHBOARD = '/api/tenant/analytics/team-dashboard';

interface Group {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}
interface BoardComponent {
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly value: number | null;
  readonly count?: number;
  readonly groups: Group[] | null;
}
interface TeamBoard {
  readonly asOf: string;
  readonly components: BoardComponent[];
}

const columns: TableColumnsType<Group> = [
  { title: text.segment, dataIndex: 'label' },
  { title: text.count, dataIndex: 'count', align: 'right' },
];

/** 团队人事看板：范围由服务端按调用者算出（本人 + 负责部门 + 汇报链），页面只展示服务端给出的数字。 */
export function TeamDashboardPage() {
  const board = useRead<TeamBoard>(TEAM_DASHBOARD);
  const find = (code: string) => board.data?.components.find((item) => item.code === code);
  const headcount = find('6.01');
  const tenure = find('6.03');
  const distribution = find('6.08');
  // 服务端只在调用者绑定了人员档案时才返回看板；在职人数为 0（如本人已离职）时不显示数字
  const hasMembers = (headcount?.value ?? 0) > 0;
  return (
    <>
      <ServiceHeading title={text.title}>
        <Link to="/manager">{text.back}</Link>
      </ServiceHeading>
      <p>{text.hint}</p>
      <ReadState state={board} />
      {board.data && !hasMembers ? <Empty description={text.empty} /> : null}
      {board.data && hasMembers ? (
        <>
          <p>
            {text.asOf}：{board.data.asOf}
          </p>
          <div className="service-counts">
            <Card title={headcount?.name ?? text.headcount}>
              <Statistic
                value={headcount?.value ?? text.noValue}
                suffix={headcount?.value == null ? '' : text.people}
              />
            </Card>
            <Card title={tenure?.name}>
              <Statistic value={tenure?.value ?? text.noValue} suffix={tenure?.value == null ? '' : text.years} />
              {tenure?.count == null ? null : (
                <small>
                  {text.tenureSamples} {tenure.count} {text.people}
                </small>
              )}
            </Card>
          </div>
          <Card title={distribution?.name}>
            <Table<Group>
              size="small"
              rowKey="key"
              pagination={false}
              columns={columns}
              dataSource={distribution?.groups ?? []}
            />
          </Card>
        </>
      ) : null}
    </>
  );
}
