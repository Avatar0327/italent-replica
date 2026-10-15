/**
 * 离职的两个占用投影与操作前后差集（docs/08_设计/R2-T03_离职管理设计.md §6B.1，DEC-275②、DEC-496⑤）。
 * O（在职占用）供组织停用计数与反向校验，P（编制占用）供编制峰值与 DEC-258 确认；两者读同一实现，SQL 侧只负责取数。
 * 纯函数、无 IO：区间一律半开 [from, to)，to = null 表示开放；日期是租户业务日（YYYY-MM-DD），比较即字典序。
 */

/** main 的 `EmploymentState`；domain 不能依赖 apps，离职只关心 approved / effective，其余一律视为离职未定或已作废。 */
export type ExitStateName =
  'draft' | 'in_review' | 'approved' | 'rejected' | 'disapproved' | 'voided' | 'effective' | 'deleted';

/** 时间轴上的一条任职记录区间。leave / retirement 记录本身不占用，函数内部会忽略。 */
export interface TimelineSegment {
  readonly recordId: string;
  readonly employeeId: string;
  /** 所属任职周期（`employment_cycles.staff_id`）；离职只作用于同周期。 */
  readonly staffId: string;
  readonly kind: string;
  readonly departmentId: string;
  readonly positionId: string | null;
  readonly capacityId: string | null;
  readonly from: string;
  readonly to: string | null;
}

/** 申请所处阶段：审批中 / 已批准未落地 / 已落地待复查的直接调动（main `pendingTransfers` 的三类输入）。 */
export type ApplicationStage = 'in_review' | 'approved' | 'effective';

/**
 * 申请预占段（main `pendingTransfers` 的结果）：该员工调动申请在目标岗位的预占区间。
 * from = greatest(载荷生效日, 今天)，to = 插入窗口结束；staffId 取载荷 `selectedStaffId`，未选定时由取数侧按生效日所在周期补。
 * 原岗位的“提前扣出”不单列输入：按 timings 从该员工的时间轴记录里扣掉 [from, to)（与 main 一致）。
 */
export interface PreOccupancySegment {
  readonly businessId: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly stage: ApplicationStage;
  readonly departmentId: string;
  readonly positionId: string | null;
  readonly capacityId: string | null;
  readonly from: string;
  readonly to: string | null;
}

/**
 * 离职。effectiveDate：approved 时为计划生效日 E（§5.0A），effective 时为 E′；O 只在 approved 时用它，
 * effective 的时间轴已截断到 L′，不再重复扣。releaseDate = 释放时点 R（审批通过 / 直接离职确认日，同一业务内不变）；
 * nextCycleEntryDate = R 之后下一周期的入职日（`employment_cycles.entry_date > R` 的下一条，没有则 null）。
 */
export interface ExitState {
  readonly businessId: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly state: ExitStateName;
  readonly effectiveDate: string;
  readonly releaseDate: string | null;
  readonly nextCycleEntryDate: string | null;
}

/** 被离职摘下、待挂回的未来调动（§5.8）：摘下它的离职仍为 effective 时不在时间轴上、不计；离职撤销 / 不在输入里则视为已挂回。 */
export interface DetachedWindow {
  readonly segment: TimelineSegment;
  readonly detachedBy: string;
}

export interface OccupancyTimings {
  readonly transferIn: 'submitted' | 'approved';
  readonly transferOut: 'submitted' | 'approved';
}

export interface ExitOccupancyInput {
  readonly records: readonly TimelineSegment[];
  readonly applications: readonly PreOccupancySegment[];
  readonly exits: readonly ExitState[];
  readonly detachedTransfers: readonly DetachedWindow[];
  readonly timings: OccupancyTimings;
}

/** 一段占用：来源（时间轴记录或申请）、组织 / 岗位 / 编制对象与区间。 */
export interface OccupancySegment {
  readonly sourceId: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly departmentId: string;
  readonly positionId: string | null;
  readonly capacityId: string | null;
  readonly from: string;
  readonly to: string | null;
}

/** 内部用的开放终点；比任何业务日都大，输出时还原为 null。 */
const OPEN = '9999-12-31';
const NON_OCCUPYING_KINDS = new Set(['leave', 'retirement']);

interface Span {
  readonly from: string;
  readonly to: string;
}

function closed(from: string, to: string | null): Span {
  const end = to ?? OPEN;
  if (from > end) throw new RangeError(`占用区间倒置：[${from}, ${to ?? '∞'})`);
  return { from, to: end };
}

/** 从 span 里扣掉 cut，返回 0～2 段。 */
function subtractSpan(span: Span, cut: Span): Span[] {
  if (cut.to <= span.from || cut.from >= span.to) return [span];
  return [
    ...(span.from < cut.from ? [{ from: span.from, to: cut.from }] : []),
    ...(span.to > cut.to ? [{ from: cut.to, to: span.to }] : []),
  ];
}

function subtractAll(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  return cuts.reduce<Span[]>((rest, cut) => rest.flatMap((span) => subtractSpan(span, cut)), [...spans]);
}

function segment(
  source: Pick<OccupancySegment, 'employeeId' | 'staffId' | 'departmentId' | 'positionId' | 'capacityId'>,
  sourceId: string,
  span: Span,
): OccupancySegment {
  return {
    sourceId,
    employeeId: source.employeeId,
    staffId: source.staffId,
    departmentId: source.departmentId,
    positionId: source.positionId,
    capacityId: source.capacityId,
    from: span.from,
    to: span.to === OPEN ? null : span.to,
  };
}

