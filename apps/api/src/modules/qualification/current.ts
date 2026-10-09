/**
 * 通用当前资格与申报专用的上一条资格（R3-T02 设计 §6.2 (3)(4)，拆分方案 C1-3）。可信只读端口：在调用方租户事务内执行，
 * 不做权限判断——授权由调用方按自己的业务关系完成（发展通道看本人、指标端口由盘点按业务关系授权、申报由 C2-2 校验）。
 *
 * 当前资格（DEC-335①，规格 23 §13）：每人的任职资格是一条不分类型、不重叠、无断档的单一时间轴，自动同步与手工录入混排；
 * 当前资格 = 覆盖 asOf（开始日 ≤ asOf 且结束日为空或 ≥ asOf）、开始日最晚的那一条，每人最多一条；记录都已结束的人没有。
 * 按日期计算，不存“是否当前生效”冗余标记。数据有重叠（原站不会出现，复刻允许 HR 手工录入）时开始日最晚的优先，
 * 开始日相同取后建的，保证确定。已删除的记录不参与。
 *
 * 申报上一条资格（EV-R18，整条 🟡）：先取子集（同一条时间轴，不分来源、不分活动类型，DEC-335① 选项 c，即申报时点的
 * 当前资格），取不到再回退到“同活动类型最近一条已发布评定”；评定记录由 C2-8 登记回退提供者，本 PR 只建接口与子集分支，
 * 未登记时回退为空。
 */
import { isUuid, sql, type Tx } from '@italent/db';

export interface CurrentQualification {
  readonly recordId: string;
  readonly categoryId: string;
  readonly levelId: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly isAutoSync: boolean;
  readonly finalScore: number | null;
  readonly result: string | null;
}

export interface PriorQualification {
  readonly categoryId: string;
  readonly levelId: string;
  /** 上一次的结果：评定写入的行带结果，手工 / 同步的行为空。 */
  readonly lastResult: string | null;
  readonly obtainedDate: string;
  readonly source: 'subset' | 'evaluation';
}

/** 评定回退提供者（C2-8 登记）：子集取不到时按同活动类型取最近一条已发布评定。 */
export type EvaluationPriorProvider = (
  tx: Tx,
  tenantId: string,
  employeeId: string,
  activityTypeId: string,
  asOf: string,
) => Promise<PriorQualification | null>;

let evaluationPrior: EvaluationPriorProvider | null = null;

/** 登记评定回退；返回撤销函数（测试用）。重复登记抛错，避免两处静默覆盖。 */
export function registerEvaluationPriorProvider(provider: EvaluationPriorProvider): () => void {
  if (evaluationPrior) throw new Error('评定回退提供者已登记');
  evaluationPrior = provider;
  return () => {
    if (evaluationPrior === provider) evaluationPrior = null;
  };
}

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

/** 端口入口的 ID 统一规范化为小写 UUID（DEC-194）；不合法抛错，不静默放行。 */
export function normalizedUuid(value: string, label: string): string {
  if (!isUuid(value)) throw new TypeError(`${label}不是合法的 UUID`);
  return value.toLowerCase();
}

/** asOf 必须是真实存在的 YYYY-MM-DD 日期。 */
export function assertIsoDate(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError('asOf 必须是合法的 YYYY-MM-DD 日期');
  }
  return value;
}

interface CurrentRow {
  readonly id: string;
  readonly category_id: string;
  readonly level_id: string;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly is_auto_sync: boolean;
  readonly final_score: string | null;
  readonly result: string | null;
}

export async function currentQualification(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  asOf: string,
): Promise<CurrentQualification | null> {
  const tenant = normalizedUuid(tenantId, '租户 ID');
  const employee = normalizedUuid(employeeId, '员工 ID');
  const day = assertIsoDate(asOf);
  const [row] = rowsOf<CurrentRow>(
    await tx.execute(sql`SELECT id, category_id, level_id, start_date, end_date, is_auto_sync, final_score, result
      FROM personnel_qualification
      WHERE tenant_id = ${tenant}::uuid AND employee_id = ${employee}::uuid AND NOT deleted
        AND start_date <= ${day}::date AND (end_date IS NULL OR end_date >= ${day}::date)
      ORDER BY start_date DESC, created_at DESC, id DESC
      LIMIT 1`),
  );
  if (!row) return null;
  return {
    recordId: row.id,
    categoryId: row.category_id,
    levelId: row.level_id,
    startDate: row.start_date,
    endDate: row.end_date,
    isAutoSync: row.is_auto_sync,
    finalScore: row.final_score === null ? null : Number(row.final_score),
    result: row.result,
  };
}

export async function priorQualificationForApply(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  activityTypeId: string,
  asOf: string,
): Promise<PriorQualification | null> {
  const activity = normalizedUuid(activityTypeId, '活动类型 ID');
  const current = await currentQualification(tx, tenantId, employeeId, asOf);
  if (current) {
    return {
      categoryId: current.categoryId,
      levelId: current.levelId,
      lastResult: current.result,
      obtainedDate: current.startDate,
      source: 'subset',
    };
  }
  return (
    (await evaluationPrior?.(tx, normalizedUuid(tenantId, '租户 ID'), employeeId.toLowerCase(), activity, asOf)) ?? null
  );
}
