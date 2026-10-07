/**
 * DEC-273 / DEC-284①：服务端间接触发的回退（撤权 / 停用 / 移出成员、异常管理员交接合席）造成原部门超编时不阻断，
 * 响应附一条不阻断的提示。提示只有通用文案，不带部门、人数、业务或员工等任何具体信息，对所有操作人相同；
 * 明细只在编制管理与审计里按各自权限查看。是否超编由本命令写下的超编警告审计判断（只查有无，不读内容）。
 */
import { sql, type Tx } from '@italent/db';
import type { TenantContext } from '../../tenant-context.js';
import { ESTABLISHMENT_REVERSAL_AUDIT } from './restored-occupancy.js';
import { rowsOf } from './store.js';

export const REVERSAL_WARNING_MESSAGE = '此操作导致编制超编，已记录警告，可在编制管理中查看（按你的权限）';

export interface ReversalWarning {
  readonly reason: 'ESTABLISHMENT_EXCEEDED';
  readonly message: typeof REVERSAL_WARNING_MESSAGE;
}

export const REVERSAL_WARNING: ReversalWarning = {
  reason: 'ESTABLISHMENT_EXCEEDED',
  message: REVERSAL_WARNING_MESSAGE,
};

/** 本命令是否写下过回退超编警告；是则返回通用提示，否则返回 null。 */
export async function reversalWarning(tx: Tx, ctx: TenantContext, commandId: string): Promise<ReversalWarning | null> {
  const [found] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM audit_events
      WHERE tenant_id=${ctx.tenantId} AND command_id=${commandId} AND action=${ESTABLISHMENT_REVERSAL_AUDIT} LIMIT 1`),
  );
  return found ? REVERSAL_WARNING : null;
}
