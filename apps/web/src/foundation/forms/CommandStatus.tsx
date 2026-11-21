import { Alert, Button, Space, Table } from 'antd';
import type { ReactNode } from 'react';
import { rejectionMessage } from '../client.js';
import type { Difference } from './store.js';
import type { CommandForm } from './useCommandForm.js';
import { messages as m } from './messages.js';
const display = (value: unknown) => (value === undefined ? '—' : JSON.stringify(value));
type FieldRenderers = Partial<Record<string, (value: unknown) => ReactNode>>;
function displayDifference(value: unknown, diff: Difference, renderers: FieldRenderers) {
  const render = Object.hasOwn(renderers, diff.field) ? renderers[diff.field] : undefined;
  return render ? render(value) : display(value);
}
export function CommandStatus({
  submission,
  labels = {},
  renderers = {},
}: {
  submission: CommandForm;
  labels?: Record<string, unknown>;
  /** 冲突差异按字段显示引用名等内容；未配置的字段沿用默认显示。 */
  renderers?: FieldRenderers;
}) {
  const { state, confirm } = submission;
  if (submission.blocked && !state) return <Alert type="warning" showIcon message={m.blocked} />;
  if (!state || ['idle', 'done'].includes(state.status)) return null;
  let message = m[state.status as 'submitting' | 'unknown' | 'conflict'];
  if (state.status === 'rejected') message = state.error instanceof Error ? rejectionMessage(state.error) : m.rejected;
  return (
    <Space direction="vertical">
      <Alert
        type={state.status === 'rejected' ? 'error' : 'warning'}
        showIcon
        message={message}
        action={<StatusActions submission={submission} />}
      />
      {state.status === 'unknown' && state.restored && <Alert type="info" showIcon message={m.restored} />}
      {state.status === 'unknown' && state.resultPending && <Alert type="info" showIcon message={m.resultPending} />}
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
                render: (value: unknown, diff: Difference) => displayDifference(value, diff, renderers),
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
/** F-110：结果未知给“查询结果”（按原命令 ID）；从恢复记录载入的命令（刷新前、别的标签页）没有可对的表单，不给回查原单。 */
function StatusActions({ submission }: { submission: CommandForm }) {
  const { state, reload, queryResult } = submission;
  if (!state) return null;
  return (
    <Space>
      {queryResult && state.status === 'unknown' && (
        <Button type="primary" loading={state.reading} onClick={() => void queryResult()}>
          {m.query}
        </Button>
      )}
      {reload && ['conflict', 'unknown'].includes(state.status) && !state.restored && (
        <Button loading={state.reading} onClick={() => void reload()}>
          {state.status === 'conflict' ? m.reload : m.original}
        </Button>
      )}
    </Space>
  );
}
