/**
 * 任职资格子集初始化命令（R3-T02 C1-5，设计 §4.1 初始化行 / §4.2 / §5.1 点名的批量命令；QL-R15①、DEC-251、DEC-067）。
 * 管理员按员工批（≤ 500）把“历史任职记录”一次性生成任职资格子集，只新增、不更新：
 * - 取数：每名员工租户时区今天及以前已生效的任职记录；业务类型同 C1-4 同步（入职 / 重聘 / 转正 / 调动类，离职 / 退休 /
 *   组织调整不生成，DEC-335② 🟡）；同一天多笔只取当日最后一笔（DEC-108）；
 * // TODO(需取证 #237) 取哪些记录、起止日期、同日多笔、重复与删除后再初始化的原站行为均未取证，以下为设计推荐 🟡
 * - 类别 / 级别：同 C1-4 的唯一映射（sync-mapping，QL-R15 🟢），不唯一或没有命中 → 该记录回执 skipped；
 * - 日期：开始日 = 记录生效日；结束日 = 下一个约束点前一天，约束点取较早的：本批**实际待新增**的下一条记录开始日，与该员工
 *   已有子集（任何来源、未删除）里开始日晚于本行的最早一条的**真实开始日**（统一时间轴，DEC-335①）。分两步算（第 2 轮
 *   R2-P2-01）：先在任何写入之前定出实际待新增的记录（映射唯一且不撞已有行），再算边界；被跳过的记录（NO_MAPPING /
 *   AMBIGUOUS_MAPPING / ALREADY_EXISTS / MANUAL_SAME_DAY）一律不是边界，它们的原任职日期不参与——已有行被 HR 改过开始日时，
 *   以已有行现在的开始日为准。不因中间夹着不生成的记录（如组织调整）而断档 🟡（拆分方案写“日期 = 记录区间”）。
 *   只约束新行自己，不收尾既有行；
 * - 跳过（人工维护优先，DEC-414；第 1 轮 P2-03）：同（类别, 级别, 开始日）或**同一任职记录 ID** 的未删除行 → ALREADY_EXISTS
 *   （含被 HR 改过类别 / 级别 / 开始日的同步行、初始化行，不静默恢复旧值）；同一开始日已有别的未删除行 → MANUAL_SAME_DAY；
 *   已被 HR 删除的行不算“已有”；
 * - 来源 initialization、isAutoSync = false、带任职记录 ID；是人工发起的管理员命令，写入者与审计主体都是操作人。
 *   带记录 ID 使之后同一记录的逐条同步在同日撞上它时按 DEC-414 让路（MANUAL_SAME_DAY），不会重复生成；
 * - 回执只含任职记录 ID、结果与原因，不带记录的业务字段（生效日、岗职务等）：回执不经字段权裁剪，也不替查看人读任职字段；
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
import { mapEmploymentToQualification, type MappingResult } from './sync-mapping.js';
import { SYNCED_KINDS } from './sync-kinds.js';

/** 读取单名员工任职记录的分页（读模型单页上限 200）；超过 MAX_RECORD_PAGES 页视为异常数据，不静默截断。 */
const RECORD_PAGE = 200;
const MAX_RECORD_PAGES = 5;
const DAY_MS = 86_400_000;

export type InitRecordReason = 'ALREADY_EXISTS' | 'MANUAL_SAME_DAY' | 'NO_MAPPING' | 'AMBIGUOUS_MAPPING';

