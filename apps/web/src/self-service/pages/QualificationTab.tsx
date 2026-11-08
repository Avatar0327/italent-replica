import { Alert, Card, Descriptions, Empty, Table, Tag } from 'antd';
import { ApiError, PageState } from '../../foundation/index.js';
import { messages as m } from './messages.js';
import { SELF } from './model.js';
import { useRead } from './useRead.js';
import '../../talent/catalog/catalog.css';

/** GET /self-service/development-channel 的固定投影（DEC-778①；后端 employee-self-service/development-channel.ts）。 */
interface Target {
  targetId: string;
  targetName: string;
  targetValue: string | null;
  weight: number | null;
  abilities: { content: string; targetValue: string | null; weight: number | null }[];
}
interface StandardLevel {
  levelId: string;
  levelName: string;
  displayOrder: number;
  isCurrent: boolean;
  description: string | null;
  targets: Target[];
}
interface ChannelCard {
  asOf: string;
  current: { categoryName: string; levelName: string; startDate: string } | null;
  vertical: { levelId: string; levelName: string; isCurrent: boolean }[];
  horizontal: { fromLevelId: string; targetCategoryName: string; targetLevelName: string; targetLevelId: string }[];
  standard: { standardId: string; name: string; levels: StandardLevel[] } | null;
}

/** 我的档案 → 任职资格：通道图 + 各级标准卡，只读（规格 §3.5；23 §19 员工通道卡片）。 */
export function QualificationTab() {
  const card = useRead<ChannelCard>(`${SELF}/development-channel`);
  if (card.error instanceof ApiError && card.error.status === 403)
    return <Alert type="warning" showIcon message={m.qualificationPermission} />;
  if (card.error) return <PageState kind="error" error={card.error} retry={card.refresh} />;
  if (!card.data) return <PageState kind="loading" />;
  const { current, vertical, horizontal, standard } = card.data;
  if (!current) return <Empty description={m.noChannel} />;
  return (
    <div className="self-qualification">
      <Card title={m.currentQualification} extra={`${m.asOf}：${card.data.asOf}`}>
        <Descriptions
          column={3}
          items={[
            { key: 'category', label: m.qualificationCategory, children: current.categoryName },
            { key: 'level', label: m.currentLevel, children: current.levelName },
            { key: 'startDate', label: m.gotAt, children: current.startDate },
          ]}
        />
      </Card>
      <h2>{m.vertical}</h2>
      <div className="channel-path">
        {vertical.map((node) => (
          <div key={node.levelId} className={`channel-node ${node.isCurrent ? 'current' : ''}`}>
            {node.isCurrent && <Tag color="blue">{m.currentLevel}</Tag>}
            <h3>{node.levelName}</h3>
          </div>
        ))}
      </div>
      <h2>{m.horizontal}</h2>
      <div className="channel-path">
        {horizontal.map((node) => (
          <div key={`${node.fromLevelId}:${node.targetLevelId}:${node.targetCategoryName}`} className="channel-node">
            <h3>{node.targetCategoryName}</h3>
            <p>{node.targetLevelName}</p>
          </div>
        ))}
        {!horizontal.length && <Empty />}
      </div>
      <h2>{m.standardCards}</h2>
      {standard ? <StandardCards standard={standard} /> : <Empty description={m.noStandard} />}
    </div>
  );
}

function StandardCards({ standard }: { standard: NonNullable<ChannelCard['standard']> }) {
  return (
    <>
      <p className="service-muted">{standard.name}</p>
      {standard.levels.map((level) => (
        <Card
          key={level.levelId}
          className={`self-standard-card ${level.isCurrent ? 'current' : ''}`}
          title={level.levelName}
          extra={level.isCurrent && <Tag color="blue">{m.currentLevel}</Tag>}
        >
          {level.description && (
            <p>
              {m.levelDescription}：{level.description}
            </p>
          )}
          <Table<Target>
            size="small"
            pagination={false}
            rowKey="targetId"
            dataSource={level.targets}
            locale={{ emptyText: m.noStandard }}
            columns={[
              { title: m.target, dataIndex: 'targetName' },
              { title: m.targetValue, dataIndex: 'targetValue', render: (value: string | null) => value ?? m.none },
              {
                title: m.weight,
                dataIndex: 'weight',
                render: (value: number | null) => (value === null ? m.none : `${value}%`),
              },
              {
                title: m.ability,
                dataIndex: 'abilities',
                render: (abilities: Target['abilities']) =>
                  abilities.length ? abilities.map((a, index) => <div key={index}>{a.content}</div>) : m.none,
              },
            ]}
          />
        </Card>
      ))}
    </>
  );
}