function compareText(a: string | null, b: string | null): number {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 确定的输出顺序：员工、部门、岗位、来源、周期、起点，与输入顺序无关。 */
function compareSegments(a: OccupancySegment, b: OccupancySegment): number {
  return (
    compareText(a.employeeId, b.employeeId) ||
    compareText(a.departmentId, b.departmentId) ||
    compareText(a.positionId, b.positionId) ||
    compareText(a.sourceId, b.sourceId) ||
    compareText(a.staffId, b.staffId) ||
    compareText(a.from, b.from)
  );
}

function emit(source: Parameters<typeof segment>[0], sourceId: string, spans: readonly Span[]): OccupancySegment[] {
  return spans.filter((span) => span.from < span.to).map((span) => segment(source, sourceId, span));
}

const sameCycle = (exit: ExitState, subject: { employeeId: string; staffId: string }) =>
  exit.employeeId === subject.employeeId && exit.staffId === subject.staffId;

/** 占用记录：去掉 leave / retirement；被摘下的未来调动只在摘下它的离职不再 effective 时挂回。 */
function activeRecords(input: ExitOccupancyInput): TimelineSegment[] {
  const effective = new Set(input.exits.filter((exit) => exit.state === 'effective').map((exit) => exit.businessId));
  const reattached = input.detachedTransfers
    .filter((item) => !effective.has(item.detachedBy))
    .map((item) => item.segment);
  return [...input.records, ...reattached].filter((record) => !NON_OCCUPYING_KINDS.has(record.kind));
}

/** O：approved 离职从 E 起不计（同周期）。 */
function occupancyO(records: readonly TimelineSegment[], exits: readonly ExitState[]): OccupancySegment[] {
  const cuts = exits.filter((exit) => exit.state === 'approved');
  return records.flatMap((record) => {
    const own = cuts.filter((exit) => sameCycle(exit, record)).map((exit) => closed(exit.effectiveDate, null));
    return emit(record, record.recordId, subtractAll([closed(record.from, record.to)], own));
  });
}

/** 预减区间 [R, 下一周期入职日)：approved / effective 离职，缺少 R 是输入错误（fail-closed，不静默放行）。 */
function releaseCuts(exits: readonly ExitState[]): { exit: ExitState; cut: Span }[] {
  return exits
    .filter((exit) => exit.state === 'approved' || exit.state === 'effective')
    .map((exit) => {
      if (exit.releaseDate === null) throw new RangeError(`离职 ${exit.businessId} 缺少释放时点 R`);
      return { exit, cut: closed(exit.releaseDate, exit.nextCycleEntryDate) };
    });
}

/** 申请是否已按控编时机计入目标 / 已从原岗位扣出（main `projectedMembers`：审批中的申请看租户设置，其余一律已计）。 */
const counted = (stage: ApplicationStage, timing: 'submitted' | 'approved') =>
  timing === 'submitted' || stage !== 'in_review';

/** P：时间轴记录扣掉已计入申请的原岗位窗口，加上目标岗位预占段，再整体扣掉同周期预减区间。 */
function occupancyP(input: ExitOccupancyInput, records: readonly TimelineSegment[]): OccupancySegment[] {
  const cuts = releaseCuts(input.exits);
  const apply = (subject: { employeeId: string; staffId: string }, spans: Span[]) =>
    subtractAll(
      spans,
      cuts.filter(({ exit }) => sameCycle(exit, subject)).map(({ cut }) => cut),
    );
  const origin = (employeeId: string) =>
    input.applications
      .filter((app) => app.employeeId === employeeId && counted(app.stage, input.timings.transferOut))
      .map((app) => closed(app.from, app.to));
  const fromRecords = records.flatMap((record) =>
    emit(
      record,
      record.recordId,
      apply(record, subtractAll([closed(record.from, record.to)], origin(record.employeeId))),
    ),
  );
  const fromApplications = input.applications
    .filter((app) => counted(app.stage, input.timings.transferIn))
    .flatMap((app) => emit(app, app.businessId, apply(app, [closed(app.from, app.to)])));
  return [...fromRecords, ...fromApplications];
}

/** 两个投影由同一函数给出；输入只差离职状态 / 日期 / 挂回与否，前后各算一次再求差集。 */
export function exitOccupancy(input: ExitOccupancyInput): { o: OccupancySegment[]; p: OccupancySegment[] } {
  const records = activeRecords(input);
  return {
    o: occupancyO(records, input.exits).sort(compareSegments),
    p: occupancyP(input, records).sort(compareSegments),
  };
}

const sameObject = (a: OccupancySegment, b: OccupancySegment) =>
  a.employeeId === b.employeeId &&
  a.staffId === b.staffId &&
  a.sourceId === b.sourceId &&
  a.departmentId === b.departmentId &&
  a.positionId === b.positionId &&
  a.capacityId === b.capacityId;

/**
 * 新增占用 = after \ before：按记录 / 申请、组织、岗位、编制对象与周期逐段求差，只留 before 没有覆盖的区间。
 * 被缩小的段（before \ after）不需要校验，反向调用即可得到。
 */
export function newlyOccupied(
  before: readonly OccupancySegment[],
  after: readonly OccupancySegment[],
): OccupancySegment[] {
  return after
    .flatMap((item) => {
      const covered = before.filter((old) => sameObject(old, item)).map((old) => closed(old.from, old.to));
      return emit(item, item.sourceId, subtractAll([closed(item.from, item.to)], covered));
    })
    .sort(compareSegments);
}
