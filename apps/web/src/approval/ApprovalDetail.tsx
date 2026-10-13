import { Alert, Button, Empty, Input, Space, Table, Tag, Timeline } from 'antd';
import { useEffect, useState } from 'react';
import {
  ApiError,
  DecisionNote,
  DetailPage,
  FormOverlay,
  PageState,
  useApiClient,
  useSession,
} from '../foundation/index.js';
import { presetLabels } from '../transfer/messages.js';
import { completedDetail } from '../demo-stubs/approval.js';
import { approvalCommand, readApproval, uuidPattern, visibleActions } from './api.js';
import { fieldLabels, messages as m, statusLabels, typeLabels } from './messages.js';
import type { ApprovalAction, ApprovalDetail as Detail, ApprovalRow } from './types.js';

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return m.empty;
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  if (Array.isArray(value)) return value.map(displayValue).join('、');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function ApprovalFields({ detail }: { detail: Detail }) {
  const rows = Object.entries(detail.form.values).map(([key, value]) => ({ key, value }));
  return rows.length ? (
    <Table
      size="small"
      pagination={false}
      rowKey="key"
      dataSource={rows}
      columns={[
        {
          title: m.field,
          dataIndex: 'key',
          width: '25%',
          render: (key: string) => fieldLabels[key] ?? presetLabels[key] ?? key,
        },
        ...(detail.form.originals
          ? [
              {
                title: m.original,
                key: 'original',
                width: '35%',
                render: (_: unknown, row: { key: string }) => displayValue(detail.form.originals?.[row.key]),
              },
            ]
          : []),
        { title: m.updated, dataIndex: 'value', render: displayValue },
      ]}
    />
  ) : (
    <Empty description={m.noValues} />
  );
}

