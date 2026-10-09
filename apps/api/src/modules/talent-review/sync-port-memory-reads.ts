/**
 * 同步端口替身的状态、测试控制面与读取部分（SP-06 三档选择器、SP-15 / SP-16 健康度、准备度）。
 * - 无 run 的读取按 viewer 当前授权逐字段 / 逐员工 / 逐组织返回 forbidden，组织 / 职位聚合不带查看人无权读的源员工的提名，
 *   提名表单字段逐个裁剪；绿化率不计查看人无权读的员工，组织无权时 forbidden 且不带数值与来源；
 * - 健康度回写先校验租户，再逐组织按当前凭据授权，最后才查命令台账（同键须同指纹，DEC-067）；重放同样按当前授权重判，
 *   被拒的行不带真实等级、版本与手动标记。写入在本替身的事务里进行（sync-port-memory-tx.ts）。
 */
import type { Tx } from '@italent/db';
import type {
  ConsumptionState,
  FieldRead,
  GreenRateResult,
  IsoDate,
  OrgHealthContext,
  OrgHealthOutcome,
  OrgHealthResetCommand,
  OrgHealthRowState,
  OrgHealthWriteCommand,
  OrgHealthWriteReceipt,
  OutcomeItem,
  PageCommit,
  ReviewFieldDescriptor,
  ReviewFieldReadResult,
  ReviewSource,
  ReviewSourceContext,
  SourceViewer,
  SuccessionReadResult,
  SyncConsumer,
  SyncNomination,
  SyncObjectResult,
  SyncOrgHealth,
  SyncRunHeader,
} from '@italent/domain';
import type { ReadinessLevel } from './readiness-port.js';
import { MemoryTransactions, type MemoryTx } from './sync-port-memory-tx.js';
import { SyncPortError, type TalentReviewSyncPort } from './sync-port.js';

export interface InMemorySyncRun {
  readonly header: SyncRunHeader;
  readonly objects: readonly SyncObjectResult[];
  readonly nominations: readonly SyncNomination[];
  readonly orgHealth: readonly SyncOrgHealth[];
}
/** 三档选择器的候选盘点（SP-06）：项目级 meetingId = null；校准会的会中对象另起一条 meetingId 非空的来源。 */
export interface InMemoryReviewSource {
  readonly projectId: string;
  readonly meetingId: string | null;
  readonly code: string;
  readonly status: 'in_progress' | 'ended';
  readonly periodStartDate: IsoDate;
  readonly periodEndDate: IsoDate;
  readonly businessDate: IsoDate | null;
  readonly objects: readonly {
    readonly employeeId: string;
    readonly orgId: string;
    readonly terminated?: boolean;
    readonly fields: Readonly<Record<string, FieldRead>>;
    /** null = 所用模板没有继任模块（module_absent）；[] = 有模块、零提名。 */
    readonly succession: readonly SyncNomination[] | null;
    readonly placement?: {
      readonly matrixId: string;
      readonly placement: number | null;
      readonly countsGreen: boolean;
    };
  }[];
}
type SourceObject = InMemoryReviewSource['objects'][number];
export interface InMemoryHealthRow {
  readonly context: OrgHealthContext;
  readonly orgId: string;
  readonly levelId: string | null;
  readonly levelCode: string | null;
  readonly status: 'value' | 'empty';
  readonly manual: boolean;
  readonly method: 'computed' | 'manual';
  readonly revision: number;
}
export interface InMemorySyncData {
  readonly tenantId: string;
  readonly now?: Date;
  /** 已登记的消费方：冻结时为每个消费方预建 pending 回执（SP-02）；缺省只有 succession。 */
  readonly consumers?: readonly SyncConsumer[];
  readonly runs?: readonly InMemorySyncRun[];
  readonly fields?: readonly ReviewFieldDescriptor[];
  readonly sources?: readonly InMemoryReviewSource[];
  readonly healthRows?: readonly InMemoryHealthRow[];
  readonly readiness?: readonly ReadinessLevel[];
}

