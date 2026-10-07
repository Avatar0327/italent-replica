import { normalizeUuid } from '@italent/domain';
import type { ApprovalCommand } from './types.js';

/**
 * DEC-288 止损 ④：服务端判定披露收紧时整页刷新。刷新前把“已发出 / 结果未知”的命令（URL、载荷、幂等键、revision）
 * 存进 sessionStorage，刷新后按原键先回查结果再决定能否重试，已经提交成功的写操作不会被当作没执行。
 * 只存一条：同一实例的写命令串行，结果未知时界面锁定，不会同时存在第二条。
 */
const KEY = 'approval.pendingCommand';
interface Stashed {
  readonly tenantId: string;
  readonly command: ApprovalCommand;
}
function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
export function stashCommand(tenantId: string, command: ApprovalCommand): void {
  const stashed: Stashed = { tenantId, command };
  try {
    storage()?.setItem(KEY, JSON.stringify(stashed));
  } catch {
    // 存储不可用时只能放弃暂存；刷新后由用户按原单核对。
  }
}
export function clearStash(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // 同上。
  }
}
/** 读取本租户暂存的命令（刷新后恢复用）；格式不符即视为无。 */
export function readStash(tenantId: string): ApprovalCommand | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stashed>;
    const command = parsed.command;
    if (
      parsed.tenantId !== tenantId ||
      !command ||
      typeof command.id !== 'string' ||
      !normalizeUuid(command.instanceId ?? '') ||
      typeof command.path !== 'string' ||
      typeof command.revision !== 'number' ||
      !command.body ||
      typeof command.body !== 'object'
    )
      return null;
    return {
      id: command.id,
      instanceId: normalizeUuid(command.instanceId)!,
      revision: command.revision,
      path: command.path,
      body: command.body,
    };
  } catch {
    return null;
  }
}
export function reloadPage(): void {
  window.location.reload();
}
