/**
 * 职务模块的真实人员数据端口（F-006，接 DEC-074）：在岗人读自任职版本链，同步直线经理经任职模块的写入函数
 * createEmploymentBusiness 追加版本——与职位变更同一事务，审计与 outbox 随之写入，员工 revision 不符返回 409，
 * 幂等由职位变更命令的台账保证。操作人范围外的员工跳过并在回执中记 OUT_OF_SCOPE（P2-1）。
 */
import { type Db, isUuid, sql, type Tx, withTenant } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import { type Authorizer, requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { employmentCreator } from '../employment/context.js';
import { readPositionAssignments } from '../employment/personnel-reader.js';
import { loadEmploymentRecord, rowsOf } from '../employment/read-model.js';
import { createEmploymentBusiness } from '../employment/write-service.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScope,
  scopeAllowsInTransaction,
  type ModuleScope,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import type { JobPersonnelGateway, ManagerSyncSkip } from './types.js';

const EMPLOYMENT_OBJECT = MODULE_OBJECTS.employmentRecord.code;
/** 一次职位变更最多同步的在岗人数（AGENTS §10 批量上限），超过整体拒绝，不截断。 */
const INCUMBENT_LIMIT = 200;

/** 操作人在任职对象上的数据范围与授权器，由路由在请求开始时按当前权限解析。 */
export interface EmploymentWriteAccess {
  readonly scope: ModuleScope;
  readonly authorize: Authorizer;
}

/** 不传 access 时只能读在岗人（停用校验）；需要追加任职版本时 fail-closed。 */
export function employmentJobPersonnel(access?: EmploymentWriteAccess): JobPersonnelGateway {
  return {
    async listIncumbents(tx, query) {
      const limit = query.limit ?? INCUMBENT_LIMIT;
      const { items, hasMore } = await readPositionAssignments(tx, { ...query, limit });
      if (hasMore && query.limit === undefined) {
        throw new AppError('PAYLOAD_TOO_LARGE', `职位在岗人员超过单次同步上限 ${INCUMBENT_LIMIT} 人`);
      }
      return items.map((row) => ({
        employeeId: row.employeeId,
        assignmentId: row.recordId,
        revision: row.employeeRevision,
        directManagerId: row.directManagerId,
      }));
    },
    async appendManagerVersion(tx, ctx, change) {
      if (!access) throw new AppError('FORBIDDEN', '未提供任职写入授权，不能同步直线经理');
      const authorize = authorizeInTransaction(access.authorize, tx);
      const input = {
        kind: change.businessKind,
        mode: 'direct' as const,
        effectiveDate: change.effectiveDate,
        fields: { directManagerId: change.directManagerId },
      };
      // 与新增任职同一口径：按实际写入的字段校验新增权限（变动类型由系统写入，不是可编辑字段）。
      await requireObjectWrite(authorize, ctx, {
        objectCode: EMPLOYMENT_OBJECT,
        operation: 'create',
        payload: {
          kind: input.kind,
          mode: input.mode,
          effectiveDate: input.effectiveDate,
          directManagerId: change.directManagerId,
        },
      });
      if (await authorize({ ...ctx, action: 'data.scope.all' })) {
        await requirePermission(authorize, { ...ctx, action: 'tenant.employment.write', resource: change.employeeId });
      }
      if (!(await withinEmploymentScope(tx, ctx.tenantId, access.scope, change))) return { skipped: 'OUT_OF_SCOPE' };
      const employmentCtx = {
        ...ctx,
        expectedRevision: change.expectedRevision,
        scope: access.scope,
        authorize,
        objectCode: EMPLOYMENT_OBJECT,
      };
      // `19` §3.1 Q-M0-58（W-443、W-444）：与普通新增业务同一路径——其后已有未来记录时按 `07` A7 向后更新，
      // 生效日当天已有记录时再新增一条排在当日最后（DEC-108）；会形成循环汇报时整单拒绝（见 employment/reporting-cycle.ts）。
      await createEmploymentBusiness(tx, employmentCtx, change.employeeId, input, {
        changeType: change.changeType,
        positionManagerDerivation: true,
      });
    },
  };
}

/**
 * PR #54 首审 P2-1：按源任职的真实创建者判断它是否在操作人当前范围内可读，并按人员档案的真实创建者判断能否为该员工
 * 新增任职（与 POST /employees/:id/businesses 同一口径）；不能拿操作人自己当创建者，否则“仅本人创建”恒成立。
 */
async function withinEmploymentScope(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope,
  change: { readonly assignmentId: string; readonly employeeId: string; readonly effectiveDate: string },
): Promise<boolean> {
  if (scope.all) return true;
  const record = await loadEmploymentRecord(tx, tenantId, change.assignmentId, change.effectiveDate, scope);
  if (!record || record.employeeId !== change.employeeId) return false;
  const [creator] = rowsOf<{ creator: string | null }>(
    await tx.execute(sql`SELECT ${employmentCreator(tenantId, sql`${change.employeeId}::uuid`)} AS creator`),
  );
  const target = {
    personId: change.employeeId,
    orgId: record.fields.departmentId,
    creatorId: creator?.creator ?? null,
  };
  return scopeAllowsInTransaction(tx, scope, target);
}

type Deps = { readonly db: Db; readonly authorize: Authorizer; readonly clock: () => Date };

/**
 * PR #41 复审遗留：同步回执按操作人当前的任职数据范围与字段查看权裁剪（读取时按当前权限，含幂等重放）。
 * 看不到的员工只留跳过原因，不返回员工与任职标识；看得到的按任职对象的 id / employeeId 字段查看权裁剪。
 */
export async function trimManagerSync(deps: Deps, ctx: TenantContext & { readonly now: Date }, value: unknown) {
  const skipped = (value as { skipped?: unknown } | null)?.skipped;
  if (!Array.isArray(skipped)) return { skipped: [] };
  const entries = skipped as readonly ManagerSyncSkip[];
  const scope = await resolveModuleScope(deps, ctx, undefined, EMPLOYMENT_OBJECT);
  const viewable = await getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT);
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const visible = scope.all
    ? entries.map(() => true)
    : await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const result: boolean[] = [];
        for (const entry of entries) {
          const record = isUuid(entry.assignmentId)
            ? await loadEmploymentRecord(tx, ctx.tenantId, entry.assignmentId, asOf, scope)
            : null;
          result.push(record?.employeeId === entry.employeeId);
        }
        return result;
      });
  return {
    skipped: entries.map((entry, index) => {
      if (!visible[index]) return { reason: entry.reason };
      return {
        ...(!viewable || viewable.has('employeeId') ? { employeeId: entry.employeeId } : {}),
        ...(!viewable || viewable.has('id') ? { assignmentId: entry.assignmentId } : {}),
        reason: entry.reason,
      };
    }),
  };
}
