import { TransferApiError, requestError } from '../../transfer/api.js';
import type { TransferBusiness } from '../../transfer/types.js';
import type { ApplicationCommand, ApplicationCommandRunner } from '../shared/application-command.js';
import { messages as m } from './messages.js';

interface ApplicationSession {
  pending: ApplicationCommand | null;
  saved: TransferBusiness | null;
  error: string;
}
const empty: ApplicationSession = { pending: null, saved: null, error: '' };
// DEC-464：仅当前浏览器页面内存，整页刷新清除。路由卸载不等于用户确认失败；不保存执行函数或重放请求。
const sessions = new Map<string, ApplicationSession>();
const listeners = new Set<() => void>();
export const readApplicationSession = (scope: string) => sessions.get(scope) ?? empty;
export function subscribeApplicationSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function update(scope: string, value: ApplicationSession) {
  sessions.set(scope, value);
  listeners.forEach((listener) => listener());
}
export async function runApplicationCommand(
  scope: string,
  command: ApplicationCommand,
  execute: Parameters<ApplicationCommandRunner>[1],
) {
  const previous = readApplicationSession(scope);
  if (previous.pending) throw new Error(m.processing);
  update(scope, { ...previous, pending: command, error: '' });
  try {
    const result = await execute();
    if (!result.id || !Number.isInteger(result.revision) || !result.status) throw new Error(m.processing);
    update(scope, { pending: null, saved: result, error: '' });
    return result;
  } catch (cause) {
    // 只有确定的拒绝能解除锁定；超时、断线、服务端异常都不能证明原命令未成功。
    if (cause instanceof TransferApiError && cause.status < 500)
      update(scope, { ...previous, pending: null, error: requestError(cause) });
    throw cause;
  }
}
export function clearConfirmedApplication(scope: string) {
  const value = readApplicationSession(scope);
  if (value.pending || !value.saved || value.saved.status === 'draft') return;
  update(scope, empty);
}
