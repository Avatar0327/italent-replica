import { and, auditCommandFailures, commandLedger, eq, sql, type Tx } from '@italent/db';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { commandHash } from '../../commands.js';
import { readOwnCommandResult } from '../command-result/service.js';
import { findEmploymentType } from './employment-types.js';
import type { EmploymentContext } from './types.js';

const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** UUID 大小写不敏感（uuidParam 已按小写处理）：删除写入口与结果查询都按此规范化路径，指纹才对得上。 */
export function canonicalDeletePath(path: string): string {
  return path.replace(UUID_IN_PATH, (uuid) => uuid.toLowerCase());
}

/**
 * F-469 / DEC-764：只确认本人原删除命令，不从列表缺席或当前字段推断成功。
 * 与删除共用字典锁，等待正在执行的删除落定后再读台账；无台账仍可能尚未执行，返回 unknown。
 */
export async function readEmploymentTypeDeleteResult(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  commandId: string,
  revision: number,
) {
  await advisoryLock(tx, asUuid(ctx.tenantId), ':employment-types');
  const result = (status: 'deleted' | 'not_deleted' | 'unknown') => ({ commandId, id, revision, status });
  const path = canonicalDeletePath(`/api/tenant/employment/employment-types/${id}`);
  const [entry] = await tx
    .select()
    .from(commandLedger)
    .where(and(eq(commandLedger.tenantId, ctx.tenantId), eq(commandLedger.commandId, commandId)));
  if (entry) {
    const expected = commandHash(ctx.userId, { method: 'DELETE', path, revision, input: { id } });
    const body = entry.responseBody as { id?: unknown; deleted?: unknown } | null;
    const deleted =
      entry.actorUserId === ctx.userId &&
      entry.requestHash === expected &&
      entry.responseStatus === 200 &&
      body?.id === id &&
      body.deleted === true;
    // 已有归属时绝不回退到碰撞产生的失败审计。
    return result(deleted ? 'deleted' : 'unknown');
  }
  const own = await readOwnCommandResult(tx, ctx, commandId);
  if (own?.status !== 'failed') return result('unknown');
  const f = auditCommandFailures;
  const [history] = await tx
    .select({
      sameDelete: sql<boolean>`bool_and(${f.method} = 'DELETE' AND lower(${f.path}) = ${path})`,
    })
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), eq(f.actorUserId, ctx.userId), eq(f.commandId, commandId)));
  if (!history?.sameDelete) return result('unknown');
  // 失败审计没有请求指纹 / revision，不能单凭它解锁。未删且版本已超过原版本，才证明原版本删除再不能生效。
  // 同版本的业务拒绝仍保守为 unknown，避免把另一次同键请求或迟到删除误当作最终失败。
  const current = await findEmploymentType(tx, ctx.tenantId, id);
  return result(current && current.revision > revision ? 'not_deleted' : 'unknown');
}
