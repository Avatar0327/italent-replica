// 审批动作的命令存储挂在模块级（同 contracts/commands.ts，F-127b 先例）：AppPages 按 pathname 重建页面，
// 审批中心切换子页、合同页行内打开审批详情都没有共同的 FormCommands；结果未知的动作一丢，重开就成了第二条命令。
// 键仍是“会话（租户 + 身份）+ 资源”，资源只带流程实例 ID，不带动作、视图或入口（F-123 页面片接入 2）。
// 内核按 F-142 补齐跨页存储后改回 useCommandForm。
import { useSyncExternalStore } from 'react';
import { useSession } from '../foundation/Session.js';
import { createFormStore, isLocked, type Latest, type SubmitInput } from '../foundation/forms/store.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';

const store = createFormStore();

/** 与内核 useCommandForm 同一形状，只是存储不随页面卸载。 */
export function useApprovalCommand(resource: string): CommandForm {
  const session = useSession();
  const key = JSON.stringify([session.tenantId, session.identityKey, resource]);
  const state = useSyncExternalStore(store.subscribe, () => store.get(key));
  return {
    state,
    status: state?.status ?? 'idle',
    locked: isLocked(state),
    busy: state?.status === 'submitting',
    submit: (input: SubmitInput) => store.submit(key, input),
    reread: (read: (id?: string) => Promise<Latest>) => store.reread(key, read),
    confirm: () => store.confirm(key),
    clear: () => store.clear(key),
  };
}
