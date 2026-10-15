import { hrFormText as h } from './messages.js';
import type { TransferPreview } from './types.js';

/**
 * HR 全页表单的结构与按钮规则（纯函数，单测直接核对；#333 第 1 轮 P2-1 / P2-2 / P2-5）。
 * 原站“调动”底部为取消 / 保存，“他人调动申请”为取消 / 暂存 / 提交；同一入口按当前权限决定按钮能否点击。
 */
export type HrFormMode = 'apply' | 'direct';
export type HrFormAction = 'cancel' | 'draft' | 'submit' | 'save';
export type HrSection = 'info' | 'adjustment' | 'salary' | 'contract';

export const hrSections: readonly { key: HrSection; id: string; label: string }[] = [
  { key: 'info', id: 'hr-transfer-info', label: h.info },
  { key: 'adjustment', id: 'hr-transfer-adjustment', label: h.adjustment },
  { key: 'salary', id: 'hr-transfer-salary', label: h.salary },
  { key: 'contract', id: 'hr-transfer-contract', label: h.contract },
];
export const hrFormActions: Record<HrFormMode, readonly HrFormAction[]> = {
  apply: ['cancel', 'draft', 'submit'],
  direct: ['cancel', 'save'],
};
export const hrActionLabels: Record<HrFormAction, string> = {
  cancel: h.cancel,
  draft: h.draft,
  submit: h.submit,
  save: h.save,
};

interface ObjectPermissionLike {
  readonly summary?: true;
  readonly dataOperations: Readonly<Record<string, boolean>>;
  readonly editableFields: readonly string[];
}
/**
 * HR 新建调动的写权限：任职记录对象须有 create 操作权且至少一个可编辑字段。
 * 只有摘要（未加载完整对象权限）按无权处理（fail-closed）；预览的 allowedActions.application 恒为真，不能替代这里。
 */
export function hrWriteAccess(permission?: ObjectPermissionLike): boolean {
  if (!permission || permission.summary) return false;
  return permission.dataOperations.create === true && permission.editableFields.length > 0;
}

type PreviewActions = Pick<TransferPreview, 'allowDirectTransfer' | 'allowedActions'>;
export interface HrActionInput {
  readonly mode: HrFormMode;
  readonly writable: boolean;
  /** 表单本身不可提交：忙、未选员工、必填缺失或必填项不可用。 */
  readonly blocked: boolean;
  readonly preview: PreviewActions | null;
}
/** 各按钮能否点击及原因提示；取消始终可用。直接调动只认列表级按钮 Employment.Tranfer（directList）。 */
export function hrActionState(input: HrActionInput): { enabled: Record<HrFormAction, boolean>; hint?: string } {
  const { mode, writable, blocked, preview } = input;
  const application = writable && preview?.allowedActions?.application === true;
  const direct = writable && preview?.allowDirectTransfer === true && preview.allowedActions?.directList === true;
  const enabled = {
    cancel: true,
    draft: mode === 'apply' && application && !blocked,
    submit: mode === 'apply' && application && !blocked,
    save: mode === 'direct' && direct && !blocked,
  };
  return { enabled, hint: actionHint(mode, writable, preview, mode === 'apply' ? application : direct) };
}
function actionHint(mode: HrFormMode, writable: boolean, preview: PreviewActions | null, allowed: boolean) {
  if (!writable) return h.noWrite;
  if (!preview || allowed) return undefined;
  return mode === 'apply' ? h.noApplication : h.noDirect;
}
