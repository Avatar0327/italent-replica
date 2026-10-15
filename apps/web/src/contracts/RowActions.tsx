// F-127b A4：审批中行内的催办 / 转交 / 撤销，复用审批中心（#297）的详情与动作，不另写审批逻辑。
import { Button, Space, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { forAction } from '../foundation/forms/action.js';
import { slotKey } from '../foundation/forms/slot.js';
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
/** 先按本人发起、再按本人参与查找该申请的流程实例；都找不到时视为无可用操作。 */
async function findApproval(api: Api, businessId: string, signal?: AbortSignal): Promise<Approval | undefined> {
  for (const role of ['initiated', 'participated']) {
    const query = new URLSearchParams({ role, businessId, page: '1', pageSize: '1' });
    const instance = (await api.request<{ items: ApprovalRow[] }>(`${approval}?${query}`, { signal })).items[0];
    if (instance) return { instance, detail: await readApproval(api, instance.id, signal) };
  }
  return undefined;
}
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
 * 催办走表单内核，与审批详情的转交、撤销共用流程实例的恢复槽（审批模块级存储，F-147），动作记在槽上下文：
 * 切换视图 / 子页重挂载后仍锁定，不生成新的幂等键（DEC-464/475）；任一动作结果未知时其他动作一并锁定。
 * 流程实例未读到时没有催办按钮，槽暂挂在集合路径上，不会提交。
 */
function useUrge(api: Api, instanceId?: string) {
  const urge = forAction(useApprovalCommand(slotKey(approval, instanceId)), { action: 'urge' });
  const send = async (target: Approval) => {
    // 点击时重读到的流程实例换了（极少见），本行的槽不对应它，按不可用处理。
    if (target.instance.id !== instanceId) return void message.warning(m.approvalUnavailable.urge);
    const result = await urge.submit({
      values: {},
      baseline: {},
      editableFields: [],
      revision: target.detail.revision,
      businessId: target.instance.id,
      send: async (command) =>
        parseUrgeReceipt(
          await api.request<unknown>(`${approval}/${encodeURIComponent(target.instance.id)}/urge`, {
            method: 'POST',
            command,
          }),
          { instanceId: target.instance.id, revision: command.revision ?? target.detail.revision },
        ),
    });
    if (result.status === 'done' || result.status === 'rejected') urge.clear();
    if (result.status === 'done') void message.success(m.urged);
    if (result.status === 'rejected')
      void message.error(result.error instanceof ApiError ? result.error.message : m.invalidReceipt);
  };
  const reload = () =>
    urge.reread(async (id) => {
      const detail = await readApproval(api, String(id));
      return { id: detail.id, revision: detail.revision, values: {} };
    });
  return { form: { ...urge, reload }, send };
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
      // 点击时重读，按最新 actions 与版本发起，避免用列表加载时的旧状态。
      const target = await findApproval(api, businessId);
      if (!target?.detail.actions.includes(action)) {
        void message.warning(m.approvalUnavailable[action]);
        return;
      }
      if (action === 'urge') return await urge.send(target);
      const taskId = action === 'transfer' ? myPendingTask(target.detail, session.userId) : undefined;
      if (action === 'transfer' && !taskId) void message.warning(m.approvalUnavailable.transfer);
      else
        setOpen({ ...target.instance, title: target.detail.title, approvalType: target.detail.approvalType, taskId });
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : m.invalidReceipt);
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
      <CommandStatus submission={urge.form} />
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
