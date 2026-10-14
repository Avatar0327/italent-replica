/** SP-16：可信事务内 helper；命令入口用 runProjectHealthCommand，重放不能重新读取 revision。 */
import { isUuid, type Db, type Tx } from '@italent/db';
import type { HealthCredential, OrgHealthContext, OrgHealthRowWrite, OrgHealthWriteReceipt } from '@italent/domain';
import { runCommand, type CommandGuard } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { TalentReviewSyncPort } from '../talent-review/sync-port.js';

type Row = Omit<OrgHealthRowWrite, 'expectedRevision'>;
interface ProjectWrite {
  tenantId: string;
  context: OrgHealthContext;
  credential: HealthCredential;
  rows: readonly Row[];
  /** reset 必填：版本读取后再求值；rows 仅指定待算组织集合。 */
  calculate?: (tx: Tx) => Promise<readonly Row[]>;
}
export async function writeProjectHealth(tx: Tx, port: TalentReviewSyncPort, input: ProjectWrite) {
  const { tenantId, context, credential } = input;
  if (credential.kind === 'reset' && !input.calculate)
    throw new AppError('VALIDATION_FAILED', '重置须在读取版本后计算');
  const orgIds = input.rows.map((r) => r.orgId.toLowerCase());
  if (orgIds.length > 200 || orgIds.some((id) => !isUuid(id)) || new Set(orgIds).size !== orgIds.length)
    throw new AppError('VALIDATION_FAILED', '健康度组织集合非法');
  const viewer =
    credential.kind === 'compute'
      ? { kind: 'principal' as const, userId: credential.principalUserId }
      : { kind: 'user' as const, userId: credential.userId };
  const current = await port.readOrgHealthRows(tx, { tenantId, context, orgIds, viewer });
  const states = new Map(current.map((r) => [r.orgId, r]));
  if (orgIds.some((id) => !states.has(id))) throw new AppError('SERVICE_UNAVAILABLE', '健康度版本读取不完整');
  if (current.some((r) => r.status === 'forbidden')) throw new AppError('FORBIDDEN', '无权读取目标健康度版本');
  const values = input.calculate ? await input.calculate(tx) : input.rows;
  if (values.length !== orgIds.length || new Set(values.map((r) => r.orgId.toLowerCase())).size !== orgIds.length)
    throw new AppError('VALIDATION_FAILED', '健康度计算对象集合不一致');
  const rows = values.map((r) => {
    const orgId = r.orgId.toLowerCase(),
      state = states.get(orgId);
    if (!orgIds.includes(orgId) || !state || state.status === 'forbidden')
      throw new AppError('VALIDATION_FAILED', '健康度计算对象集合不一致');
    return { ...r, orgId, expectedRevision: state.revision };
  });
  return credential.kind === 'reset'
    ? port.resetOrgHealth(tx, { tenantId, context, credential, rows })
    : port.recordOrgHealth(tx, { tenantId, context, credential, rows });
}

/** guard 由调用方提供当前对象 / 按钮 / 字段 / 范围授权；所有重放经过 commands.ts ledgerExit。 */
export async function runProjectHealthCommand(
  db: Db,
  ctx: TenantContext,
  port: TalentReviewSyncPort,
  input: ProjectWrite,
  guard: CommandGuard,
  fingerprint: unknown,
): Promise<OrgHealthWriteReceipt> {
  if (ctx.tenantId !== input.tenantId) throw new AppError('FORBIDDEN', '租户不一致');
  const result = await runCommand(db, ctx, {
    id: input.credential.commandId,
    fingerprint: {
      operation: 'succession.project-health',
      input: {
        tenantId: input.tenantId,
        context: input.context,
        credential: input.credential,
        rows: input.rows,
      },
      calculation: fingerprint,
    },
    guard,
    execute: async (tx) => ({ status: 200, body: await writeProjectHealth(tx, port, input) }),
  });
  return result.body as OrgHealthWriteReceipt;
}
