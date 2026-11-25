// F-127b A4：审批中行内的催办 / 转交 / 撤销，复用审批中心（#297）的详情与动作，不另写审批逻辑。
import { Button, Space, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { forAction } from '../foundation/forms/action.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Outcome } from '../foundation/forms/store.js';
import { useApprovalCommand } from '../approval/commands.js';
import { ApprovalDetail } from '../approval/ApprovalDetail.js';
import { readApproval } from '../approval/api.js';
import type { ApprovalDetail as Detail, ApprovalRow } from '../approval/types.js';
import { myPendingTask, parseUrgeReceipt } from './forms.js';
import { m } from './messages.js';
import { object, type Row } from './model.js';

type Action = 'urge' | 'transfer' | 'withdraw';
type Api = ReturnType<typeof useApiClient>;
type Approval = { instance: ApprovalRow; detail: Detail };
const approval = '/api/tenant/approval/instances';
const order: Action[] = ['urge', 'transfer', 'withdraw'];
/**
 * 先按本人发起、再按本人参与查找该申请的流程实例；都找不到时视为无可用操作。
 * 详情缺 actions 按读取失败处理（fail-closed），不当作“无可用操作”，也不让渲染、点击时取 actions 出错。
 */
async function findApproval(api: Api, businessId: string, signal?: AbortSignal): Promise<Approval | undefined> {
  for (const role of ['initiated', 'participated']) {
    const query = new URLSearchParams({ role, businessId, page: '1', pageSize: '1' });
    const instance = (await api.request<{ items: ApprovalRow[] }>(`${approval}?${query}`, { signal })).items[0];
    if (!instance) continue;
    const detail = await readApproval(api, instance.id, signal);
    if (!Array.isArray(detail.actions)) throw new Error(m.approvalReadFailed);
    return { instance, detail };
  }
  return undefined;
}
/**
 * 点击时重读失败：命令还没发出（F-568 第 2 轮 P2-1）。登录、权限、不存在保留接口提示；
 * 其余（5xx、断网、响应不符）一律“审批操作读取失败”，不借用结果未知 / 回执无法核对的文案。
 */
const readFailure = (error: unknown) =>
  error instanceof ApiError && ['login', 'forbidden', 'not-found'].includes(error.kind)
    ? error.message
    : m.approvalReadFailed;
/**
 * 合同列表行不带审批 actions（后端缺口），按行读取流程详情；读取中或读取失败不显示按钮（fail-closed），
 * 失败时给出提示与重试，不静默隐藏。
 */
function useRowApproval(api: Api, businessId?: string) {
  const [state, setState] = useState<Approval | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!businessId) return;
    const controller = new AbortController();
    setFailed(false);
    findApproval(api, businessId, controller.signal).then(
      (found) => setState(found ?? null),
      () => {
        if (controller.signal.aborted) return;
        setState(null);
        setFailed(true);
      },
    );
    return () => controller.abort();
  }, [api, businessId, generation]);
  return { current: state, failed, retry: () => setGeneration((n) => n + 1) };
}
/**
 * F-568：按内核 outcome 提示本次催办（同 F-562 / F-566 口径，store.ts Outcome）。
 * 未发出：竞争提示 race 原因；等锁超时、不支持锁、存储不可用提示 refused 原文；登记冲突而占槽命令已落定时两者都没有，
 * error 是过期的“其他标签页”文案，不提示，可再催办。已发出：被拒显示服务端原文；结果未知按命令结果提示——
 * 回执无法核对（实例不符）与响应无法解析（客户端 INVALID_RESPONSE，自带的是读取失败文案）提示“回执无法核对，
 * 结果未知”（第 2 轮 P2-3），断网、5xx 用客户端的结果未确认原文。槽内锁定与查询入口仍由 CommandStatus 显示。
 */
function notifyUrge(result: Outcome, sent: boolean) {
  if (result.status === 'done') return void message.success(m.urged);
  if (result.race) return void message.warning(result.race.reason);
  if (!sent) {
    if (result.status === 'rejected' && result.refused) void message.error(result.refused);
    return;
  }
  const { error } = result;
  const server = error instanceof ApiError && error.code !== 'INVALID_RESPONSE' ? error.message : m.invalidReceipt;
  if (result.status === 'rejected') void message.error(server);
  else if (result.status === 'unknown') void message.warning(server);
}
/**
 * 催办走表单内核，与审批详情的转交、撤销共用流程实例的恢复槽（审批模块级存储，F-147），动作记在槽上下文：
 * 切换视图 / 子页重挂载后仍锁定，不生成新的幂等键（DEC-464/475）；任一动作结果未知时其他动作一并锁定。
 * 流程实例未读到时没有催办按钮，槽暂挂在集合路径上，不会提交。
 */
