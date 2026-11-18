import { hrFormText as h } from './messages.js';
import { useConfirmDialog, type ConfirmText } from './useConfirmDialog.js';

const establishmentText: ConfirmText = {
  title: h.establishmentTitle,
  content: h.establishmentContent,
  okText: h.establishmentOk,
  cancelText: h.cancel,
};

/**
 * 服务端要求确认超编的 409（F-026，AC-EST-02）：非严格控编超出设定编制时整单回滚并返回 CONFIRMATION_REQUIRED，
 * 确认后带 confirmed 以新命令重提。严格控编是 ESTABLISHMENT_EXCEEDED，是确定的拒绝，不走这里。
 * 这些保存入口服务端只会为超编给出这一种确认，所以只看原因码；原因码本身不显示给用户（DEC-045）。
 */
export function needsEstablishmentConfirm(error: unknown): boolean {
  const failure = error as { status?: number; reason?: string } | null;
  return failure?.status === 409 && failure.reason === 'CONFIRMATION_REQUIRED';
}

/** 超编确认框：取消即不重提，调用方保留用户输入。 */
export function useEstablishmentConfirm() {
  return useConfirmDialog(establishmentText);
}

/**
 * 发送一次保存；要求确认超编时弹框，确认后以 confirmed 重提一次（重提由 send 自带新命令 ID），取消则抛出原错误。
 * 已带 confirmed 仍被要求确认时不再循环，原样抛出。
 */
export async function sendWithEstablishmentConfirm<T>(
  send: (confirmed: boolean) => Promise<T>,
  ask: () => Promise<boolean>,
): Promise<T> {
  try {
    return await send(false);
  } catch (error) {
    if (!needsEstablishmentConfirm(error) || !(await ask())) throw error;
    return send(true);
  }
}
