import { esignFailureText } from '@italent/domain';
import { Button, Pagination, Table, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { dateTime } from '../talent-review/ConfigList.js';
import { useESignDownload } from './download.js';
import { m } from './messages.js';
import { RECORD_BUTTONS, RECORD_OBJECT, filesPath, parseRecords, type RecordRow } from './records-model.js';
import { sceneText } from './sign-model.js';
import { sourceSignKey, sourceSignPath, sourceStatus, unreadable, type SignSource } from './source-sign-model.js';
import { useTasksChanged } from './task-changes.js';

const PAGE_SIZE = 20;
const s = m.source;

/** 按来源与当前签署记录权限独立读取。来源调用方只传来源 ID，不传列表快照。 */
export function SourceSignHistory({ source }: { source: SignSource }) {
  const key = sourceSignKey(useSession(), source);
  return <HistoryReader key={key} source={source} />;
}

function HistoryReader({ source }: { source: SignSource }) {
  const { timezone } = useSession();
  const permission = usePermissions(RECORD_OBJECT);
  const object = permission.snapshot.objects[RECORD_OBJECT];
  const allowed = object?.objectCode === RECORD_OBJECT && !object.summary && !permission.loading && !permission.error;
  const canView = !!allowed;
  const canDownload = allowed && permission.can(RECORD_BUTTONS.download, 'list') && permission.field('files').visible;
  const download = useESignDownload();
  const [page, setPage] = useState(1);
  const path = `${sourceSignPath(source)}/esign-records?page=${page}&pageSize=${PAGE_SIZE}`;
  const read = useRead<unknown>(canView ? path : null);
  useTasksChanged(read.refresh);

  let records;
  let error = read.error;
  try {
    if (read.data !== undefined) records = parseRecords(read.data);
  } catch (cause) {
    error = cause;
  }
  if (!canView || unreadable(error)) return null;
  const rows = records?.items ?? [];
  const columns: TableColumnsType<RecordRow> = [
    {
      title: m.records.scene,
      render: (_, row, index) => (
        <>
          {sceneText(row.scene)}
          {page === 1 && index === 0 && (
            <div>
              <small>{s.latest}</small>
            </div>
          )}
        </>
      ),
    },
    { title: m.records.initiatedAt, render: (_, row) => dateTime(row.initiatedAt, timezone) },
    {
      title: m.records.status,
      render: (_, row) => {
        const status = sourceStatus(row.status, row.currentNode);
        const reason = row.status === 'failed' ? esignFailureText(row.failureReason ?? null) : null;
        return reason ? m.reissue.failed(reason) : status;
      },
    },
    {
      title: m.records.files,
      render: (_, row) => {
        const names = row.files?.flatMap((file) => (file.name ? [file.name] : [])) ?? [];
        if (!names.length) return m.missing;
        return (
          <>
            <span>{names.join(m.fileSeparator)}</span>
            {row.status === 'completed' && canDownload && (
              <Button type="link" onClick={() => void download(filesPath([row.id]))}>
                {m.records.download}
              </Button>
            )}
          </>
        );
      },
    },
  ];
  return (
    <section aria-label={s.history}>
      <h3>{s.history}</h3>
      {!!error && (
        <p role="alert">
          {s.historyError} <Button onClick={read.refresh}>{s.retry}</Button>
        </p>
      )}
      {read.loading && <p role="status">{s.historyLoading}</p>}
      {records && !rows.length && <p>{s.emptyHistory}</p>}
      {!!rows.length && (
        <Table<RecordRow> rowKey="id" dataSource={rows} columns={columns} pagination={false} size="small" />
      )}
      {!!records && records.total > PAGE_SIZE && (
        <Pagination
          current={page}
          pageSize={PAGE_SIZE}
          total={records.total}
          showSizeChanger={false}
          onChange={setPage}
        />
      )}
    </section>
  );
}
