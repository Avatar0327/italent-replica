// F-127b A4：审批中行内的催办 / 转交 / 撤销，复用审批中心（#297）的详情与动作，不另写审批逻辑。
import { Button, Space, message } from 'antd';
import { useState } from 'react';
import { ApiError, newCommand } from '../foundation/client.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { ApprovalDetail } from '../approval/ApprovalDetail.js';
import { readApproval } from '../approval/api.js';
import type { ApprovalDetail as Detail, ApprovalRow } from '../approval/types.js';
import { myPendingTask } from './forms.js';
import { m } from './messages.js';
import { object, type Row } from './model.js';

type Action = 'urge' | 'transfer' | 'withdraw';
const approval = '/api/tenant/approval/instances';
/** 先按本人发起、再按本人参与查找该申请的流程实例；都找不到时视为无可用操作。 */
async function findInstance(api: ReturnType<typeof useApiClient>, businessId: string) {
  for (const role of ['initiated', 'participated']) {
    const query = new URLSearchParams({ role, businessId, page: '1', pageSize: '1' });
    const result = await api.request<{ items: ApprovalRow[] }>(`${approval}?${query}`);
    if (result.items[0]) return result.items[0];
  }
  return undefined;
}
export function RowActions({ row, onChanged }: { row: Row; onChanged(): void }) {
  const api = useApiClient();
  const session = useSession();
  const permission = usePermissions(object);
  const [busy, setBusy] = useState<Action>();
  const [blocked, setBlocked] = useState(false);
  const [open, setOpen] = useState<ApprovalRow>();
  const run = async (action: Action) => {
    if (busy || typeof row.id !== 'string') return;
    setBusy(action);
    try {
      const instance = await findInstance(api, row.id);
      const detail: Detail | undefined = instance && (await readApproval(api, instance.id));
      if (!instance || !detail?.actions.includes(action)) {
        void message.warning(m.approvalUnavailable[action]);
        return;
      }
      if (action !== 'urge') {
        const taskId = action === 'transfer' ? myPendingTask(detail, session.userId) : undefined;
        if (action === 'transfer' && !taskId) void message.warning(m.approvalUnavailable.transfer);
        else setOpen({ ...instance, title: detail.title, approvalType: detail.approvalType, taskId });
        return;
      }
      await api.request(`${approval}/${encodeURIComponent(instance.id)}/urge`, {
        method: 'POST',
        command: newCommand({}, detail.revision),
      });
      void message.success(m.urged);
    } catch (error) {
      // 催办结果未知时不允许在本行重复发送，刷新列表后再按服务端状态判断。
      if (!(error instanceof ApiError) || error.status >= 500 || error.status === 0) setBlocked(true);
      void message.error(error instanceof ApiError ? error.message : m.invalidReceipt);
    } finally {
      setBusy(undefined);
    }
  };
  const actions: Action[] = ['urge', 'transfer', ...(permission.can('withdraw') ? (['withdraw'] as const) : [])];
  return (
    <Space size={4}>
      {actions.map((action) => (
        <Button
          key={action}
          type="link"
          size="small"
          loading={busy === action}
          disabled={(!!busy && busy !== action) || (action === 'urge' && blocked)}
          onClick={() => void run(action)}
        >
          {m.approvalActions[action]}
        </Button>
      ))}
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