export interface Consumption {
  readonly status: ConsumptionState['status'];
  readonly executionNo: number;
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
  readonly sealed: boolean;
  readonly targetCount: number;
  readonly planCommandId: string | null;
  readonly planDigest: string | null;
  readonly planCommit: PageCommit | null;
  readonly terminalCode: ConsumptionState['terminalCode'];
  readonly terminalRecovery: ConsumptionState['terminalRecovery'];
}
interface Denied {
  employeeIds: string[];
  fieldCodes: string[];
  orgIds: string[];
}
export interface MemoryState {
  now: Date;
  readonly runs: Map<string, InMemorySyncRun>;
  readonly consumptions: Map<string, Consumption>;
  readonly outcomes: Map<string, OutcomeItem>;
  /** 页提交证明与该页回执的完整指纹（同页重放须同内容）。 */
  readonly commits: Map<string, { readonly commit: PageCommit; readonly digest: string }>;
  /** 源读取主体的撤权（SP-07）。 */
  readonly revoked: { principal: boolean; owner: boolean; project: boolean } & Denied & {
      objectIds: string[];
      sources: { objectId: string; source: string }[];
    };
  /** 无 run 读取的查看人撤权（SP-06）。 */
  readonly viewers: Map<string, Denied>;
  /** 健康度回写授权：forbidden = 缺按钮 / 对象权；orgIds = 不在范围的组织（SP-16）。 */
  readonly healthAccess: Map<string, { forbidden: boolean; orgIds: string[] }>;
  readonly health: Map<string, InMemoryHealthRow>;
  readonly healthLedger: Map<string, { readonly digest: string; readonly receipt: OrgHealthWriteReceipt }>;
  readonly endedProjects: string[];
}

type Args<K extends keyof TalentReviewSyncPort> = Parameters<TalentReviewSyncPort[K]>[1];
type HealthItem = OrgHealthWriteReceipt['items'][number];

