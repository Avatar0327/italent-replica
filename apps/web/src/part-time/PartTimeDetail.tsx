import { Button, Descriptions, Drawer, Table } from 'antd';
import { ReadPanel } from '../personnel/ReadPanel.js';
import { useSession } from '../foundation/Session.js';
import { apiRoot, value, type Row, type Term, type View } from './model.js';
import { Cell } from './references.js';
import { RequestActions } from './RequestEntries.js';
import { m } from './messages.js';
import { useRead } from './useRead.js';
export interface Selection {
  id: string;
  request: boolean;
}
const currentFields = [
  'serviceType',
  'effectiveDate',
  'endDate',
  'institution',
  'departmentId',
  'directManagerId',
  'postId',
  'positionId',
  'levelId',
  'sequenceId',
  'dottedManagerId',
  'employmentForm',
  'employmentType',
  'isDepartmentHead',
];
function Fields({ row, view, fields = currentFields }: { row: Row; view: View; fields?: string[] }) {
  return (
    <Descriptions
      bordered
      size="small"
      column={2}
      items={fields.map((field) => ({
        key: field,
        label: m.fields[field],
        children: <Cell row={row} field={field} view={view} />,
      }))}
    />
  );
}
function Time({ value: input }: { value?: string }) {
  const { timezone } = useSession();
  if (!input || !timezone || !Number.isFinite(Date.parse(input))) return <>{value(input)}</>;
  return (
    <>
      {new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' }).format(
        new Date(input),
      )}
    </>
  );
}
export function PartTimeDetail({
  selected,
  onClose,
  onSelect,
}: {
  selected: Selection;
  onClose(): void;
  onSelect(selection: Selection): void;
}) {
  const result = useRead<Row>(
    `${apiRoot}/${selected.request ? 'part-time-requests' : 'part-times'}/${encodeURIComponent(selected.id)}`,
  );
  const row = result.data;
  const view = selected.request ? 'in_approval' : 'all';
  const openRequest = (id: string) => onSelect({ id, request: true });
  return (
    <Drawer
      open
      width="min(1100px, 90vw)"
      onClose={onClose}
      className="part-time-detail"
      title={<h2>{selected.request ? m.requestDetail : m.detail}</h2>}
    >
      <ReadPanel {...result}>
        {row && (
          <>
            {selected.request && <RequestActions row={row} refresh={result.reload} />}
            <h3>{m.current}</h3>
            <Fields
              row={row}
              view={view}
              fields={
                selected.request
                  ? ['name', 'code', 'kind', 'approvalStatus', ...currentFields, 'originalEndDate', 'requestRemark']
                  : [...currentFields, 'serviceStatus', 'approvalStatus']
              }
            />
            {selected.request ? (
              <>
                <h3>{m.primary}</h3>
                <Fields
                  row={{ id: row.id, fields: row.primary?.fields }}
                  view={view}
                  fields={['departmentId', 'positionId', 'postId', 'levelId', 'directManagerId']}
                />
              </>
            ) : (
              <>
                <Terms row={row} openRequest={openRequest} />
                <Requests row={row} openRequest={openRequest} />
              </>
            )}
          </>
        )}
      </ReadPanel>
    </Drawer>
  );
}

type HistoryProps = { row: Row; openRequest(id: string): void };
function Terms({ row, openRequest }: HistoryProps) {
  return (
    <>
      <h3>{m.terms}</h3>
      {row.terms === undefined ? (
        <p>{m.missing}</p>
      ) : (
        <Table<Term>
          size="small"
          pagination={false}
          rowKey="termNo"
          dataSource={row.terms}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: m.fields.termNo, dataIndex: 'termNo' },
            { title: m.fields.endDate, dataIndex: 'endDate', render: value },
            {
              title: m.fields.source,
              dataIndex: 'source',
              render: (source: string) => m.sources[source] ?? value(source),
            },
            {
              title: m.fields.createdAt,
              dataIndex: 'createdAt',
              render: (time: string) => <Time value={time} />,
            },
            // PT-5 不返回操作人；不能把申请的发起方式冒充操作人。
            { title: m.fields.actor, render: () => m.missing },
            {
              title: m.operation,
              render: (_: unknown, term: Term) =>
                term.requestId ? (
                  <Button type="link" onClick={() => openRequest(term.requestId!)}>
                    {m.openRequest}
                  </Button>
                ) : (
                  m.missing
                ),
            },
          ]}
        />
      )}
    </>
  );
}
function Requests({ row, openRequest }: HistoryProps) {
  return (
    <>
      <h3>{m.requests}</h3>
      <Table<Row>
        size="small"
        pagination={false}
        rowKey="id"
        dataSource={row.requests ?? []}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: m.fields.kind,
            render: (_: unknown, item: Row) => <Cell row={item} field="kind" view="in_approval" />,
          },
          {
            title: m.fields.approvalStatus,
            render: (_: unknown, item: Row) => <Cell row={item} field="approvalStatus" view="in_approval" />,
          },
          { title: m.fields.originalEndDate, dataIndex: 'originalEndDate', render: value },
          { title: m.fields.requestEndDate, dataIndex: 'endDate', render: value },
          {
            title: m.operation,
            render: (_: unknown, item: Row) => (
              <Button type="link" onClick={() => openRequest(item.id)}>
                {m.openRequest}
              </Button>
            ),
          },
        ]}
      />
    </>
  );
}
