import { Alert, Button, Empty, Space, Table, Tag } from 'antd';
import { reviewDemo } from '../demo-stubs/talent-review.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { tr } from './messages.js';
export function DemoNotice() {
  return (
    <>
      <Alert
        type="info"
        showIcon
        message={
          <>
            <Tag color="gold">{tr.demo}</Tag>
            {tr.demoNotice}
          </>
        }
        description={tr.paused}
      />
      <DecisionNote id="talent-review-demo" />
    </>
  );
}
export function DemoGrid() {
  return (
    <div className="review-grid-layout">
      <div>
        <div className="review-grid" aria-label={tr.tabs[3]}>
          {reviewDemo.cells.map((cell) => (
            <div key={cell.number} className={`review-cell ${cell.tone}`}>
              <strong>
                {cell.number}
                {cell.label}
              </strong>
              <span>{tr.demoZero}</span>
            </div>
          ))}
        </div>
        <div className="review-axis">
          <span>{tr.axes.low}</span>
          <span>{tr.axes.middle}</span>
          <span>{tr.axes.high}</span>
        </div>
        <p className="review-axis-title">
          {tr.axes.x} · {tr.axes.y}
        </p>
      </div>
      <aside className="review-grid-info">
        <h3>{tr.matrixRule}</h3>
        <p>{tr.demoZero}</p>
        <h3>{tr.matrixExplanation}</h3>
        <p>{tr.gridNote}</p>
      </aside>
    </div>
  );
}
export function DemoPanel({ tab }: { tab: number }) {
  const columns = (keys: string[]) =>
    keys.map((key) => ({
      title:
        tr.column[key as keyof typeof tr.column] ??
        ({ status: tr.fields.status, module: tr.module, weight: tr.weight, role: tr.role } as Record<string, string>)[
          key
        ],
      dataIndex: key,
      width: 120,
    }));
  return (
    <div className="review-demo-panel">
      <DemoNotice />
      <DemoContent tab={tab} columns={columns} />
    </div>
  );
}
function DemoContent({
  tab,
  columns,
}: {
  tab: number;
  columns: (keys: string[]) => { title: string | undefined; dataIndex: string; width: number }[];
}) {
  let content;
  if (tab === 0)
    content = (
      <>
        <DemoToolbar labels={tr.demoActions} />
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={reviewDemo.people}
          scroll={{ x: 'max-content' }}
          columns={columns([
            'employee',
            'qualification',
            'category',
            'level',
            'status',
            'currentStep',
            'executor',
            'calcStatus',
            'calcMessage',
            'report',
          ])}
        />
      </>
    );
  else if (tab === 1) content = <Relations columns={columns(['employee', 'role', 'executor'])} />;
  else if (tab === 2)
    content = (
      <Table
        rowKey="id"
        pagination={false}
        dataSource={reviewDemo.indicators}
        columns={columns([
          'employee',
          'department',
          'module',
          'indicator',
          'weight',
          'score',
          'finalScore',
          'grade',
          'finalGrade',
        ])}
        scroll={{ x: 'max-content' }}
      />
    );
  else if (tab === 3)
    content = (
      <>
        <DemoToolbar labels={tr.matrixActions} />
        <DemoGrid />
      </>
    );
  else
    content = (
      <Empty
        description={({ 6: tr.dashboardNotice, 7: tr.pending } as Record<number, string>)[tab] ?? tr.mappingNotice}
      />
    );
  return content;
}

function Relations({ columns }: { columns: { title: string | undefined; dataIndex: string; width: number }[] }) {
  return <Table rowKey="id" pagination={false} dataSource={[]} columns={columns} locale={{ emptyText: tr.empty }} />;
}

function DemoToolbar({ labels }: { labels: string[] }) {
  return (
    <Space className="review-demo-toolbar">
      {labels.map((label) => (
        <Button key={label} disabled>
          {label}
        </Button>
      ))}
    </Space>
  );
}
