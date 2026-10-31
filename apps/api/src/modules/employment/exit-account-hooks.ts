import { exitPostEffectHooks } from './exit-confirmation.js';
import { queueExitAccount } from './exit-account-store.js';

let installed = false;
export function installExitAccount() {
  if (installed) return;
  installed = true;
  exitPostEffectHooks.onEffective((tx, ctx, e) => queueExitAccount(tx, ctx, e.businessId));
  exitPostEffectHooks.onCancelled((tx, ctx, e) => queueExitAccount(tx, ctx, e.businessId, true));
  exitPostEffectHooks.onReplanned((tx, ctx, e) => queueExitAccount(tx, ctx, e.businessId, true));
}