function useUrge(api: Api, instanceId?: string) {
  const command = useApprovalCommand(slotKey(approval, instanceId));
  const urge = forAction(command, { action: 'urge' });
  const send = async (target: Approval) => {
    // 点击时重读到的流程实例换了（极少见），本行的槽不对应它，按不可用处理。
    if (target.instance.id !== instanceId) return void message.warning(m.approvalUnavailable.urge);
    let sent = false;
    const result = await urge.submit({
      values: {},
      baseline: {},
      editableFields: [],
      revision: target.detail.revision,
      businessId: target.instance.id,
      send: async (command) => {
        sent = true;
        return parseUrgeReceipt(
          await api.request<unknown>(`${approval}/${encodeURIComponent(target.instance.id)}/urge`, {
            method: 'POST',
            command,
          }),
          { instanceId: target.instance.id, revision: command.revision ?? target.detail.revision },
        );
      },
    });
    // 用原始句柄清本次已落定的结果（第 2 轮 P2-2）：提交前槽里是别的动作（如审批详情里撤销被拒）时，
    // forAction 包装的 clear 是空操作，本次拒绝会留在槽里，下次重提沿用它的旧版本（store.ts submitTo prior）。
    // 锁定的条目 clear 不动（store.ts clear），别页接管后的有效锁保留。
    if (result.status === 'done' || result.status === 'rejected') command.clear();
    notifyUrge(result, sent);
  };
  const reload = () =>
    urge.reread(async (id) => {
      const detail = await readApproval(api, String(id));
      return { id: detail.id, revision: detail.revision, values: {} };
    });
  // 被拒只由 notifyUrge 按 outcome 提示一次，状态区不显示被拒条目：内核落定时先发布 rejected 再返回 outcome，
  // 过期竞争的“其他标签页”文案会在分类、清槽前渲染出来（第 2 轮 P2-2）。锁定（blocked）不受影响。
  const status = urge.state?.status === 'rejected' ? { ...urge, state: undefined } : urge;
  return { form: { ...urge, reload }, status, send };
}

export function RowActions({ row, onChanged }: { row: Row; onChanged(): void }) {
  const api = useApiClient();
  const session = useSession();
  const permission = usePermissions(object);
  const businessId = typeof row.id === 'string' ? row.id : '';
  const { current, failed, retry } = useRowApproval(api, businessId || undefined);
  const urge = useUrge(api, current?.instance.id);
  const [busy, setBusy] = useState<Action>();
  const [open, setOpen] = useState<ApprovalRow>();
  const run = async (action: Action) => {
    if (busy || !businessId) return;
    setBusy(action);
    try {
      // 点击时重读，按最新 actions 与版本发起，避免用列表加载时的旧状态；读取失败时命令还没发出。
      const target = await findApproval(api, businessId).catch((error: unknown) => {
        void message.error(readFailure(error));
        return null;
      });
      if (target === null) return;
      if (!target?.detail.actions.includes(action)) {
        void message.warning(m.approvalUnavailable[action]);
        return;
      }
      if (action === 'urge') return await urge.send(target);
      const taskId = action === 'transfer' ? myPendingTask(target.detail, session.userId) : undefined;
      if (action === 'transfer' && !taskId) void message.warning(m.approvalUnavailable.transfer);
      else
        setOpen({ ...target.instance, title: target.detail.title, approvalType: target.detail.approvalType, taskId });
    } finally {
      setBusy(undefined);
    }
  };
  // 按服务端 actions 渲染；撤销另需合同撤销按钮权限。
  const actions = order.filter(
    (action) => current?.detail.actions.includes(action) && (action !== 'withdraw' || permission.can('withdraw')),
  );
  // 不用 loading：antd 加载图标的离场动画没有超时兜底，请求很快返回时可能停在离场态；进行中一律禁用。
  return (
    <Space size={4} wrap>
      {actions.map((action) => (
        <Button
          key={action}
          type="link"
          size="small"
          disabled={!!busy || (action === 'urge' && (urge.form.locked || !!urge.form.blocked))}
          onClick={() => void run(action)}
        >
          {m.approvalActions[action]}
        </Button>
      ))}
      {failed && (
        <>
          <Typography.Text type="warning">{m.approvalReadFailed}</Typography.Text>
          <Button type="link" size="small" onClick={retry}>
            {m.retry}
          </Button>
        </>
      )}
      <CommandStatus submission={urge.status} />
      {open && (
        <ApprovalDetail
          row={open}
          onClose={() => setOpen(undefined)}
          onChanged={() => {
            setOpen(undefined);
            onChanged();
          }}
        />
      )}
    </Space>
  );
}
