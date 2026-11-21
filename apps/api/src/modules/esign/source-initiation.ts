/** F-505 §5：来源路由接入同一命令出口；来源授权与业务锁由各适配方提供。 */
import { and, eq, esignTasks, sql, type Db, type Tx } from '@italent/db';
import { tenantLocalDate, type ESignSourceKind } from '@italent/domain';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { isActiveAccount } from '../approval/resolver.js';
import { personnelHooks } from '../employment/personnel-hooks.js';
import { rowsOf } from '../employment/record-store.js';
import { expireSignTask } from './expiry.js';
import { initiateSignTask, type PersonVariableField } from './initiation.js';
import { authorizeSignVariables, authorizeSourceSignTask } from './source-result-access.js';
import { lockSourceTemplates, normalizeSourceTemplateIds } from './source-templates.js';

type SourceSignContext = ScopeBusinessContext & Pick<TenantContext, 'tenantName'>;

interface SourceSignInput {
  readonly commandId: string | undefined;
  readonly scene: ESignSourceKind;
  readonly sourceId: string;
  readonly templateIds: readonly string[];
  /** 首次与重放均重校当前来源权限和范围，不执行发起资格和 revision 检查。 */
  readonly authorizeSource: (tx: Tx) => Promise<void>;
  /** 仅首次执行：按来源的锁序取锁，锁内重读资格 / 绑定，Offer 锚点由来源适配方保证。 */
  readonly lockSource: (
    tx: Tx,
    commandId: string,
  ) => Promise<{
    readonly employeeId: string;
    readonly ownerDepartmentId: string | null;
    readonly revision: number;
  }>;
}

type SourceSignDeps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

export function runSourceSignCommand(db: Db, deps: SourceSignDeps, ctx: SourceSignContext, input: SourceSignInput) {
  const { scene, sourceId } = input;
  const sourceRevision = ctx.expectedRevision;
  const templateIds = normalizeSourceTemplateIds(input.templateIds);
  const source =
    scene === 'offer' ? { scene, offerId: sourceId, sourceRevision } : { scene, businessId: sourceId, sourceRevision };
  const matchesSource = and(
    eq(esignTasks.tenantId, ctx.tenantId),
    eq(esignTasks.scene, scene),
    eq(scene === 'offer' ? esignTasks.offerId : esignTasks.businessId, sourceId),
  );
  return runCommand(db, ctx, {
    id: input.commandId,
    fingerprint: { route: 'esign.source.initiate', scene, sourceId, sourceRevision, templateIds },
    guard: {
      before: async (tx) => {
        if (!(await isActiveAccount(tx, ctx.tenantId, ctx.userId))) throw new AppError('FORBIDDEN', '发起人账号不可用');
        await input.authorizeSource(tx);
      },
      replayed: async (tx, result) => {
        const { taskId } = result.body as { taskId: string };
        await authorizeSourceSignTask(tx, deps, ctx, scene, sourceId, taskId);
      },
    },
    execute: async (tx, commandId) => {
      const owner = await input.lockSource(tx, commandId);
      if (owner.revision !== sourceRevision) throw new AppError('REVISION_CONFLICT', '签署来源已变更，请刷新后重试');
      const [active] = await tx
        .select({ id: esignTasks.id })
        .from(esignTasks)
        .where(and(matchesSource, eq(esignTasks.status, 'signing')))
        .for('update');
      // F-505 §5：期间可能等过来源锁和任务锁，用拿锁时的时间判断是否到期。
      const execution = { ...ctx, commandId, now: deps.clock() };
      if (active && (await expireSignTask(tx, execution, active.id)).status === 'signing')
        throw new AppError('CONFLICT', '已有签署中的任务', { reason: 'ESIGN_TASK_IN_PROGRESS' });
      const { templates, fields } = await lockSourceTemplates(tx, ctx.tenantId, templateIds);
      await authorizeSignVariables(tx, deps, ctx, owner.employeeId, fields);
      const task = await initiateSignTask(tx, execution, {
        source,
        employeeId: owner.employeeId,
        ownerDepartmentId: owner.ownerDepartmentId,
        initiatorUserId: ctx.userId,
        origin: 'manual',
        templateIds: templates.map(({ id }) => id),
        templates,
        variableReadFields: fields,
        loadVariables: () => sourceVariables(tx, execution, owner.employeeId, fields),
      });
      return { status: 201, body: { sourceId, taskId: task.id } };
    },
  });
}

async function sourceVariables(
  tx: Tx,
  ctx: SourceSignContext,
  employeeId: string,
  fields: readonly PersonVariableField[],
) {
  const readName = fields.includes('name');
  const readCode = fields.includes('code');
  const [person] = fields.length
    ? rowsOf<{ name: string | null; code: string | null }>(
        await tx.execute(sql`
    SELECT ${readName ? personnelHooks.currentName(ctx.tenantId, sql`e.id`, sql`e.name`) : sql`NULL`} AS name,
           ${readCode ? sql`e.code` : sql`NULL`} AS code
    FROM employment_employees e
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=${employeeId}::uuid
  `),
      )
    : [];
  return {
    员工姓名: person?.name,
    工号: person?.code,
    发起日期: tenantLocalDate(ctx.now, ctx.timezone),
    企业名称: ctx.tenantName,
  };
}
