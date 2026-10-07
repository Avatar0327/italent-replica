import { isValidTimeZone } from '@italent/domain';
import { useEffect, useRef, useState } from 'react';
import { approvalRequest, PAGE_SIZE, permissionFailure, requestMessage } from './api.js';
import { displayValue } from './fields.js';
import { eventLabels, statusLabels, text } from './messages.js';
import { STALE } from './requestLane.js';
import type { ApprovalDetail, ApprovalLog, ApprovalPageResult, ApprovalTask } from './types.js';
import type { InstanceRequests } from './useApprovalInstance.js';

/** 事件存 UTC，显示按接口租户时区；旧响应缺少时区时明确退回 UTC，不读取浏览器时区。 */
export function formatApprovalTime(value: string | null | undefined, tenantTimezone = 'UTC') {
  if (!value) return text.none;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text.none;
  const timeZone = isValidTimeZone(tenantTimezone) ? tenantTimezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const day = ['year', 'month', 'day'].map(part).join('-');
  const time = ['hour', 'minute', 'second'].map(part).join(':');
  return `${day} ${time} ${timeZone}`;
}
interface HistoryProps {
  readonly tenantId: string;
  readonly detail: ApprovalDetail;
  /** 与详情 GET、写 POST 共用的实例通道（DEC-277 ①）；历史只能触发“清空 + 整页重读”，不替代完整详情（②）。 */
  readonly requests: InstanceRequests;
}
/** 隐藏状态只来自实例层的完整详情；分页行只在本组件内保存，完整详情整体替换时清空，不做局部合并。 */
function useApprovalHistory({ tenantId, detail, requests }: HistoryProps) {
  const [kind, setKind] = useState<'tasks' | 'logs' | null>(null);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<readonly (ApprovalTask | ApprovalLog)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    setKind(null);
    setRows([]);
    setError('');
  }, [detail]);
  async function load(nextKind: 'tasks' | 'logs', nextPage: number) {
    if (detail.recordsHidden || busy) return;
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE) });
      // DEC-115 / DEC-277 ②：隐藏或被拒是收紧信号，在通道任务内即触发清空与整页重读，本页结果随之作废。
      const result = await requests.run(async (signal) => {
        try {
          const loaded = await approvalRequest<ApprovalPageResult<ApprovalTask | ApprovalLog>>(
            tenantId,
            `/instances/${detail.id}/${nextKind}?${query}`,
            { signal },
          );
          if (loaded.recordsHidden) requests.tighten();
          return loaded;
        } catch (failure) {
          if (permissionFailure(failure)) requests.tighten();
          throw failure;
        }
      });
      if (result === STALE || !active.current) return;
      setKind(nextKind);
      setPage(nextPage);
      setRows(result.items);
    } catch (failure) {
      if (active.current) setError(requestMessage(failure));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return { kind, page, rows, busy, error, load };
}
export function ApprovalHistory(props: HistoryProps) {
  const { kind, page, rows, busy, error, load } = useApprovalHistory(props);
  const { detail } = props;
  const hidden = detail.recordsHidden;
  return (
    <section className="approval-history">
      <h3>{text.progress}</h3>
      {hidden ? <p>{text.hidden}</p> : <p className="approval-hint">{text.currentWindow}</p>}
      <TaskRows
        timezone={detail.timezone}
        tasks={
          hidden
            ? detail.tasks.filter((task) => ['pending', 'queued', 'add_signed'].includes(task.status))
            : kind === 'tasks'
              ? (rows as readonly ApprovalTask[])
              : detail.tasks
        }
      />
      {!hidden && (
        <>
          <h3>{text.logs}</h3>
          <LogRows logs={kind === 'logs' ? (rows as readonly ApprovalLog[]) : detail.logs} timezone={detail.timezone} />
          <div className="approval-button-row">
            <button type="button" disabled={busy} onClick={() => void load('tasks', 1)}>
              {text.tasksHistory}
            </button>
            <button type="button" disabled={busy} onClick={() => void load('logs', 1)}>
              {text.logsHistory}
            </button>
          </div>
          {kind && (
            <div className="approval-button-row">
              <button type="button" disabled={busy || page === 1} onClick={() => void load(kind, page - 1)}>
                {text.previous}
              </button>
              <span>
                {text.page} {page} {text.pageUnit}
              </span>
              <button
                type="button"
                disabled={busy || rows.length < PAGE_SIZE}
                onClick={() => void load(kind, page + 1)}
              >
                {text.next}
              </button>
            </div>
          )}
        </>
      )}
      {busy && <p role="status">{text.loading}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function TaskRows({ tasks, timezone }: { tasks: readonly ApprovalTask[]; timezone?: string }) {
  return (
    <ol className="approval-progress">
      {tasks.map((task) => (
        <li key={task.id}>
          <strong>{task.nodeName ?? task.nodeKey ?? text.none}</strong> · {statusLabels[task.status] ?? task.status}
          {task.assigneeUserId && <span> · {task.assigneeUserId}</span>}
          {task.origin && eventLabels[task.origin] && <span> · {eventLabels[task.origin]}</span>}
          {task.isExceptionAdmin && <span className="approval-badge">{text.exceptionAdmin}</span>}
          {task.adminSelfTransfer && <span className="approval-badge">{text.adminSelf}</span>}
          {task.actedAt && <time>{formatApprovalTime(task.actedAt, timezone)}</time>}
          {task.comment && <p>{task.comment}</p>}
        </li>
      ))}
    </ol>
  );
}
function LogRows({ logs, timezone }: { logs: readonly ApprovalLog[]; timezone?: string }) {
  return (
    <ol className="approval-log">
      {logs.map((log, index) => (
        <li key={log.id ?? log.seq ?? index}>
          <strong>{eventLabels[log.event] ?? log.event}</strong>{' '}
          <time>{formatApprovalTime(log.createdAt, timezone)}</time>
          {log.nodeKey && <span> · {log.nodeKey}</span>}
          {log.adminSelfTransfer && <span className="approval-badge">{text.adminSelf}</span>}
          <dl>
            {Object.entries(log.detail).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{displayValue(value)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  );
}