export interface InitRecordReceipt {
  readonly recordId: string;
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

/** 第一步的产物：映射唯一、不撞已有行、实际会新增的一条记录，带写入前快照里它之后最早的已有行开始日。 */
interface Insertion {
  readonly record: EmploymentRecord;
  readonly mapped: Extract<MappingResult, { kind: 'mapped' }>;
  readonly existingNextStart: string | null;
}

async function initializeOne(
  tx: Tx,
  ctx: AccessContext,
  employeeId: string,
  today: string,
): Promise<InitEmployeeReceipt> {
  await lockEmploymentEmployee(tx, ctx, employeeId);
  const records = lastOfEachDay(await effectiveRecords(tx, ctx.tenantId, employeeId, today));
  // 第一步：在任何写入之前定出实际待新增的记录；判重与已有后继都读写入前的快照（第 2 轮 R2-P2-01）
  const steps: (Insertion | InitRecordReceipt)[] = [];
  for (const record of records) steps.push(await classify(tx, ctx.tenantId, record));
  const insertions = steps.filter((step): step is Insertion => !('outcome' in step));
  // 第二步：边界只取实际待新增的下一条与已有行的真实开始日，跳过的记录不参与
  const receipts: InitRecordReceipt[] = [];
  let inserted = 0;
  for (const step of steps) {
    if ('outcome' in step) {
      receipts.push(step);
      continue;
    }
    inserted++;
    const endDate = endDateOf(insertions[inserted]?.record.effectiveDate ?? null, step.existingNextStart);
    receipts.push(await insert(tx, ctx, step, endDate));
  }
  return { employeeId, outcome: 'processed', created: inserted, records: receipts };
}

/** 第一步的单条判定：映射失败或撞上已有行 → 跳过回执；否则是实际待新增的记录。 */
async function classify(tx: Tx, tenantId: string, record: EmploymentRecord): Promise<Insertion | InitRecordReceipt> {
  const skip = (reason: InitRecordReason): InitRecordReceipt => ({ recordId: record.id, outcome: 'skipped', reason });
  const mapped = await mapEmploymentToQualification(tx, tenantId, record.fields, record.effectiveDate);
  if (mapped.kind === 'skipped') return skip(mapped.reason);
  const blocked = await existingRows(tx, tenantId, record, mapped);
  if (blocked) return skip(blocked);
  return { record, mapped, existingNextStart: await existingNextStart(tx, tenantId, record) };
}

async function insert(tx: Tx, ctx: AccessContext, insertion: Insertion, endDate: string | null) {
  const { record, mapped } = insertion;
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
  return { recordId: record.id, outcome: 'created', subsetId: String(saved.id) } as const;
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

/**
 * 同一生效日有多笔时只取最后一笔（DEC-108：同日取最后一次操作）。
 * TODO(需取证 #237) 末笔映射失败时本日不生成；C1-4 同步则保留当日可映射的那笔。推荐统一为“当日最后一笔可成功映射的记录”，
 * 待总编排确认后再改（第 1 轮审查 P3）。
 */
function lastOfEachDay(records: readonly EmploymentRecord[]): EmploymentRecord[] {
  return records.filter((record, index) => records[index + 1]?.effectiveDate !== record.effectiveDate);
}

const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/** 写入前快照里，该员工已有子集（任何来源、未删除）中开始日晚于本记录的最早一条的真实开始日（与 C1-4 落位同一口径）。 */
async function existingNextStart(tx: Tx, tenantId: string, record: EmploymentRecord): Promise<string | null> {
  const [found] = rowsOf<{ start: string | null }>(
    await tx.execute(sql`SELECT min(start_date)::text AS start FROM personnel_qualification
      WHERE tenant_id=${tenantId} AND employee_id=${record.employeeId}::uuid AND NOT deleted
        AND start_date > ${record.effectiveDate}::date`),
  );
  return found?.start ?? null;
}

/** 新行结束日 = 两个约束点中较早的一个的前一天；都没有则开放。只约束新行自己，不改既有行。 */
function endDateOf(nextInsertionStart: string | null, existingNext: string | null): string | null {
  const boundary = [nextInsertionStart, existingNext].filter((date): date is string => date !== null).sort()[0];
  return boundary ? dayBefore(boundary) : null;
}

/**
 * 已有行 → 跳过并给原因，不静默恢复旧值（第 1 轮 P2-03；人工维护优先，DEC-414）：
 * - ALREADY_EXISTS：同（类别, 级别, 开始日）的未删除行，或**同一任职记录 ID** 的未删除行——不论是同步行、初始化行，
 *   还是被 HR 改过类别 / 级别 / 开始日的行（employment_record_id 是系统字段，HR 改不了，改动后仍认得出）；
 * - MANUAL_SAME_DAY：同一开始日已有别的未删除行（组合不同、不是这条记录生成的），不另生成一条同日行。
 * 已被 HR 删除的行不算（见头注释“显式管理员命令”）。
 */
async function existingRows(
  tx: Tx,
  tenantId: string,
  record: EmploymentRecord,
  mapped: Extract<MappingResult, { kind: 'mapped' }>,
): Promise<'ALREADY_EXISTS' | 'MANUAL_SAME_DAY' | null> {
  const found = rowsOf<{ same: boolean; linked: boolean }>(
    await tx.execute(sql`SELECT (category_id=${mapped.categoryId}::uuid AND level_id=${mapped.levelId}::uuid
        AND start_date=${record.effectiveDate}::date) AS same,
        (employment_record_id=${record.id}::uuid) AS linked
      FROM personnel_qualification
      WHERE tenant_id=${tenantId} AND employee_id=${record.employeeId}::uuid AND NOT deleted
        AND (employment_record_id=${record.id}::uuid OR start_date=${record.effectiveDate}::date)`),
  );
  if (found.some((row) => row.same || row.linked)) return 'ALREADY_EXISTS';
  return found.length ? 'MANUAL_SAME_DAY' : null;
}
