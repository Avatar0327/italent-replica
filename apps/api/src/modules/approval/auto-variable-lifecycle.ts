/** F-326-L 自动变量生命周期（红提交桩：只有签名，没有行为；实现见随后的提交）。 */
import type { Tx } from '@italent/db';
import type { ApprovalContext } from './context.js';

export async function lockBoundProcess(
  _tx: Tx,
  _ctx: ApprovalContext,
  _matched: { readonly processId: string; readonly version: { readonly id: string } },
): Promise<void> {}

export function registerSaveClose(_tx: Tx, _ctx: ApprovalContext, _candidateIds: readonly string[]): void {}