const healthKey = (context: OrgHealthContext, orgId: string) =>
  `${context.projectId}|${context.meetingId ?? ''}|${orgId}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const effectiveDate = (s: InMemoryReviewSource) => s.businessDate ?? s.periodStartDate;
const NONE: Denied = { employeeIds: [], fieldCodes: [], orgIds: [] };
/** 被拒的健康度行：不带存在性、版本与值。 */
const rejected = (orgId: string, outcome: 'FORBIDDEN' | 'OUT_OF_SCOPE'): HealthItem => ({
  orgId,
  outcome,
  currentRevision: 0,
  currentLevelId: null,
  currentManual: false,
});

export class InMemoryReads {
  protected readonly state: MemoryState;
  protected readonly consumers: readonly SyncConsumer[];
  protected readonly txs = new MemoryTransactions();

  constructor(protected readonly data: InMemorySyncData) {
    this.consumers = data.consumers ?? ['succession'];
    this.state = {
      now: data.now ?? new Date('2026-10-09T00:00:00Z'),
      runs: new Map((data.runs ?? []).map((run) => [run.header.runId, structuredClone(run)])),
      consumptions: new Map(),
      outcomes: new Map(),
      commits: new Map(),
      revoked: { principal: false, owner: false, project: false, ...structuredClone(NONE), objectIds: [], sources: [] },
      viewers: new Map(),
      healthAccess: new Map(),
      health: new Map((data.healthRows ?? []).map((row) => [healthKey(row.context, row.orgId), row])),
      healthLedger: new Map(),
      endedProjects: [],
    };
    for (const run of this.state.runs.values()) this.prebuild(run);
  }

  // ---- 测试控制面（非事务）----
  now(): Date {
    return this.state.now;
  }
  advance(seconds: number): void {
    this.state.now = new Date(this.state.now.getTime() + seconds * 1000);
  }
  /** 撤销源读取主体的授权（SP-07）；对象、字段、来源、组织逐项累加。 */
  revoke(change: Partial<MemoryState['revoked']>): void {
    const r = this.state.revoked;
    Object.assign(r, {
      principal: change.principal ?? r.principal,
      owner: change.owner ?? r.owner,
      project: change.project ?? r.project,
      objectIds: [...r.objectIds, ...(change.objectIds ?? [])],
      fieldCodes: [...r.fieldCodes, ...(change.fieldCodes ?? [])],
      sources: [...r.sources, ...(change.sources ?? [])],
      orgIds: [...r.orgIds, ...(change.orgIds ?? [])],
    });
  }
  denyViewer(userId: string, denied: Partial<Denied>): void {
    this.state.viewers.set(userId, { ...structuredClone(NONE), ...denied });
  }
  denyHealthWrite(userId: string, access: { forbidden?: boolean; orgIds?: string[] }): void {
    this.state.healthAccess.set(userId, { forbidden: access.forbidden ?? false, orgIds: access.orgIds ?? [] });
  }
  endProject(projectId: string): void {
    this.state.endedProjects.push(projectId);
  }

  // ---- 字段目录与三档取数（SP-06）----
  async listReviewFields(_tx: Tx, input: { tenantId: string }): Promise<readonly ReviewFieldDescriptor[]> {
    if (input.tenantId !== this.data.tenantId) return [];
    // SP-17：多选字段取证前不参与公式
    return (this.data.fields ?? []).map((f) => (f.kind === 'multi_option' ? { ...f, formulaUsable: false } : f));
  }

  async readReviewFields(
    _tx: Tx,
    input: Args<'readReviewFields'>,
  ): Promise<ReadonlyMap<string, ReviewFieldReadResult>> {
    const denied = this.deniedFor(input.viewer);
    const result = new Map<string, ReviewFieldReadResult>();
    for (const employeeId of input.employeeIds) {
      const forbidden = denied.employeeIds.includes(employeeId);
      const found = forbidden ? null : this.resolve(input.tenantId, (o) => o.employeeId === employeeId, input.context);
      const value = (code: string): FieldRead => {
        if (forbidden || denied.fieldCodes.includes(code)) return { status: 'forbidden', value: null };
        if (!found) return { status: 'unavailable', value: null };
        return found.object?.fields[code] ?? { status: 'empty', value: null };
      };
      const values = Object.fromEntries(input.fieldCodes.map((code) => [code, value(code)]));
      result.set(employeeId, { values, source: found?.source ?? null });
    }
    return result;
  }

  async readSuccessionEntries(_tx: Tx, input: Args<'readSuccessionEntries'>): Promise<readonly SuccessionReadResult[]> {
    const denied = this.deniedFor(input.viewer);
    const forbidden = { status: 'forbidden' as const, nominations: [], source: null };
    const byEmployee = (input.employeeIds ?? []).map((employeeId) => {
      const base = { employeeId, orgId: null, positionId: null };
      if (denied.employeeIds.includes(employeeId)) return { ...base, ...forbidden };
      const found = this.resolve(input.tenantId, (o) => o.employeeId === employeeId, input.context);
      return { ...base, ...this.succession(found, null, denied) };
    });
    const byOrg = (input.orgIds ?? []).map((orgId) => {
      const base = { employeeId: null, orgId, positionId: null };
      if (denied.orgIds.includes(orgId)) return { ...base, ...forbidden };
      const found = this.resolve(input.tenantId, (o) => o.orgId === orgId, input.context);
      const match = (n: SyncNomination) => n.kind === 'org' && n.direction === 'successor' && n.orgId === orgId;
      return { ...base, ...this.succession(found, match, denied) };
    });
    const byPosition = (input.positionIds ?? []).map((positionId) => {
      const match = (n: SyncNomination) =>
        n.kind === 'position' && n.direction === 'successor' && n.positionId === positionId;
      const found = this.resolve(input.tenantId, (o) => !!o.succession?.some(match), input.context);
      return { employeeId: null, orgId: null, positionId, ...this.succession(found, match, denied) };
    });
    return [...byEmployee, ...byOrg, ...byPosition];
  }

  async greenRate(_tx: Tx, input: Args<'greenRate'>): Promise<ReadonlyMap<string, GreenRateResult>> {
    const denied = this.deniedFor(input.viewer);
    const result = new Map<string, GreenRateResult>();
    const empty = { green: 0, placed: 0, rate: null, source: null };
    for (const orgId of input.orgIds) {
      if (denied.orgIds.includes(orgId)) {
        result.set(orgId, { status: 'forbidden', ...empty });
        continue;
      }
      const found = this.resolve(input.tenantId, (o) => o.orgId === orgId, input.context);
      const placed = (found?.raw.objects ?? []).filter(
        (o) => o.orgId === orgId && !o.terminated && o.placement && !denied.employeeIds.includes(o.employeeId),
      );
      const matrixId = placed[0]?.placement?.matrixId;
      if (!found || !matrixId) {
        result.set(orgId, { status: 'unavailable', ...empty });
        continue;
      }
      const counted = placed.filter((o) => o.placement!.placement !== null);
      const green = counted.filter((o) => o.placement!.countsGreen).length;
      // 分母 0 → rate = null（DEC-305④）
      const rate = counted.length ? green / counted.length : null;
      result.set(orgId, {
        status: 'value',
        green,
        placed: counted.length,
        rate,
        source: { ...found.source, matrixId },
      });
    }
    return result;
  }

  // ---- 健康度（SP-15 / SP-16）----
  async readOrgHealthRows(_tx: Tx, input: Args<'readOrgHealthRows'>): Promise<readonly OrgHealthRowState[]> {
    const denied = this.deniedFor(input.viewer);
    return input.orgIds.map((orgId): OrgHealthRowState => {
      const context = input.context;
      if (input.tenantId !== this.data.tenantId || denied.orgIds.includes(orgId)) {
        return { status: 'forbidden', orgId, context };
      }
      const row = this.state.health.get(healthKey(context, orgId));
      if (!row) return { status: 'absent', orgId, context, revision: 0 };
      const { levelId, levelCode, manual, method, revision, status } = row;
      return { status, orgId, context, levelId, levelCode, manual, method, revision };
    });
  }

  recordOrgHealth(tx: Tx, input: OrgHealthWriteCommand): Promise<OrgHealthWriteReceipt> {
    return this.txs.within(tx, (m) => this.writeHealth(m, input));
  }

  resetOrgHealth(tx: Tx, input: OrgHealthResetCommand): Promise<OrgHealthWriteReceipt> {
    return this.txs.within(tx, (m) => this.writeHealth(m, input));
  }

  async listReadinessLevels(_tx: Tx, input: { tenantId: string }): Promise<readonly ReadinessLevel[]> {
    if (input.tenantId !== this.data.tenantId) return [];
    return [...(this.data.readiness ?? [])].sort((a, b) => a.sortNo - b.sortNo || cmp(a.code, b.code));
  }

  // ---- 内部 ----
  protected findRun(tenantId: string, runId: string) {
    return tenantId === this.data.tenantId ? this.state.runs.get(runId) : undefined;
  }
  /** 租户先于一切：不存在或其他租户的 run 一律视为没有可用执行。 */
  protected requireRun(tenantId: string, runId: string): InMemorySyncRun {
    const run = this.findRun(tenantId, runId);
    if (!run) throw new SyncPortError('EXECUTION_INACTIVE', 'run 不存在');
    return run;
  }
  protected freshRecord(executionNo: number): Consumption {
    return {
      status: 'running',
      executionNo,
      leaseOwner: null,
      leaseUntil: null,
      sealed: false,
      targetCount: 0,
      planCommandId: null,
      planDigest: null,
      planCommit: null,
      terminalCode: null,
      terminalRecovery: null,
    };
  }
  protected rowsOf(runId: string, consumer: string): OutcomeItem[] {
    const prefix = `${runId}|${consumer}|`;
    return [...this.state.outcomes].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row);
  }
  protected set<K, V>(tx: MemoryTx, map: Map<K, V>, key: K, value: V): void {
    this.txs.set(tx, map, key, value);
  }

  /** 冻结时为每个已登记消费方的每个 nomination / object / org_health 行预建 pending 回执（SP-02）。 */
  private prebuild(run: InMemorySyncRun) {
    const rows = [
      ...run.nominations.map((n) => ['nomination', n.nominationId] as const),
      ...run.objects.map((o) => ['object', o.objectId] as const),
      ...run.orgHealth.map((h) => ['org_health', h.orgId] as const),
    ];
    for (const consumer of this.consumers) {
      for (const [rowKind, rowId] of rows) {
        const row: OutcomeItem = {
          rowKind,
          rowId,
          status: 'pending',
          recovery: 'none',
          executionNo: null,
          pageCommandId: null,
          updatedAt: run.header.frozenAt,
        };
        this.state.outcomes.set(`${run.header.runId}|${consumer}|${rowKind}|${rowId}`, row);
      }
    }
  }

  private deniedFor(viewer: SourceViewer): Denied {
    return this.state.viewers.get(viewer.userId) ?? NONE;
  }

  /** 三档选择器 resolveReviewSource（SP-06）；terminated 对象不计。 */
  private resolve(tenantId: string, has: (o: SourceObject) => boolean, context: ReviewSourceContext) {
    if (tenantId !== this.data.tenantId) return null;
    const sources = (this.data.sources ?? []).filter((s) => s.objects.some((o) => has(o) && !o.terminated));
    const pick = (source: InMemoryReviewSource | undefined, tier: 1 | 2 | 3) => {
      if (!source) return null;
      const { projectId, meetingId, businessDate } = source;
      const reviewSource: ReviewSource = { projectId, meetingId, tier, businessDate };
      return { source: reviewSource, raw: source, object: source.objects.find((o) => has(o) && !o.terminated) };
    };
    // tier 1：给了校准会只取会中对象（不在会中 → tier 2，不降级为项目）；否则取触发项目的对象
    const tier1 = context.triggerMeetingId
      ? sources.find((s) => s.meetingId === context.triggerMeetingId)
      : sources.find((s) => s.meetingId === null && s.projectId === context.triggerProjectId);
    if (tier1) return pick(tier1, 1);
    const projects = sources.filter((s) => s.meetingId === null);
    const current = projects
      .filter((s) => s.status === 'in_progress' && s.periodStartDate <= context.asOf)
      .sort((a, b) => cmp(effectiveDate(b), effectiveDate(a)) || cmp(a.code, b.code))[0];
    if (current) return pick(current, 2);
    const last = projects
      .filter((s) => s.status === 'ended' && s.periodEndDate <= context.asOf)
      .sort(
        (a, b) =>
          cmp(b.periodEndDate, a.periodEndDate) || cmp(b.periodStartDate, a.periodStartDate) || cmp(a.code, b.code),
      )[0];
    return pick(last, 3);
  }

  /**
   * 员工查询 match = null（取该对象自己的提名）；组织 / 职位查询取来源内全部对象中匹配的提名。按 viewer 裁剪：
   * 查看人无权读的源员工的提名不出现，提名表单字段逐个 forbidden（继任者姓名的显示另由消费方按 DEC-311 处理）。
   */
  private succession(
    found: ReturnType<InMemoryReads['resolve']>,
    match: ((n: SyncNomination) => boolean) | null,
    denied: Denied,
  ) {
    if (!found) return { status: 'unavailable' as const, nominations: [], source: null };
    const objects = match ? found.raw.objects.filter((o) => !o.terminated) : [found.object!];
    // module_absent（所用模板都没有继任模块）与 value + []（有模块、零提名）分开（A-19）
    if (objects.every((o) => o.succession === null)) {
      return { status: 'module_absent' as const, nominations: [], source: found.source };
    }
    const nominations = objects
      .flatMap((o) => o.succession ?? [])
      .filter((n) => (match ? match(n) : true) && !denied.employeeIds.includes(n.employeeId))
      .map((n) => ({ ...n, formValues: trimForm(n.formValues, denied) }));
    return { status: 'value' as const, nominations, source: found.source };
  }

  /** 逐组织：租户 → 当前凭据授权 → 命令台账（完整指纹）→ 行锁内 CAS（SP-16）；按 orgId 升序处理。 */
  private async writeHealth(
    tx: MemoryTx,
    input: OrgHealthWriteCommand | OrgHealthResetCommand,
  ): Promise<OrgHealthWriteReceipt> {
    const rows = [...input.rows].sort((a, b) => cmp(a.orgId, b.orgId));
    if (input.tenantId !== this.data.tenantId) return { items: rows.map((row) => rejected(row.orgId, 'FORBIDDEN')) };
    const credential = input.credential;
    const actor = credential.kind === 'compute' ? credential.principalUserId : credential.userId;
    const access = this.state.healthAccess.get(actor) ?? { forbidden: false, orgIds: [] };
    const denial = (orgId: string) =>
      access.forbidden ? ('FORBIDDEN' as const) : access.orgIds.includes(orgId) ? ('OUT_OF_SCOPE' as const) : null;
    const ledgerKey = `ledger|${credential.commandId}`;
    await this.txs.lock(tx, ledgerKey, 'X');
    const digest = JSON.stringify([input.tenantId, credential, input.context, input.rows]);
    const first = this.state.healthLedger.get(ledgerKey);
    if (first) {
      if (first.digest !== digest) throw new SyncPortError('IDEMPOTENCY_CONFLICT', '同一命令 ID 的内容不同');
      // 重放按当前授权重判：撤权后不再返回原 written 回执与真实值
      return {
        items: first.receipt.items.map((item) => {
          const denied = denial(item.orgId);
          return denied ? rejected(item.orgId, denied) : item;
        }),
      };
    }
    const ended = this.state.endedProjects.includes(input.context.projectId);
    const items: HealthItem[] = [];
    for (const row of rows) {
      const denied = denial(row.orgId);
      if (denied) {
        items.push(rejected(row.orgId, denied));
        continue;
      }
      const key = healthKey(input.context, row.orgId);
      await this.txs.lock(tx, `health|${key}`, 'X');
      const outcome = ended ? 'PROJECT_ENDED' : this.applyHealth(tx, credential.kind, input.context, row);
      const now = this.state.health.get(key);
      items.push({
        orgId: row.orgId,
        outcome,
        currentRevision: now?.revision ?? 0,
        currentLevelId: now?.levelId ?? null,
        currentManual: now?.manual ?? false,
      });
    }
    const receipt = { items };
    this.set(tx, this.state.healthLedger, ledgerKey, { digest, receipt });
    return receipt;
  }

  private applyHealth(
    tx: MemoryTx,
    kind: 'compute' | 'assign' | 'reset',
    context: OrgHealthContext,
    row: OrgHealthWriteCommand['rows'][number],
  ): OrgHealthOutcome {
    const key = healthKey(context, row.orgId);
    const current = this.state.health.get(key);
    // compute 遇手动值保留，优先于版本判断；reset 是覆盖手动值的明确例外（DEC-305④）
    if (kind === 'compute' && current?.manual) return 'MANUAL_KEPT';
    if ((current?.revision ?? 0) !== row.expectedRevision) return 'REVISION_CONFLICT';
    const manual = kind === 'assign';
    const next: InMemoryHealthRow = {
      context,
      orgId: row.orgId,
      levelId: row.levelId,
      levelCode: row.levelCode,
      status: row.status,
      manual,
      method: manual ? 'manual' : 'computed',
      revision: (current?.revision ?? 0) + 1,
    };
    const same =
      current &&
      current.levelId === next.levelId &&
      current.status === next.status &&
      current.manual === next.manual &&
      current.method === next.method;
    if (same) return 'unchanged';
    this.set(tx, this.state.health, key, next);
    return 'written';
  }
}

function trimForm(values: Readonly<Record<string, FieldRead>>, denied: Denied): Record<string, FieldRead> {
  return Object.fromEntries(
    Object.entries(values).map(([code, read]) => [
      code,
      denied.fieldCodes.includes(code) ? { status: 'forbidden' as const, value: null } : read,
    ]),
  );
}
