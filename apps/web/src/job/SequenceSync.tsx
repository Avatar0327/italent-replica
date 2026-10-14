import { Alert, App, Button, Popconfirm, Space } from 'antd';
import { useRef, useState, type Key } from 'react';
import type { PageResult } from '../foundation/client.js';
import { usePageWrite, type PageAccess } from '../org/page-support.js';
import { pageText as m, text } from './messages.js';
import type { JobKind, JobRow } from './page-model.js';

export function useSequenceSelection(
  kind: JobKind,
  data: PageResult<JobRow> | undefined,
  access: PageAccess,
  refresh: () => void,
) {
  const [selection, setSelection] = useState<{ data: typeof data; rows: JobRow[] }>({ data, rows: [] });
  if (!['posts', 'positions'].includes(kind) || !access.can('syncSequence', 'list')) return undefined;
  const rows = selection.data === data ? selection.rows : [];
  return {
    keys: rows.map((row) => row.id),
    onChange: (_keys: Key[], rows: JobRow[]) => setSelection({ data, rows }),
    actions: <SequenceSync kind={kind} rows={rows} refresh={refresh} />,
  };
}
function SequenceSync({ kind, rows, refresh }: { kind: JobKind; rows: JobRow[]; refresh(): void }) {
  const write = usePageWrite();
  const submitting = useRef(false);
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await write(
        `/api/tenant/job/${kind}/sync-sequence`,
        { items: rows.map(({ id, revision }) => ({ id, revision })) },
        0,
        'POST',
      );
      void message.success(text.queued);
      refresh();
    } catch (error) {
      setError(error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Space>
      {!!error && <Alert type="error" message={error instanceof Error ? error.message : text.failed} />}
      {rows.length > 100 && <span>{m.syncLimit}</span>}
      <Popconfirm
        title={m.syncConfirm}
        onConfirm={submit}
        okText={m.confirm}
        cancelText={m.cancel}
        disabled={rows.length > 100 || busy}
      >
        <Button disabled={rows.length > 100} loading={busy}>
          {m.syncSelected}
        </Button>
      </Popconfirm>
    </Space>
  );
}
