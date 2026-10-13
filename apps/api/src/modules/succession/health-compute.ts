/** SP-15：端口只组装上下文和结果；健康度度量 / 等级求值复用 B5，不实现第二套计算器。 */
import { isUuid, sql } from '@italent/db';
import { RULE_COMPILER_VERSION, evaluateHealthLevels } from '@italent/domain';
import { validIsoDate } from '../org/read-model.js';
import { AppError } from '../../errors.js';
import type { OrgHealthComputePort } from '../talent-review/health-port.js';
import { activeUser } from './sync-access.js';
import { levelViews, type LevelView } from './levels-store.js';
import { rowsOf } from './read-sql.js';
import { successionReviewReads } from './ports.js';
import type { HealthReads, healthMetricReader as MetricReader } from './health-metrics.js';
import { unsupportedHealthRule } from './health-rule-support.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { CalcBlocked, CalcObjectFailure } from './calc-contract.js';
import { runProjectHealthCompute } from './health-compute-run.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { lockHealthRules } from './health-references.js';

export type { HealthReads } from './health-metrics.js';
type Evaluation = { levelId: string | null; failure?: { code: string; levelId?: string; rowNo?: number } };
async function evaluateProjectLevels(
  levels: readonly LevelView[],
  stale: boolean,
  read: ReturnType<typeof MetricReader>,
  calendar: { today: string; timeZone: string },
): Promise<Evaluation> {
  try {
    if (stale) throw new CalcBlocked('RULE_CACHE_STALE');
    // DEC-460：与 B5 worker 共用判定，未引用行与较后等级也不能绕过禁用组合。
    for (const level of levels) {
      const unsupported = level.rules?.rows.find(unsupportedHealthRule);
      if (unsupported) throw new CalcObjectFailure('FIELD_FORBIDDEN', false, level.id, unsupported.rowNo);
    }
    return await evaluateHealthLevels(
      levels.map((level) => ({ ...level, displayOrder: Number(level.displayOrder) })),
      async (row, levelId) => {
        try {
          return await read(row);
        } catch (error) {
          if (!(error instanceof CalcObjectFailure)) throw error;
          throw new CalcObjectFailure(error.code, false, levelId, error.rowNo ?? row.rowNo);
        }
      },
      calendar,
    );
  } catch (error) {
    if (!(error instanceof CalcBlocked) && !(error instanceof CalcObjectFailure)) throw error;
    return {
      levelId: null,
      failure: {
        code: error.code,
        ...(error instanceof CalcObjectFailure ? { levelId: error.levelId, rowNo: error.rowNo } : {}),
      },
    };
  }
}
type Input = Parameters<OrgHealthComputePort['compute']>[1];
function contextReads(reads: HealthReads, input: Input): HealthReads {
  const context = {
    triggerProjectId: input.context.projectId,
    ...(input.context.meetingId ? { triggerMeetingId: input.context.meetingId } : {}),
    asOf: input.businessDate,
  };
  const viewer = { kind: 'principal' as const, userId: input.principalUserId };
  return {
    listReviewFields: (tx, request) => reads.listReviewFields(tx, request),
    greenRate: (tx, request) => reads.greenRate(tx, { ...request, context, viewer }),
    readReviewFields: (tx, request) => reads.readReviewFields(tx, { ...request, context, viewer }),
    readSuccessionEntries: (tx, request) => reads.readSuccessionEntries(tx, { ...request, context, viewer }),
  };
}
export const healthComputePort: OrgHealthComputePort = {
  async listLevels(tx, { tenantId }) {
    return rowsOf(
      await tx.execute(sql`SELECT id,code,name,color,display_order AS "sortNo",enabled
      FROM succession_health_levels WHERE tenant_id=${tenantId}::uuid ORDER BY display_order,id`),
    );
  },
  async compute(tx, input) {
    const { tenantId, principalUserId, businessDate } = input;
    if (
      !validIsoDate(businessDate) ||
      !isUuid(input.context.projectId) ||
      (input.context.meetingId !== null && !isUuid(input.context.meetingId)) ||
      input.orgIds.length > 200 ||
      input.orgIds.some((id) => !isUuid(id))
    )
      throw new AppError('VALIDATION_FAILED', '健康度计算参数非法');
    if (!(await activeUser(tx, tenantId, principalUserId))) throw new AppError('FORBIDDEN', '计算主体不可用');
    const [calendar] = rowsOf<{ today: string; timezone: string; now: string }>(
      await tx.execute(sql`
      SELECT succession_tenant_today(${tenantId}::uuid)::text AS today,current_tenant_timezone() AS timezone,
      transaction_timestamp()::text AS now`),
    );
    await lockOrganizationSettings(tx, tenantId);
    await lockHealthRules(tx, tenantId);
    const ids = rowsOf<{ id: string; stale: boolean }>(
      await tx.execute(sql`
      SELECT id,condition_expression IS NOT NULL AND (compiler_version IS DISTINCT FROM ${RULE_COMPILER_VERSION}
        OR compile_error IS NOT NULL) AS stale FROM succession_health_levels
      WHERE tenant_id=${tenantId}::uuid AND enabled ORDER BY display_order,id`),
    );
    const levels = await levelViews(
      tx,
      tenantId,
      'health',
      ids.map((l) => l.id),
    );
    // 登记位与 B5 的 kind 注册互相引用，延迟加载宿主避免模块初始化环。
    const { healthMetricReader } = await import('./health-metrics.js');
    const reads = contextReads(successionReviewReads(tenantId), input);
    const scope = await resolveDataScope(tx, {
      tenantId,
      userId: principalUserId,
      appCode: 'SuccessionAndDevelopment',
      objectCode: 'Succession.HealthResult',
      asOf: calendar!.today,
    });
    return runProjectHealthCompute(tx, input, new Date(calendar!.now), async (ctx, object) => {
      const orgId = object.objectId;
      const read = healthMetricReader(ctx, object, { userId: principalUserId, scope, ...calendar! }, reads);
      const evaluated = await evaluateProjectLevels(
        levels,
        ids.some((l) => l.stale),
        read,
        { today: businessDate, timeZone: calendar!.timezone },
      );
      const selected = levels.find((l) => l.id === evaluated.levelId);
      return {
        orgId,
        levelId: selected?.id ?? null,
        levelCode: selected ? String(selected.code) : null,
        failures: evaluated.failure
          ? [
              {
                code: evaluated.failure.code,
                params: {
                  ...(evaluated.failure.levelId ? { levelId: evaluated.failure.levelId } : {}),
                  ...(evaluated.failure.rowNo ? { rowNo: evaluated.failure.rowNo } : {}),
                },
              },
            ]
          : [],
      };
    });
  },
};
