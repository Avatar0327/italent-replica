import { requireEmploymentWrite } from './context.js';
import type { EmploymentContext } from './types.js';

/** 任职状态动作的写权与按钮保持同一映射，撤回资格和命令重放复核共同调用。 */
export async function requireEmploymentTransitionWrite(
  ctx: EmploymentContext,
  action: 'submit' | 'withdraw' | 'revoke' | 'delete',
) {
  const operation = action === 'delete' ? 'delete' : 'update';
  const button = `Employment.${action[0]!.toUpperCase()}${action.slice(1)}`;
  await requireEmploymentWrite(ctx, operation, {}, button);
}
