/**
 * 人员流动分析（B50）与流动情况报表（B54）的取数（docs/02_业务建模/35“流动情况各报表的算法”、“补充：BE-13…”B50）。
 * 四类行集各只有一份 SQL，复用人事看板（BE-12b）的同一谓词，并先叠加 DEC-177 可见谓词再交给 TS 计算：
 * - 时点人数：inServiceFrom（与“正式员工 / 实习生”同一谓词），一条语句取多个日期，部门取当天值；
 * - 离职：exitCandidates（离职 + 退休，与“本年离职”同源），部门、序列、关键人员为离职前那段任职的值；看板（B50）按
 *   离职生效日 = 最后工作日 + 1 判断是否在职、归月，报表（B54）按最后工作日归年 / 归月，与人事看板“本年离职”一致（DEC-729）；
 * - 入职：entriesFrom（与“本年入职”同源），按入职任职记录开始日期取；
 * - 调动：业务类型“调动”已生效的单据，按生效日期取，部门为调动后部门，类型取调动申请的异动类型；
 * - 编制：编制模块的组织编制（listCapacities），只取期间覆盖取数日、方案在该日有效的对象，只用于 3.1.36 与组织编制统计。
 * 人员口径都是内部员工 + 实习生（WORKING_TYPES）。
 *
 * 窗口归属（第 3 轮聚合契约，单一入口 attributeWindow）：数据范围在 SQL 里裁剪之后、部门筛选之前，同一员工在统计窗口内
 * 的多条离职 / 入职 / 调动各只留最后一条（日期最晚、同日取单据 / 记录 id 最大），类型 / 原因 / 序列 / 组织 / 属性都取那条。
 * 按窗口计人数的出口（B54 流动统计、各机构、流入、流出；B50 6.27、6.29～6.32）读 window；按月计的出口（B54 各月入离职、
 * B50 6.26 / 6.28、期初）读原始行、在每个月内按员工去重。月表合计按月累加；年度各表按人数，重聘同年多次离职时二者可不等。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { exitCandidates } from '../employment/exit-queries.js';
import { listExitDictionary } from '../employment/exit-dictionaries.js';
import { rowsOf } from '../employment/read-model.js';
import { listCapacities } from '../establishment/capacity-read.js';
import { readTransferCatalog } from '../transfer/configuration.js';
import {
  current,
  employmentVisible,
  employType,
  entriesFrom,
  exitSource,
  inServiceFrom,
  WORKING_TYPES,
  type DashboardAsOf,
} from './hr-dashboard.js';

/** 一条流动记录的人员属性（分段统计用）；departmentId 是该记录归属的部门。 */
export interface MovementPerson {
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly sequenceId: string | null;
  readonly gender: string | null;
  readonly birthday: string | null;
  readonly educationLevel: string | null;
}
export interface MovementExit extends MovementPerson {
  /** 离职 / 退休单据 ID（窗口归属同日并列时取最大）。 */
  readonly billId: string;
  readonly kind: 'leave' | 'retirement';
  readonly lastWorkDate: string;
  /** 离职生效日 = 最后工作日 + 1（最后工作日当天仍在职）。 */
  readonly effectiveDate: string;
  readonly entryDate: string | null;
  readonly keyPerson: boolean;
  readonly typeCode: string | null;
  readonly typeName: string | null;
  readonly reasonCode: string | null;
  readonly reasonName: string | null;
  readonly whereaboutsCode: string | null;
  readonly whereaboutsName: string | null;
}
export interface MovementHire extends MovementPerson {
  readonly recordId: string;
  readonly startDate: string;
}
export interface MovementTransfer {
  readonly businessId: string;
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly effectiveDate: string;
  readonly typeCode: string | null;
}
export interface MovementData {
  /** 日期 → 当天在职的人（每人一行）。 */
  readonly snapshots: ReadonlyMap<string, readonly { employeeId: string; departmentId: string | null }[]>;
  readonly exits: readonly MovementExit[];
  readonly hires: readonly MovementHire[];
  readonly transfers: readonly MovementTransfer[];
  /** 统计窗口内每人最后一条（attributeWindow），按窗口计人数的出口只读这里。 */
  readonly window: MovementRecords;
  /** 调动异动类型编码 → 名称（asOf 当天的调动字典）。 */
  readonly transferTypes: ReadonlyMap<string, string>;
}

