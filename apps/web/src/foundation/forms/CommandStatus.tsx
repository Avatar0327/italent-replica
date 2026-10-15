import { Alert, Button, Space, Table } from 'antd';
import { rejectionMessage } from '../client.js';
import type { CommandForm } from './useCommandForm.js';
import { messages as m } from './messages.js';
const display = (value: unknown) => (value === undefined ? '—' : JSON.stringify(value));
export function CommandStatus({
  submission,
  labels = {},
}: {
  submission: CommandForm;
  labels?: Record<string, unknown>;
}) {
  const { state, reload, confirm } = submission;
  if (!state || ['idle', 'done'].includes(state.status)) return null;
  let message = m[state.status as 'submitting' | 'unknown' | 'conflict'];
  if (state.status === 'rejected') message = state.error instanceof Error ? rejectionMessage(state.error) : m.rejected;
  return (
    <Space direction="vertical">
      <Alert
        type={state.status === 'rejected' ? 'error' : 'warning'}
        showIcon
        message={message}
        action={
          reload &&
          ['conflict', 'unknown'].includes(state.status) && (
            <Button loading={state.reading} onClick={() => void reload()}>
              {state.status === 'conflict' ? m.reload : m.original}
            </Button>
          )
        }
      />
      {!!state.readError && <Alert type="error" message={m.failedRead} />}
      {state.status === 'conflict' && state.latest && (
        <>
          <Table
            size="small"
            pagination={false}
            rowKey="field"
            dataSource={state.differences?.filter((diff) => diff.field in labels)}
            locale={{ emptyText: m.none }}
            columns={[
              {
                title: m.field,
                dataIndex: 'field',
                render: (field: string) => (typeof labels[field] === 'string' ? labels[field] : field),
              },
              ...(['before', 'latest', 'mine'] as const).map((key) => ({
                title: m[key],
                dataIndex: key,
                render: display,
              })),
            ]}
          />
          <Button disabled={state.reading || !!state.readError} onClick={confirm}>
            {m.confirm}
          </Button>
        </>
      )}
      {state.status === 'unknown' && state.latest && (
        <Alert
          type="info"
          message={m.originalHint}
          description={
            <Table
              size="small"
              pagination={false}
              rowKey="field"
              dataSource={Object.entries(state.latest.values)
                .filter(([field]) => field in labels)
                .map(([field, value]) => ({ field, value }))}
              columns={[
                { title: m.field, dataIndex: 'field', render: (field: string) => String(labels[field]) },
                { title: m.latest, dataIndex: 'value', render: display },
              ]}
            />
          }
        />
      )}
    </Space>
  );
}
