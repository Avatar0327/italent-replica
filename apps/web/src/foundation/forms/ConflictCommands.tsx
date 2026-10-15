// F-142（DEC-502②）：冲突恢复命令从继任页面上收进内核（原 succession/conflict.tsx，DEC-431①）。
import type { ReactNode } from 'react';
import type { Command } from '../client.js';
import { ui } from '../messages.js';
import { forAction } from './action.js';
import { messages } from './messages.js';
import { slotKey } from './slot.js';
import type { Latest, Values } from './store.js';
import { FormCommands, usePinnedCommand } from './useCommandForm.js';

/** 页面手里的对象快照：values 是全量 DTO（不只是表单字段），提交时未改项从这里取。 */
export interface Snapshot {
  /** 新建不写 id 键；写了 id 键就是对象命令（值缺失也算，不当新建）。 */
  id?: string;
  revision: number;
  values: Values;
  /** 一个命令涉及多个对象（批量结束）时逐个列出：结果未知时逐个钉住。 */
  objects?: readonly { id: string; revision: number }[];
}
export interface Sending {
  /** 用户真正改过的可编辑字段（相对基线）；未改项由调用方从 full 取。 */
  edited: Values;
  command: Command<Values>;
}
export interface Run {
  values: Values;
  editableFields: readonly string[];
  send(request: Sending): Promise<{ id: string }>;
}

/** 对象命令的 id 与版本是否可用：入口可先用它禁用按钮，不必等进内核才拒绝。 */
export const validObject = (item: { id?: string; revision?: number }) =>
  typeof item.id === 'string' && item.id !== '' && Number.isSafeInteger(item.revision) && (item.revision ?? -1) >= 0;

/** 冲突恢复命令的 Provider，放在页面根部；结果未知的钉住表由内核存储持有（F-147）。 */
export function ConflictCommands({ children }: { children: ReactNode }) {
  return <FormCommands>{children}</FormCommands>;
}

/**
 * resource 是集合路径：有对象时恢复槽为 slotKey(resource, id)，新建为集合路径本身（claude_fe_rules e）。
 * 409 与结果未知分开处理（claude_fe_rules g）：
 * - 409 冲突：本次尝试按对象版本记一个条目；弹窗内“重读最新版本”核对差异后按最新版本重提。
 *   关闭后列表刷新、重开拿到新版本即是新条目，已确认失败的旧尝试不再挡住保存。新建没有版本，条目就是集合路径。
 * - 结果未知：写入可能已成功、版本已变，换条目就等于换新命令再写一次。所以提交时内核先把恢复槽（slotKey，
 *   稳定原单路径）钉到本次条目（usePinnedCommand）；结果未知就一直钉着，关闭重开、换入口、读回新版本也仍是原命令、仍锁定。
 * - action 是本入口的动作（编辑 / 结束 / 删除），记进槽上下文：同一记录上别的动作未确认时本入口锁定（forAction）。
 * - 提交时只有用户改过的字段（edited）取表单值，其余取 full（读回的最新全量），不拿打开时的旧值覆盖别人的修改。
 * - 本地校验（必填、上限）要在 run 之前抛出：send 里抛的错会被内核判为结果未知并锁住。
 */
export function useConflictCommand(
  resource: string,
  current: Snapshot,
  read?: () => Promise<Latest>,
  action: Values = {},
) {
  const objects = current.objects ?? ('id' in current ? [{ id: current.id, revision: current.revision }] : []);
  // 对象命令的 id / 版本缺失或无效（如被字段权限裁剪）时不能落到新建槽：否则结果未知会锁住所有新建入口。
  const invalid = !objects.every(validObject);
  const objectSlots = invalid ? [] : objects.map((item) => slotKey(resource, item.id!));
  const slots = objects.length ? objectSlots : [slotKey(resource)];
  const attempt = objects.length ? `${slots.join(',')}@${objects.map((item) => item.revision).join(',')}` : slots[0]!;
  // '#' 不会出现在 slotKey 里，无效命令的条目不与任何恢复槽重名，也从不提交、从不钉槽。
  const pinned = usePinnedCommand(invalid ? [] : slots, invalid ? `${slotKey(resource)}#invalid` : attempt);
  const command = forAction(pinned, action);
  const full = command.state?.latest?.values ?? current.values;
  const reload = read && current.id !== undefined ? () => command.reread(read) : undefined;
  const run = async ({ values, editableFields, send }: Run) => {
    if (invalid) throw new Error(messages.invalidObject);
    const outcome = await command.submit({
      values,
      baseline: current.values,
      editableFields,
      revision: current.revision,
      businessId: current.id,
      patchOnly: current.id !== undefined,
      send: (request) => send({ edited: request.body, command: request }),
    });
    if (outcome.status !== 'done') throw outcome.error ?? new Error(ui.failed);
    command.clear();
  };
  return {
    form: { ...command, reload },
    /** 最新全量：重读并核对后是读回的那份，否则是打开时的快照。 */
    full,
    /** 冲突或结果未知：关闭时调用方应刷新来源（DEC-067 先回查再重提）；冲突重开即按新版本解锁，结果未知仍锁定。 */
    stale: command.status === 'conflict' || command.status === 'unknown',
    /** 对象 id / 版本无效：入口应禁用，run 不发请求直接拒绝。 */
    invalid,
    run,
  };
}