export interface MovementRecords {
  readonly exits: readonly MovementExit[];
  readonly hires: readonly MovementHire[];
  readonly transfers: readonly MovementTransfer[];
}

/** 同一员工只留 order 最大的一条（按字符串逐项比较：日期 YYYY-MM-DD、ID 小写 uuid，与 SQL 的排序一致）。 */
function latestPerEmployee<T extends { employeeId: string }>(
  items: readonly T[],
  order: (item: T) => readonly string[],
) {
  const later = (a: readonly string[], b: readonly string[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
    return false;
  };
  const latest = new Map<string, T>();
  for (const item of items) {
    const kept = latest.get(item.employeeId);
    if (!kept || later(order(item), order(kept))) latest.set(item.employeeId, item);
  }
  return items.filter((item) => latest.get(item.employeeId) === item);
}
/**
 * 窗口归属的唯一实现：离职按（最后工作日, 单据 id）、入职按（开始日期, 任职记录 id）、调动按（生效日期, 单据 id）取最后一条。
 * 离职生效日 = 最后工作日 + 1，看板按生效日开窗也是同一顺序。
 */
export function attributeWindow(records: MovementRecords): MovementRecords {
  return {
    exits: latestPerEmployee(records.exits, (e) => [e.lastWorkDate, e.billId]),
    hires: latestPerEmployee(records.hires, (h) => [h.startDate, h.recordId]),
    transfers: latestPerEmployee(records.transfers, (t) => [t.effectiveDate, t.businessId]),
  };
}

/** 离职按哪个日期落进统计区间：看板按离职生效日（B50），报表按最后工作日（B54，DEC-729）。 */
export type ExitDating = 'effectiveDate' | 'lastWorkDate';

type MovementContext = Pick<DashboardAsOf, 'tenantId' | 'asOf' | 'scope'>;
const WORKING = sql.join(
  WORKING_TYPES.map((type) => sql`${type}`),
  sql`, `,
);
const dateArray = (days: readonly string[]) => sql`${`{${days.join(',')}}`}::date[]`;

/** 人事档案的性别 / 出生日期 / 学历（最新版本，与 BE-13a structurePeople 同口径）；m.employee_id 是员工。 */
const PROFILE = sql`LEFT JOIN LATERAL (SELECT v.gender, v.birthday::text AS birthday,
    v.education_level AS "educationLevel" FROM personnel_employee_versions v
  WHERE v.tenant_id=m.tenant_id AND v.employee_id=m.employee_id ORDER BY v.revision DESC LIMIT 1) pv ON true`;

async function snapshots(tx: Tx, a: MovementContext, days: readonly string[]) {
  const rows = rowsOf<{ day: string; employeeId: string; departmentId: string | null }>(
    await tx.execute(sql`SELECT d.day::text AS day, m.employee_id AS "employeeId", m.org_id AS "departmentId"
      FROM unnest(${dateArray(days)}) d(day)
      JOIN LATERAL (SELECT DISTINCT ON (r.employee_id) r.employee_id, ${current('department_id')} AS org_id,
          NULL::uuid AS creator_id
        ${inServiceFrom({ tenantId: a.tenantId, asOf: sql`d.day` }, employType(WORKING_TYPES))}
        ORDER BY r.employee_id, t.start_date DESC, t.sort_order DESC) m ON true
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY day, m.employee_id`),
  );
  const byDay = new Map<string, { employeeId: string; departmentId: string | null }[]>(days.map((d) => [d, []]));
  for (const { day, ...person } of rows) byDay.get(day)?.push(person);
  return byDay;
}

/** 离职落进 [from, to] 的条件：两种口径各写一处，不共用一个表达式（DEC-729）。 */
const EXIT_DATED: Readonly<Record<ExitDating, (from: string, to: string) => SQL>> = {
  effectiveDate: (from, to) => sql`p.last_work_date + 1 BETWEEN ${from}::date AND ${to}::date`,
  lastWorkDate: (from, to) => sql`p.last_work_date BETWEEN ${from}::date AND ${to}::date`,
};

/** 序列与关键人员取 exitCandidates 的前驱记录 prev（离职前最后一段任职的最新记录快照，没有快照取底表）。 */
function exitRows(a: MovementContext, kind: 'leave' | 'retirement', window: ExitWindow): SQL {
  const source = exitSource(kind);
  const extended = {
    ...source,
    columns: sql`${source.columns} dc.entry_date::text AS "entryDate", prev.sequence_id AS "sequenceId",
      prev.is_key_person AS "keyPerson",`,
  };
  const where = sql`s.state='effective' AND ${EXIT_DATED[window.dating](window.from, window.to)}
    AND dc.employ_type IN (${WORKING})`;
  return sql`SELECT ${kind}::text AS kind, x.id AS "billId", x."employeeId" AS employee_id, x."departmentId" AS org_id,
      NULL::uuid AS creator_id, ${a.tenantId}::uuid AS tenant_id, x."employeeId", x."departmentId", x."sequenceId",
      x."lastWorkDate", x."entryDate", x."keyPerson", x."exitTypeCode", x."exitTypeName", x."reasonCode",
      x."reasonName", x."whereaboutsCode", x."whereaboutsName"
    FROM (${exitCandidates(a.tenantId, undefined, [where], sql`b.id`, extended)}) x`;
}

interface ExitWindow {
  readonly from: string;
  readonly to: string;
  readonly dating: ExitDating;
}
async function exits(tx: Tx, a: MovementContext, window: ExitWindow) {
  return rowsOf<MovementExit>(
    await tx.execute(sql`SELECT m.kind, m."billId", m."employeeId", m."departmentId", m."sequenceId", m."lastWorkDate",
        (m."lastWorkDate"::date + 1)::text AS "effectiveDate", m."entryDate", m."keyPerson",
        m."exitTypeCode" AS "typeCode", m."exitTypeName" AS "typeName", m."reasonCode", m."reasonName",
        m."whereaboutsCode", m."whereaboutsName", pv.*
      FROM (${exitRows(a, 'leave', window)} UNION ALL ${exitRows(a, 'retirement', window)}) m
      ${PROFILE}
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY "effectiveDate", m."employeeId"`),
  );
}

async function hires(tx: Tx, a: MovementContext, from: string, to: string) {
  return rowsOf<MovementHire>(
    await tx.execute(sql`SELECT m.record_id AS "recordId", m.employee_id AS "employeeId", m.org_id AS "departmentId",
        m."sequenceId", m."startDate", pv.*
      FROM (SELECT r.tenant_id, r.id AS record_id, r.employee_id, ${current('department_id')} AS org_id,
          NULL::uuid AS creator_id,
          ${current('sequence_id')} AS "sequenceId", t.start_date::text AS "startDate"
        ${entriesFrom({ tenantId: a.tenantId, asOf: to }, 'hired', from)}) m
      ${PROFILE}
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY m."startDate", m.employee_id`),
  );
}

/**
 * 只算业务类型“调动”（docs/02_业务建模/35 B50 6.27）：转正带调动、组织调整引起的调动是别的业务类型，不计。
 * 雇佣关系取调动形成的任职记录的当前值（有快照取快照），只计内部员工 + 实习生（审查 P2-3）。
 */
async function transfers(tx: Tx, a: MovementContext, from: string, to: string) {
  return rowsOf<MovementTransfer>(
    await tx.execute(sql`SELECT m.business_id AS "businessId", m.employee_id AS "employeeId",
        m.org_id AS "departmentId", m."effectiveDate", m."typeCode"
      FROM (SELECT b.id AS business_id, b.employee_id, p.department_id AS org_id, NULL::uuid AS creator_id,
          p.effective_date::text AS "effectiveDate", tr.transfer_type_code AS "typeCode"
        FROM employment_business_objects b
        JOIN LATERAL (SELECT p.* FROM employment_payload_versions p
          WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
        JOIN LATERAL (SELECT s.state FROM employment_state_events s
          WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
        JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id
        LEFT JOIN LATERAL (SELECT v.id, v.employ_type FROM employment_payload_versions v
          WHERE v.tenant_id=r.tenant_id AND v.business_id=r.id AND v.is_record_snapshot
          ORDER BY v.version_no DESC LIMIT 1) snap ON true
        LEFT JOIN transfer_requests tr ON tr.tenant_id=b.tenant_id AND tr.business_id=b.id
        WHERE b.tenant_id=${a.tenantId} AND p.kind='transfer' AND s.state='effective'
          AND p.effective_date BETWEEN ${from}::date AND ${to}::date AND ${employType(WORKING_TYPES)}) m
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY m."effectiveDate", m.employee_id`),
  );
}

export interface MovementWindow {
  readonly days: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly exitDating: ExitDating;
}
/**
 * 一次取齐：days 是要取时点人数的日期，[from, to] 是入职 / 离职 / 调动的统计区间（to ≤ asOf），
 * exitDating 是离职落进区间的日期口径。
 */
export async function loadMovement(tx: Tx, a: MovementContext, window: MovementWindow): Promise<MovementData> {
  const { from, to } = window;
  const catalog = await readTransferCatalog(tx, a.tenantId, a.asOf);
  const records = {
    exits: await exits(tx, a, { from, to, dating: window.exitDating }),
    hires: await hires(tx, a, from, to),
    transfers: await transfers(tx, a, from, to),
  };
  return {
    snapshots: await snapshots(tx, a, [...new Set(window.days)]),
    ...records,
    window: attributeWindow(records),
    transferTypes: new Map(catalog.types.map((type) => [type.code, type.name])),
  };
}

/** 只取时点人数（组织编制页签只用实有人员，不加载整年流动数据）。 */
export async function loadSnapshots(tx: Tx, a: MovementContext, days: readonly string[]): Promise<MovementData> {
  const none = { exits: [], hires: [], transfers: [] };
  return { snapshots: await snapshots(tx, a, [...new Set(days)]), ...none, window: none, transferTypes: new Map() };
}

/** 3.1.36 / 组织编制统计的一行：一个组织在取数日所在编制期间的组织编制（本级 / 含下级）。 */
export interface MovementEstablishment {
  readonly id: string;
  readonly orgId: string;
  readonly localCapacity: number | null;
  readonly inclusiveCapacity: number | null;
}
const CAPACITY_PAGE = 200;
const CAPACITY_LIMIT = 5_000;

/**
 * 编制模块的组织编制：取数日 day 时各编制对象的最新版本，只取期间覆盖 day（开始 ≤ day ≤ 结束）、方案在 day 有效的对象，
 * 过滤在 SQL 里做（listCapacities 的 covering），按数据范围裁剪（scopeSql / 创建人范围照旧）。已结束方案的历史对象
 * 不进候选，不会因“方案在该时点不存在”让整板报 404，也不占 5000 的上限。取满 5000 条后再探第 5001 条，确有才报 413。
 * 预增员 / 预减员按组织汇总的读接口尚未抽出（F-418），这里只取编制数。
 */
export async function loadEstablishment(
  tx: Tx,
  a: Pick<DashboardAsOf, 'tenantId' | 'scope'>,
  day: string,
): Promise<MovementEstablishment[]> {
  const read = (limit: number, offset: number) =>
    listCapacities(tx, a.tenantId, day, { scope: a.scope, covering: day }, { limit, offset });
  const rows: MovementEstablishment[] = [];
  for (let offset = 0; offset < CAPACITY_LIMIT; offset += CAPACITY_PAGE) {
    const page = await read(CAPACITY_PAGE, offset);
    rows.push(
      ...page.map((capacity) => ({
        id: capacity.id,
        orgId: capacity.orgId,
        localCapacity: capacity.localCapacity,
        inclusiveCapacity: capacity.inclusiveCapacity,
      })),
    );
    if (page.length < CAPACITY_PAGE) return rows;
  }
  if ((await read(1, CAPACITY_LIMIT)).length) throw new AppError('PAYLOAD_TOO_LARGE', '编制对象超过单次统计上限');
  return rows;
}

/** 离职类型 / 原因字典（启用项，按显示顺序）：流出统计按它展开列，未用到的填 0（审查 P2-8）。 */
export async function loadExitDictionaries(tx: Tx, tenantId: string) {
  const pick = (items: readonly { code: string; name: string }[]) => items.map(({ code, name }) => ({ code, name }));
  return {
    types: pick(await listExitDictionary(tx, tenantId, 'types', { enabled: true })),
    reasons: pick(await listExitDictionary(tx, tenantId, 'reasons', { enabled: true })),
  };
}
export type ExitDictionaries = Awaited<ReturnType<typeof loadExitDictionaries>>;
