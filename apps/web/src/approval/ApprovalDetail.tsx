import { Alert, Button, Drawer, Empty, Input, Space, Steps, Tabs, Tag, Timeline, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
import { DecisionNote, FormOverlay, PageState, useApiClient, useSession } from '../foundation/index.js';
import { presetLabels } from '../transfer/messages.js';
import { completedDetail } from '../demo-stubs/approval.js';
import { useApprovalAction } from './action-command.js';
import { logActor, logComment, readApproval, uuidPattern, visibleActions } from './api.js';
import {
  detailText as d,
  fieldLabels,
  instanceStatus,
  logEvents,
  messages as m,
  statusLabels,
  typeLabels,
} from './messages.js';
import { actionOrder } from './page-model.js';
import type { ApprovalAction, ApprovalDetail as Detail, ApprovalRow } from './types.js';

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return m.empty;
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  if (Array.isArray(value)) return value.map(displayValue).join('、');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
/** 原站申请信息：标签 + 值；改变后的值橙色显示，下方浅灰“原：旧值”。 */
export function ApprovalFields({ detail }: { detail: Detail }) {
  const rows = Object.entries(detail.form.values);
  if (!rows.length) return <Empty description={m.noValues} />;
  const originals = detail.form.originals ?? {};
  return (
    <dl className="approval-fields">
      {rows.map(([key, value]) => (
        <div key={key} className="approval-field">
          <dt>{fieldLabels[key] ?? presetLabels[key] ?? key}</dt>
          <dd className={key in originals ? 'approval-changed' : undefined}>
            <span>{displayValue(value)}</span>
            {key in originals && <small>{d.original(displayValue(originals[key]))}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface DetailProps {
  row: ApprovalRow;
  demo?: boolean;
  /** 审批中心内在当前页打开（带返回）；合同等页面行内打开时用右侧抽屉。 */
  layout?: 'drawer' | 'page';
  onClose(): void;
  onChanged(): void;
}
function useApprovalDetail({ row, demo }: DetailProps) {
  const api = useApiClient();
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setError(undefined);
    void (demo ? Promise.resolve(completedDetail(row.id)) : readApproval(api, row.id, controller.signal))
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [api, row.id, demo, generation]);
  return { detail, error, setDetail, refresh: () => setGeneration((value) => value + 1) };
}

export function ApprovalDetail(props: DetailProps) {
  const state = useApprovalDetail(props);
  const action = useApprovalAction(props.row, state.setDetail);
  const { detail } = state;
  const body = <DetailBody {...props} state={state} action={action} />;
  return (
    <>
      {props.layout === 'page' ? (
        <section className="approval-detail-page">{body}</section>
      ) : (
        <Drawer open width={1200} title={detail?.title ?? m.detail} onClose={props.onClose} destroyOnHidden>
          {body}
        </Drawer>
      )}
      {detail && action.action && (
        <FormOverlay
          open
          mode="modal"
          recordKey={detail.id}
          submission={action.command}
          title={m[action.action]}
          onClose={action.close}
          onSubmit={async (values) => {
            await action.submit(detail, values);
            props.onChanged();
            props.onClose();
          }}
          groups={[actionGroup(action.action, detail)]}
        />
      )}
    </>
  );
}
type DetailState = ReturnType<typeof useApprovalDetail>;
type ActionState = ReturnType<typeof useApprovalAction>;
function DetailBody(props: DetailProps & { state: DetailState; action: ActionState }) {
  const { state, demo, action } = props;
  const { detail } = state;
  const { timezone } = useSession();
  return (
    <div className="approval-detail">
      <header className="approval-detail-head">
        {props.layout === 'page' && <Button onClick={props.onClose}>{d.back}</Button>}
        <div className="approval-detail-title">
          <h2 title={detail?.title}>{detail?.title ?? m.detail}</h2>
          {detail && <small>{headline(detail, timezone)}</small>}
        </div>
        {detail && <ActionBar row={props.row} demo={demo} detail={detail} action={action} refresh={state.refresh} />}
      </header>
      <DecisionNote id="approval-detail" />
      {demo && <Alert type="info" message={m.demo} description={m.demoDetail} showIcon />}
      {!!state.error && <PageState kind="error" error={state.error} retry={state.refresh} />}
      {!state.error && !detail && <PageState kind="loading" />}
      {action.pending && <Alert type="warning" showIcon message={d.locked(m[action.pending])} />}
      {detail?.status === 'approved' && <Alert type="info" message={m.approvedNotice} showIcon />}
      {detail && <DetailColumns detail={detail} />}
    </div>
  );
}
function headline(detail: Detail, timezone: string) {
  const status = instanceStatus[detail.status ?? '']?.label ?? statusLabels[detail.status ?? ''] ?? detail.status;
  const type = typeLabels[detail.approvalType] ?? detail.approvalType;
  return [type, status, formatInstant(detail.createdAt, timezone)].filter(Boolean).join(' · ');
}
function DetailColumns({ detail }: { detail: Detail }) {
  return (
    <>
      <ApprovalProgress detail={detail} />
      <div className="approval-detail-columns">
        <Tabs
          className="approval-detail-form"
          items={[{ key: 'form', label: m.values, children: <ApprovalFields detail={detail} /> }]}
        />
        <Tabs
          className="approval-detail-collab"
          type="card"
          items={[
            { key: 'records', label: d.records(detail.logs.length), children: <ApprovalHistory detail={detail} /> },
            {
              key: 'communicate',
              label: d.communicate,
              children: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={d.communicateGap} />,
            },
          ]}
        />
      </div>
    </>
  );
}
/** 原站进度：开始 → 各节点 → 结束；已走过绿、当前蓝、后续灰。接口只给已产生的任务，后续节点暂缺。 */
function ApprovalProgress({ detail }: { detail: Detail }) {
  const nodes = [...new Map(detail.tasks.map((task) => [task.nodeName, task])).values()];
  const running = detail.status === 'running';
  return (
    <div className="approval-progress">
      <Steps
        size="small"
        items={[
          { title: d.start, status: 'finish' },
          ...nodes.map((task) => ({
            title: task.nodeName,
            status: task.status === 'pending' ? ('process' as const) : ('finish' as const),
          })),
          { title: d.end, status: running ? ('wait' as const) : ('finish' as const) },
        ]}
      />
      {running && <small className="approval-muted">{d.progressGap}</small>}
    </div>
  );
}
/** 操作记录取流程日志（详情 logs，最近 200 条升序）；节点名按关联任务补，意见只取日志自身（logComment）。 */
function ApprovalHistory({ detail }: { detail: Detail }) {
  const { timezone } = useSession();
  if (detail.recordsHidden) return <Alert type="info" message={m.historyHidden} />;
  const tasks = new Map(detail.tasks.map((task) => [task.id, task]));
  return (
    <>
      <p className="approval-muted">{m.historyLimit}</p>
      <Timeline
        items={detail.logs.map((log, index) => {
          const task = log.taskId ? tasks.get(log.taskId) : undefined;
          const comment = logComment(log);
          const actor = logActor(log);
          return {
            key: `${log.createdAt}-${index}`,
            color: 'gray',
            children: (
              <div className="approval-log">
                {log.actorUserId !== null && actor && <span className="approval-log-actor">{actor}</span>}
                <strong>{logEvents[log.event] ?? log.event}</strong>
                {log.actorUserId === null && <Tag>{actor}</Tag>}
                {task && <Tag>{task.nodeName}</Tag>}
                {comment && <p>{comment}</p>}
                <small>{formatInstant(log.createdAt, timezone)}</small>
              </div>
            ),
          };
        })}
      />
    </>
  );
}
/**
 * 顶部按钮只取详情 actions（服务端下发），按原站顺序；有未确认命令时只允许打开那一个动作核对。
 * 流程管理没有接口；完整日志接口已有（GET /instances/:id/logs），但日志弹窗本段未实现。两者保留位置但禁用。
 */
function ActionBar(props: { row: ApprovalRow; demo?: boolean; detail: Detail; action: ActionState; refresh(): void }) {
  const { row, demo, detail, action } = props;
  const available = visibleActions(detail);
  const actions = actionOrder.filter((item) => available.includes(item));
  return (
    <Space wrap className="approval-action-bar">
      {!demo &&
        actions.map((item) => (
          <Button
            key={item}
            type={item === 'approve' ? 'primary' : 'default'}
            ghost={item === 'disagree'}
            disabled={(!!action.pending && action.pending !== item) || (item !== 'withdraw' && !row.taskId)}
            onClick={() => action.open(item)}
          >
            {m[item]}
          </Button>
        ))}
      <Tooltip title={d.gapTool}>
        <Button disabled>{d.processManage}</Button>
      </Tooltip>
      <Tooltip title={d.logDialogGap}>
        <Button disabled>{d.processLog}</Button>
      </Tooltip>
      <Button onClick={props.refresh}>{m.refresh}</Button>
      {!demo && !actions.length && <span className="approval-muted">{m.noAction}</span>}
      {!row.taskId && actions.some((item) => item !== 'withdraw') && <span>{m.taskRequired}</span>}
    </Space>
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
