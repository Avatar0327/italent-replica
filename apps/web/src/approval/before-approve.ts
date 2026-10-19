import { Modal } from 'antd';
import { ApiError } from '../foundation/client.js';
import type { Values } from '../foundation/forms/values.js';
import { shorteningNotice } from '../part-time/request-confirmation.js';
import { r } from '../part-time/request-messages.js';

// DEC-431①：审批同意前确认只在此入口登记；业务模块提供自己的纯比较函数。
const confirmations: Record<string, (values: Values) => string | undefined> = {
  part_time_extend: (values) => shorteningNotice({ ...values, kind: 'extend' }),
};
export function approvalNotice(detail: { approvalType: string; form: { values: Values } }, action: string) {
  return action === 'approve' ? confirmations[detail.approvalType]?.(detail.form.values) : undefined;
}
export async function confirmNotice(notice?: string) {
  if (!notice) return;
  const accepted = await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: r.confirmTitle,
      content: notice,
      okText: r.confirm,
      cancelText: r.cancel,
      onOk: () => {
        resolve(true);
      },
      onCancel: () => {
        resolve(false);
      },
    });
  });
  if (!accepted) throw new ApiError(400, 'ACTION_CANCELLED', 'fields', r.cancelled);
}
