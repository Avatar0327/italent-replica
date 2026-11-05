import { Alert, Button, Empty, Modal, Space } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { PageState, useApiClient, useSession } from '../foundation/index.js';
import { centerText as c, detailText as d, messages as m } from './messages.js';
import type { ApprovalLog } from './types.js';

interface LogPage {
  items: ApprovalLog[];
  recordsHidden: boolean;
  page: number;
  pageSize: number;
}

/** 完整日志独立分页；隐藏结果不使用详情的旧快照回填（DEC-115）。 */
export function ProcessLog({ id, render }: { id: string; render(logs: ApprovalLog[]): ReactNode }) {
  const api = useApiClient();
  const { tenantId, identityKey } = useSession();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{d.processLog}</Button>
      {open && (
        <LogModal
          key={`${tenantId}/${identityKey}/${id}`}
          api={api}
          id={id}
          render={render}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
function LogModal({
  api,
  id,
  render,
  close,
}: {
  api: ReturnType<typeof useApiClient>;
  id: string;
  render(logs: ApprovalLog[]): ReactNode;
  close(): void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LogPage>();
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setError(undefined);
    void api
      .request<LogPage>(`/api/tenant/approval/instances/${encodeURIComponent(id)}/logs?page=${page}&pageSize=20`, {
        signal: controller.signal,
      })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [api, id, page, generation]);
  return (
    <Modal open title={d.processLog} onCancel={close} footer={null} width={760}>
      {error ? (
        <PageState kind="error" error={error} retry={() => setGeneration((n) => n + 1)} />
      ) : !data ? (
        <PageState kind="loading" />
      ) : data.recordsHidden ? (
        <Alert type="info" message={m.historyHidden} />
      ) : (
        <>
          {data.items.length ? render(data.items) : <Empty description={c.empty} />}
          <Space>
            <Button disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
              {c.previous}
            </Button>
            <span>{c.pageNo(data.page)}</span>
            <Button disabled={data.items.length < data.pageSize} onClick={() => setPage(data.page + 1)}>
              {c.next}
            </Button>
          </Space>
        </>
      )}
    </Modal>
  );
}
