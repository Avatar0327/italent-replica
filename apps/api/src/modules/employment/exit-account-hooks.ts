import { exitPostEffectHooks } from './exit-confirmation.js';
import { queueExitAccount } from './exit-account-store.js';
import { applyRehireAccount } from './rehire-account.js';
import { registerEmployeeStatusHooks } from './status-hooks.js';

const rehireAccountHooks = { onRecordMaterialized: applyRehireAccount };

let installed = false;
export function installExitAccount() {
  // 状态钩子按名称幂等登记，每次装配都登记（测试复位登记表后重新装配仍生效）；离职后处理钩子只装一次
  registerEmployeeStatusHooks('exit-account', rehireAccountHooks);
  if (installed) return;
  installed = true;
  exitPostEffectHooks.onEffective((tx, ctx, e) => queueExitAccount(tx, ctx, e.businessId));
  exitPostEffectHooks.onCancelled((tx, ctx, e) => queueExitAccount(tx, ctx, e.businessId, true));
  exitPostEffectHooks.onReplanned((tx, ctx, e) => queueExitAccount(tx, ctx, e.businessId, true));
}
