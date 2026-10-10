/**
 * 任职资格子集初始化命令（R3-T02 C1-5，设计 §4.1 初始化行 / §4.2 / §5.1 点名的批量命令；QL-R15①、DEC-251、DEC-067）。
 * 管理员按员工批（≤ 500）把“历史任职记录”一次性生成任职资格子集，只新增、不更新：
 * - 取数：每名员工租户时区今天及以前已生效的任职记录；业务类型同 C1-4 同步（入职 / 重聘 / 转正 / 调动类，离职 / 退休 /
 *   组织调整不生成，DEC-335② 🟡）；同一天多笔只取当日最后一笔（DEC-108）；
 * - 类别 / 级别：同 C1-4 的唯一映射（sync-mapping，QL-R15 🟢），不唯一或没有命中 → 该记录回执 skipped；
 * - 日期：开始日 = 记录生效日；结束日 = 下一条参与生成的记录开始日前一天，没有则开放。与 C1-4 逐条同步的结果一致
 *   （统一时间轴，DEC-335①），不因中间夹着不生成的记录（如组织调整）而断档 🟡（拆分方案写“日期 = 记录区间”）；
 * - 跳过：已有同（员工, 类别, 级别, 开始日）的未删除行 → ALREADY_EXISTS，重复执行不重复生成；已被 HR 删除的行不算“已有”；
 * - 来源 initialization、isAutoSync = false、带任职记录 ID；是人工发起的管理员命令，写入者与审计主体都是操作人。
 *   带记录 ID 使之后同一记录的逐条同步在同日撞上它时按 DEC-414 让路（MANUAL_SAME_DAY），不会重复生成；
 * - 范围：逐名员工检查操作人在子集对象上的人员范围（与 HR 逐个新增同一谓词）；范围外与不存在同一回执
 *   EMPLOYEE_NOT_FOUND，不透露是否存在，不带任何其他信息；
 * - 整批一个事务（命令台账幂等、同键同内容返回首次结果）；需要部分成功的情形用逐条回执表达，不靠局部回滚。
 * 锁序同 C1-4：先任职员工锁（与任职写入 / 删除 / 改期互斥）、再 saveSubset 内的人员锁；多名员工按 ID 升序取锁，
 * 两个批次交叠时不会互相等待成环。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import { listEmploymentRecords } from '../employment/read-model.js';
import type { EmploymentRecord } from '../employment/types.js';
import { personScope, type AccessContext } from '../personnel/access.js';
import { saveSubset } from '../personnel/subsets.js';
import { mapEmploymentToQualification } from './sync-mapping.js';
import { SYNCED_KINDS } from './sync-kinds.js';

/** 读取单名员工任职记录的分页（读模型单页上限 200）；超过 MAX_RECORD_PAGES 页视为异常数据，不静默截断。 */
const RECORD_PAGE = 200;
const MAX_RECORD_PAGES = 5;
const DAY_MS = 86_400_000;

export type InitRecordReason = 'ALREADY_EXISTS' | 'NO_MAPPING' | 'AMBIGUOUS_MAPPING';

export interface InitRecordReceipt {
  readonly recordId: string;
  readonly effectiveDate: string;
  readonly outcome: 'created' | 'skipped';
  readonly reason?: InitRecordReason;
  /** 生成的子集行 ID（created 时有）。 */
  readonly subsetId?: string;
}

export type InitEmployeeReceipt =
  | { readonly employeeId: string; readonly outcome: 'skipped'; readonly reason: 'EMPLOYEE_NOT_FOUND' }
  | {
      readonly employeeId: string;
      readonly outcome: 'processed';
      readonly created: number;
      readonly records: readonly InitRecordReceipt[];
    };

export interface InitResult {
  readonly items: readonly InitEmployeeReceipt[];
}

const NOT_FOUND = (employeeId: string): InitEmployeeReceipt => ({
  employeeId,
  outcome: 'skipped',
  reason: 'EMPLOYEE_NOT_FOUND',
});

