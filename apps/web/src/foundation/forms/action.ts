// F-147：同一对象的不同动作（续签 / 终止、催办 / 转交、编辑 / 删除）共用一个恢复槽，动作记在槽上下文里。
import type { SubmitInput, Values } from './store.js';
import type { CommandForm } from './useCommandForm.js';
import { sameValue } from './values.js';

/**
 * 按本入口的动作看恢复槽：
 * - 空槽或槽里是本动作：原样使用，提交时把动作写进命令上下文；
 * - 槽里是别的动作：本入口看到空表单；那条命令未确认（锁定）时 blocked、不能提交，提交只拿回原命令，不另起命令；
 *   已被拒或已完成时，提交前先清掉再按本动作提交。
 * action 为空时原样返回。
 */
export function forAction<T extends CommandForm>(command: T, action: Values): T {
  const fields = Object.entries(action);
  if (!fields.length) return command;
  const context = command.state?.context;
  const foreign = !!command.state && fields.some(([field, value]) => !sameValue(context?.[field], value));
  const submit = (input: SubmitInput) => command.submit({ ...input, context: { ...action, ...input.context } });
  if (!foreign) return { ...command, submit };
  return {
    ...command,
    state: undefined,
    status: 'idle',
    busy: false,
    blocked: command.locked,
    reload: undefined,
    submit: (input: SubmitInput) => {
      if (command.locked) return command.submit(input);
      command.clear();
      return submit(input);
    },
    reread: async () => {},
    settle: () => undefined,
    confirm: () => {},
    clear: () => {},
  };
}
