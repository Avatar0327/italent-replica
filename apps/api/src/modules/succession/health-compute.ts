/** SP-15：端口只组装上下文和结果；健康度度量 / 等级求值复用 B5，不实现第二套计算器。 */
import { isUuid, sql, type Tx } from '@italent/db';
import { RULE_COMPILER_VERSION, type SuccessionLevelRow } from '@italent/domain';
import { validIsoDate } from '../org/read-model.js';
import { AppError } from '../../errors.js';
import type { OrgHealthComputePort, OrgHealthComputeResult } from '../talent-review/health-port.js';
import type { TalentReviewSyncPort } from '../talent-review/sync-port.js';
import { createInMemoryTalentReviewSyncPort } from '../talent-review/sync-port-memory.js';
import { activeUser } from './sync-access.js';
import { levelViews, type LevelView } from './levels-store.js';
import { rowsOf } from './read-sql.js';
import { SUCCESSION_PORTS } from './ports.js';
import { CalcBlocked, CalcObjectFailure } from './calc-contract.js';

export type HealthReads = Pick<
  TalentReviewSyncPort,
  'greenRate' | 'readReviewFields' | 'readSuccessionEntries' | 'listReviewFields'
>;
type Metric = { status: 'value'; value: number } | { status: 'empty' | 'forbidden' | 'unavailable' | 'module_absent' };
type Evaluation = { levelId: string | null; failure?: { code: string; levelId?: string; rowNo?: number } };
/** B5 函数的消费侧结构：只列 host 实际读取的上下文字段；本端口不创建虚假的本地计算 run。 */
export interface HealthComputeHost {
  metricReader(
    ctx: { tx: Tx; run: { tenantId: string; businessDate: string; id: null }; now: Date },
    object: { objectId: string },
    principal: { userId: string; today: string; timezone: string },
    reads: HealthReads,
  ): (row: SuccessionLevelRow) => Promise<Metric>;
  evaluate(
    levels: readonly LevelView[],
    read: (row: SuccessionLevelRow, levelId: string) => Promise<Metric>,
    calendar: { today: string; timeZone: string },
  ): Promise<Evaluation>;
}
async function host(): Promise<HealthComputeHost> {
  if (SUCCESSION_PORTS.healthComputeHost) return SUCCESSION_PORTS.healthComputeHost;
  // B5 未合并时保持装配可用、计算明确失败；测试注入同形 host，不复制 B5 实现。
  const path: string = './health-metrics.js';
  try {
    const metrics: { healthMetricReader: HealthComputeHost['metricReader'] } = await import(path);
    const domain = await import('@italent/domain');
    const evaluate = Reflect.get(domain, 'evaluateHealthLevels') as HealthComputeHost['evaluate'] | undefined;
    if (typeof metrics.healthMetricReader === 'function' && typeof evaluate === 'function')
      return { metricReader: metrics.healthMetricReader, evaluate };
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  throw new AppError('SERVICE_UNAVAILABLE', '健康度计算宿主尚未接入', { reason: 'HEALTH_COMPUTE_UNAVAILABLE' });
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
    await tx.execute(sql`SELECT kind FROM succession_rule_settings
      WHERE tenant_id=${tenantId}::uuid AND kind='org_health' FOR SHARE`);
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
    const engine = await host(),
      result: OrgHealthComputeResult[] = [];
    const reads = contextReads(SUCCESSION_PORTS.reviewReads ?? createInMemoryTalentReviewSyncPort({ tenantId }), input);
    for (const orgId of new Set(input.orgIds.map((id) => id.toLowerCase()))) {
      let evaluated: Evaluation;
      try {
        const read = engine.metricReader(
          { tx, run: { tenantId, businessDate, id: null }, now: new Date(calendar!.now) },
          { objectId: orgId },
          { userId: principalUserId, ...calendar! },
          reads,
        );
        evaluated = ids.some((l) => l.stale)
          ? { levelId: null, failure: { code: 'RULE_CACHE_STALE' } }
          : await engine.evaluate(levels, read, { today: businessDate, timeZone: calendar!.timezone });
      } catch (error) {
        if (!(error instanceof CalcBlocked) && !(error instanceof CalcObjectFailure)) throw error;
        evaluated = {
          levelId: null,
          failure: {
            code: error.code,
            ...(error instanceof CalcObjectFailure ? { levelId: error.levelId, rowNo: error.rowNo } : {}),
          },
        };
      }
      const selected = levels.find((l) => l.id === evaluated.levelId);
      result.push({
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
      });
    }
    return result;
  },
};