/** 请求里员工中，当前在操作人人员范围内的那些（分页之前的集合谓词；不存在的员工同样不在结果里）。 */
export async function employeesInScope(
  tx: Tx,
  ctx: AccessContext,
  employeeIds: readonly string[],
): Promise<Set<string>> {
  const found = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT e.id FROM employment_employees e
      WHERE e.tenant_id=${ctx.tenantId} AND e.id = ANY(${`{${employeeIds.join(',')}}`}::uuid[])
        AND ${personScope(ctx)}`),
  );
  return new Set(found.map((row) => row.id));
}

export async function initializeQualificationSubsets(
  tx: Tx,
  ctx: AccessContext,
  employeeIds: readonly string[],
): Promise<InitResult> {
  const inScope = await employeesInScope(tx, ctx, employeeIds);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const done = new Map<string, InitEmployeeReceipt>();
  for (const employeeId of [...inScope].sort()) {
    done.set(employeeId, await initializeOne(tx, ctx, employeeId, today));
  }
  return { items: employeeIds.map((employeeId) => done.get(employeeId) ?? NOT_FOUND(employeeId)) };
}

async function initializeOne(
  tx: Tx,
  ctx: AccessContext,
  employeeId: string,
  today: string,
): Promise<InitEmployeeReceipt> {
  await lockEmploymentEmployee(tx, ctx, employeeId);
  const records = lastOfEachDay(await effectiveRecords(tx, ctx.tenantId, employeeId, today));
  const receipts: InitRecordReceipt[] = [];
  for (const [index, record] of records.entries()) {
    const next = records[index + 1];
    receipts.push(await initializeRecord(tx, ctx, record, next ? dayBefore(next.effectiveDate) : null));
  }
  return {
    employeeId,
    outcome: 'processed',
    created: receipts.filter((receipt) => receipt.outcome === 'created').length,
    records: receipts,
  };
}

async function initializeRecord(
  tx: Tx,
  ctx: AccessContext,
  record: EmploymentRecord,
  endDate: string | null,
): Promise<InitRecordReceipt> {
  const base = { recordId: record.id, effectiveDate: record.effectiveDate };
  const mapped = await mapEmploymentToQualification(tx, ctx.tenantId, record.fields, record.effectiveDate);
  if (mapped.kind === 'skipped') return { ...base, outcome: 'skipped', reason: mapped.reason };
  if (await alreadyExists(tx, ctx.tenantId, record.employeeId, mapped.categoryId, mapped.levelId, record.effectiveDate))
    return { ...base, outcome: 'skipped', reason: 'ALREADY_EXISTS' };
  const saved = await saveSubset(
    tx,
    { ...ctx, expectedRevision: 0 },
    record.employeeId,
    'qualification',
    {
      categoryId: mapped.categoryId,
      levelId: mapped.levelId,
      startDate: record.effectiveDate,
      endDate,
      employmentRecordId: record.id,
      isAutoSync: false,
    },
    undefined,
    false,
    { type: 'initialization', id: record.id },
  );
  return { ...base, outcome: 'created', subsetId: String(saved.id) };
}

/** 今天及以前已生效、且业务类型参与生成的任职记录，按时间轴顺序（读模型已按开始日、同日顺序号排序）。 */
async function effectiveRecords(tx: Tx, tenantId: string, employeeId: string, today: string) {
  const all: EmploymentRecord[] = [];
  for (let page = 0; page < MAX_RECORD_PAGES; page++) {
    const batch = await listEmploymentRecords(tx, tenantId, employeeId, today, {
      limit: RECORD_PAGE,
      offset: page * RECORD_PAGE,
    });
    all.push(...batch);
    if (batch.length < RECORD_PAGE) break;
    if (page === MAX_RECORD_PAGES - 1) throw new RangeError('员工任职记录过多，无法初始化任职资格');
  }
  return all.filter((record) => record.effectiveDate <= today && SYNCED_KINDS.has(record.kind));
}

/** 同一生效日有多笔时只取最后一笔（DEC-108：同日取最后一次操作）。 */
function lastOfEachDay(records: readonly EmploymentRecord[]): EmploymentRecord[] {
  return records.filter((record, index) => records[index + 1]?.effectiveDate !== record.effectiveDate);
}

const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

async function alreadyExists(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  categoryId: string,
  levelId: string,
  startDate: string,
): Promise<boolean> {
  const [found] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT 1 AS n FROM personnel_qualification
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND category_id=${categoryId}::uuid
        AND level_id=${levelId}::uuid AND start_date=${startDate}::date AND NOT deleted LIMIT 1`),
  );
  return Boolean(found);
}
