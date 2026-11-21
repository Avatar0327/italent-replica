import { Alert, Button, Space, Table, Timeline, type TableColumnsType } from 'antd';
import { text } from './messages.js';
import { useState } from 'react';
import { logActor, logComment } from '../approval/api.js';
import { formatInstant } from '../approval/ApprovalDetail.js';
import { logEvents } from '../approval/messages.js';
import type { ApprovalLog } from '../approval/types.js';
import { ApiError } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { useSession } from '../foundation/Session.js';
import { RemoteContent, useRemote } from '../org/page-support.js';
import { detailPath, display, type OrgItem } from './model.js';

const organizationColumns = [
  [text.name, 'name'],
  [text.itemCode, 'code'],
  [text.shortName, 'shortName'],
  [text.org, 'targetOrgName'],
  [text.oldParent, 'originalParentOrgName'],
  [text.newParent, 'parentOrgName'],
  [text.batch, 'batchTransfer'],
  [text.transferTo, 'transferToOrgName'],
] as const;
const allColumns = organizationColumns.map(([title, dataIndex]) => ({
  title,
  dataIndex,
  render: (value: string | boolean | null | undefined) =>
    typeof value === 'boolean' ? (value ? text.yes : text.no) : display(value),
}));
const outcomes: TableColumnsType<OrgItem> = [
  { title: text.staged, dataIndex: 'stagedLabel', render: display },
  { title: text.result, dataIndex: 'executionResultLabel', render: display },
  { title: text.reason, render: (_, row) => display(row.executionMessage ?? row.executionReason) },
  {
    title: text.employmentFailures,
    render: (_, row) =>
      row.employmentFailures?.length || row.employmentFailureHiddenCount ? (
        <ul>
          {row.employmentFailures?.map((entry) => (
            <li key={entry.employeeId}>
              {display(entry.employeeName)} · {display(entry.message)}
            </li>
          ))}
          {!!row.employmentFailureHiddenCount && <li>{text.hiddenFailures(row.employmentFailureHiddenCount)}</li>}
        </ul>
      ) : (
        display(null)
      ),
  },
];

export function OrgSections({ id }: { id: string }) {
  const remote = useRemote<{ items: OrgItem[] }>(`${detailPath(id)}/items/org`);
  const groups = [
    { type: 1, title: text.addedSection, columns: allColumns.slice(0, 3) },
    { type: 2, title: text.changedSection, columns: allColumns.slice(3, 6) },
    { type: 3, title: text.stoppedSection, columns: [allColumns[3]!, ...allColumns.slice(6)] },
    { type: undefined, title: text.otherSection, columns: allColumns },
  ];
  return (
    <RemoteContent state={remote}>
      {groups.map((group) => {
        const rows = remote.data?.items.filter((item) => item.adjustType === group.type) ?? [];
        return rows.length ? (
          <section key={group.title} aria-label={group.title}>
            <h3>{group.title}</h3>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={rows}
              columns={[...group.columns, ...outcomes]}
              scroll={{ x: 'max-content' }}
            />
          </section>
        ) : null;
      })}
    </RemoteContent>
  );
}

interface Logs {
  items: ApprovalLog[];
  recordsHidden: boolean;
  page: number;
  pageSize: number;
}
export function ApprovalHistory({ id }: { id: string | null }) {
  const { timezone } = useSession();
  const [page, setPage] = useState(1);
  const remote = useRemote<Logs>(
    id ? `/api/tenant/approval/instances/${encodeURIComponent(id)}/logs?page=${page}&pageSize=20` : null,
  );
  const data = remote.data;
  if (remote.error instanceof ApiError && [403, 404].includes(remote.error.status))
    return <Alert type="info" message={text.historyDenied} />;
  if (remote.error) return <PageState kind="error" error={remote.error} retry={remote.refresh} />;
  if (remote.loading) return <PageState kind="loading" />;
  if (data?.recordsHidden) return <Alert type="info" message={text.historyDenied} />;
  return (
    <>
      {data?.items.length ? (
        <Timeline
          items={data.items.map((log, index) => ({
            key: `${log.createdAt}-${index}`,
            children: (
              <>
                <strong>{logEvents[log.event] ?? text.logEvent}</strong>
                <p>
                  {display(logActor(log))} · {formatInstant(log.createdAt, timezone)}
                </p>
                {logComment(log) && <p>{logComment(log)}</p>}
              </>
            ),
          }))}
        />
      ) : (
        <p>{text.noHistory}</p>
      )}
      {!!data && (page > 1 || data.items.length === data.pageSize) && (
        <Space>
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {text.previous}
          </Button>
          <span>{page}</span>
          <Button disabled={data.items.length < data.pageSize} onClick={() => setPage(page + 1)}>
            {text.next}
          </Button>
        </Space>
      )}
    </>
  );
}
