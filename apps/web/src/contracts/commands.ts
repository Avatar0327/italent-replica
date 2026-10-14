// F-127b 第 4 轮：合同模块的命令存储挂在模块级。AppPages 按 pathname 重建页面（PageErrorBoundary 的 key），
// 页面根部的 FormCommands 会随切换子页一起销毁：结果未知的新建命令一丢，回来重填就成了第二条命令。
// 键仍是“会话（租户 + 身份）+ 资源”，资源里带对象 ID（新建为 new），与内核 useCommandForm 一致；整页刷新后的恢复归 F-110。
import { useSyncExternalStore } from 'react';
import { useSession } from '../foundation/Session.js';
import { createFormStore, isLocked, type Latest, type SubmitInput } from '../foundation/forms/store.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';

const store = createFormStore();

/** 与内核 useCommandForm 同一形状，只是存储不随页面卸载。 */
export function useContractCommand(resource: string): CommandForm {
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
