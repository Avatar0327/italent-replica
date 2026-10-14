/** F-128 A8：合同详情带任职信息与版本链；某员工全部合同摘要。权限口径与 GET /records/:id 一致（员工 + 创建人）。 */
import { and, asc, desc, eq, sql, contractRecords, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import { checkScope, currentPrimary, type ContractContext } from './context.js';
import { loadContract } from './service.js';

const c = contractRecords;
/** 列表需要的摘要字段，详情的版本链与员工合同列表共用。 */
const SUMMARY = {
  id: c.id,
  employeeId: c.employeeId,
  number: c.number,
  typeId: c.typeId,
  companyId: c.companyId,
  termType: c.termType,
  termMonths: c.termMonths,
  signingDate: c.signingDate,
  effectiveDate: c.effectiveDate,
  endDate: c.endDate,
  actualTerminationDate: c.actualTerminationDate,
  signingCount: c.signingCount,
  versionNo: c.versionNo,
  rootContractId: c.rootContractId,
  previousContractId: c.previousContractId,
  status: c.status,
  terminationReason: c.terminationReason,
  approvalStatus: c.approvalStatus,
  revision: c.revision,
  createdAt: c.createdAt,
};
const visible = (ctx: ContractContext) =>
  ctx.scope
    ? employmentVisibilitySql(ctx.scope, {
        department: sql`NULL::uuid`,
        employee: sql`${c.employeeId}`,
        creator: sql`${c.createdBy}`,
      })
    : sql`true`;
const MAX_ROWS = 1000;

export async function contractDetail(tx: Tx, ctx: ContractContext, id: string) {
  const row = await loadContract(tx, ctx.tenantId, id);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  // checkScope 取今天的主职；员工今天已无主职（如已离职）时退回合同生效日的主职
  const now = await checkScope(tx, ctx, row.employeeId, row.createdBy);
  const job =
    now ??
    (await currentPrimary(tx, ctx.tenantId, row.employeeId, row.effectiveDate <= today ? row.effectiveDate : today));
  const employment = job
    ? {
        departmentId: job.fields.departmentId,
        positionId: job.fields.positionId,
        postId: job.fields.postId,
        place: job.fields.place,
        entryDate: job.entryDate,
      }
    : null;
  const versions = await tx
    .select(SUMMARY)
    .from(c)
    .where(
      and(eq(c.tenantId, ctx.tenantId), eq(c.rootContractId, row.rootContractId), eq(c.deleted, false), visible(ctx)),
    )
    .orderBy(asc(c.signingCount), asc(c.effectiveDate), asc(c.versionNo), asc(c.id))
    .limit(MAX_ROWS + 1);
  if (versions.length > MAX_ROWS) throw new AppError('PAYLOAD_TOO_LARGE', '合同版本数超过单次返回上限');
  return { ...row, employment, versions };
}

export async function employeeContracts(tx: Tx, ctx: ContractContext, employeeId: string) {
  const items = await tx
    .select(SUMMARY)
    .from(c)
    .where(and(eq(c.tenantId, ctx.tenantId), eq(c.employeeId, employeeId), eq(c.deleted, false), visible(ctx)))
    .orderBy(desc(c.effectiveDate), desc(c.signingCount), desc(c.versionNo), asc(c.id))
    .limit(MAX_ROWS + 1);
  if (items.length > MAX_ROWS) throw new AppError('PAYLOAD_TOO_LARGE', '员工合同数超过单次返回上限');
  return items;
}