interface DetailProps {
  row: ApprovalRow;
  demo?: boolean;
  onClose(): void;
  onChanged(): void;
}
function useApprovalDetail({ row, demo, onClose, onChanged }: DetailProps) {
  const api = useApiClient();
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const [action, setAction] = useState<ApprovalAction>();
  const [mustReload, setMustReload] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setError(undefined);
    void (demo ? Promise.resolve(completedDetail(row.id)) : readApproval(api, row.id, controller.signal))
      .then((value) => {
        if (!controller.signal.aborted) {
          setDetail(value);
          setMustReload(false);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [api, row.id, demo, generation]);
  const refresh = () => {
    setAction(undefined);
    setGeneration((value) => value + 1);
  };
  const submit = async (values: Record<string, unknown>) => {
    if (!detail || !action || demo) return;
    if (mustReload) throw new ApiError(409, 'RELOAD_REQUIRED', 'refresh', m.reloadRequired);
    const request = approvalCommand(detail, action, row.taskId, {
      comment: typeof values.comment === 'string' ? values.comment : undefined,
      toUserId: typeof values.toUserId === 'string' ? values.toUserId : undefined,
    });
    try {
      await api.request(request.path, { method: 'POST', command: request.command });
    } catch (cause) {
      // 结果未知 / 冲突后必须人工回查，不能从相同弹窗重复发新命令。
      if (!(cause instanceof ApiError && [400, 422].includes(cause.status))) setMustReload(true);
      throw cause;
    }
    onChanged();
    onClose();
  };
  return { detail, error, action, mustReload, refresh, submit, setAction };
}

export function ApprovalDetail(props: DetailProps) {
  const state = useApprovalDetail(props);
  const detail = state.detail;
  return (
    <>
      <DetailPage
        open
        onClose={props.onClose}
        title={detail?.title ?? m.detail}
        summary={<DetailSummary state={state} demo={props.demo} />}
        actions={detail && <Button onClick={state.refresh}>{m.refresh}</Button>}
        tabs={
          detail
            ? [
                { key: 'form', label: m.values, children: <ApprovalFields detail={detail} /> },
                { key: 'history', label: m.history, children: <ApprovalHistory detail={detail} /> },
              ]
            : undefined
        }
        sections={
          detail
            ? [
                {
                  key: 'actions',
                  title: m.operation,
                  children: <ActionBar {...props} state={state} detail={detail} />,
                },
              ]
            : []
        }
      />
      {detail && state.action && (
        <FormOverlay
          open
          mode="modal"
          recordKey={detail.id + ':' + detail.revision + ':' + state.action}
          title={m[state.action]}
          onClose={() => state.setAction(undefined)}
          onRefresh={state.refresh}
          onSubmit={state.submit}
          groups={[actionGroup(state.action, detail)]}
        />
      )}
    </>
  );
}
function DetailSummary({ state, demo }: { state: ReturnType<typeof useApprovalDetail>; demo?: boolean }) {
  const detail = state.detail;
  return (
    <>
      <DecisionNote id="approval" />
      {demo && <Alert type="info" message={m.demo} description={m.demoDetail} showIcon />}
      {!!state.error && <PageState kind="error" error={state.error} retry={state.refresh} />}
      {!state.error && !detail && <PageState kind="loading" />}
      {state.mustReload && <Alert type="warning" message={m.reloadRequired} showIcon />}
      {detail?.status === 'approved' && <Alert type="info" message={m.approvedNotice} showIcon />}
      {detail && (
        <Space className="approval-summary">
          <Tag color={detail.status === 'approved' ? 'green' : 'blue'}>
            {statusLabels[detail.status ?? ''] ?? detail.status}
          </Tag>
          <span>{typeLabels[detail.approvalType] ?? detail.approvalType}</span>
        </Space>
      )}
    </>
  );
}
function ApprovalHistory({ detail }: { detail: Detail }) {
  const { timezone } = useSession();
  if (detail.recordsHidden) return <Alert type="info" message={m.historyHidden} />;
  return (
    <>
      <p className="approval-muted">{m.historyLimit}</p>
      <Timeline
        items={detail.tasks.map((task) => ({
          color: task.status === 'pending' ? 'blue' : 'gray',
          children: (
            <div>
              <strong>{task.nodeName}</strong> <Tag>{statusLabels[task.status] ?? task.status}</Tag>
              {task.comment && <p>{task.comment}</p>}
              <small>{formatInstant(task.actedAt, timezone)}</small>
            </div>
          ),
        }))}
      />
    </>
  );
}
function ActionBar({
  detail,
  row,
  demo,
  state,
}: DetailProps & {
  detail: Detail;
  state: ReturnType<typeof useApprovalDetail>;
}) {
  const actions = visibleActions(detail);
  return (
    <div className="approval-action-bar">
      {!demo &&
        actions.map((item) => (
          <Button
            key={item}
            type={item === 'approve' ? 'primary' : 'default'}
            danger={item === 'reject' || item === 'withdraw'}
            disabled={state.mustReload || (item !== 'withdraw' && !row.taskId)}
            onClick={() => state.setAction(item)}
          >
            {m[item]}
          </Button>
        ))}
      {!actions.length && <span className="approval-muted">{m.noAction}</span>}
      {!row.taskId && actions.some((item) => item !== 'withdraw') && <span>{m.taskRequired}</span>}
    </div>
  );
}
function actionGroup(action: ApprovalAction, detail: Detail) {
  return {
    title: action === 'withdraw' ? m.withdrawNotice : (detail.commentNotice ?? m.commentNotice),
    fields: [
      ...(action === 'transfer'
        ? [
            {
              name: 'toUserId',
              label: m.target,
              access: { visible: true, editable: true },
              control: <Input placeholder={m.targetHint} maxLength={36} />,
              rules: [
                { required: true, message: m.required },
                { pattern: uuidPattern, message: m.targetInvalid },
              ],
            },
          ]
        : []),
      ...(action === 'withdraw'
        ? []
        : [
            {
              name: 'comment',
              label: m.comment,
              access: { visible: true, editable: true },
              control: <Input.TextArea rows={4} maxLength={2000} showCount />,
            },
          ]),
    ],
  };
}

export function formatInstant(value: string | null | undefined, timezone: string) {
  if (!value || !timezone) return m.empty;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime())
    ? m.empty
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(instant);
}
