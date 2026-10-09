/**
 * 同步端口替身的状态、测试控制面与读取部分（SP-06 三档选择器、SP-15 / SP-16 健康度、准备度）。
 * 无 run 的读取按 viewer 当前授权逐字段 / 逐员工 / 逐组织返回 forbidden；健康度回写按凭据逐组织授权、锁内 CAS、
 * 命令台账幂等（同键异内容 IDEMPOTENCY_CONFLICT）。
 */
import type { Tx } from '@italent/db';
import type {
  ConsumptionState,
  FieldRead,
  GreenRateResult,
  IsoDate,
  OrgHealthContext,
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
import { SyncPortError, type TalentReviewSyncPort } from './sync-port.js';

export interface InMemorySyncRun {
  header: SyncRunHeader;
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

interface Consumption {
  status: ConsumptionState['status'];
  executionNo: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  sealed: boolean;
  targetCount: number;
  planCommandId: string | null;
  planDigest: string | null;
  planCommit: PageCommit | null;
  terminalCode: ConsumptionState['terminalCode'];
  terminalRecovery: ConsumptionState['terminalRecovery'];
}
interface Denied {
  employeeIds: string[];
  fieldCodes: string[];
  orgIds: string[];
}
export interface MemoryState {
  now: Date;
  runs: Map<string, InMemorySyncRun>;
  consumptions: Map<string, Consumption>;
  outcomes: Map<string, OutcomeItem>;
  commits: Map<string, PageCommit>;
  /** 源读取主体的撤权（SP-07）。 */
  revoked: { principal: boolean; owner: boolean; project: boolean } & Denied & {
      objectIds: string[];
      sources: { objectId: string; source: string }[];
    };
  /** 无 run 读取的查看人撤权（SP-06）。 */
  viewers: Map<string, Denied>;
  /** 健康度回写授权：forbidden = 缺按钮 / 对象权；orgIds = 不在范围的组织（SP-16）。 */
  healthAccess: Map<string, { forbidden: boolean; orgIds: string[] }>;
  health: Map<string, InMemoryHealthRow>;
  healthLedger: Map<string, { digest: string; receipt: OrgHealthWriteReceipt }>;
  endedProjects: string[];
}

const healthKey = (context: OrgHealthContext, orgId: string) =>
  `${context.projectId}|${context.meetingId ?? ''}|${orgId}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const effectiveDate = (s: InMemoryReviewSource) => s.businessDate ?? s.periodStartDate;

export class InMemoryReads {
  protected state: MemoryState;
  protected readonly consumers: readonly SyncConsumer[];

  constructor(protected readonly data: InMemorySyncData) {
    this.consumers = data.consumers ?? ['succession'];
    const now = data.now ?? new Date('2026-10-09T00:00:00Z');
    this.state = {
      now,
      runs: new Map((data.runs ?? []).map((run) => [run.header.runId, structuredClone(run)])),
      consumptions: new Map(),
      outcomes: new Map(),
      commits: new Map(),
      revoked: {
        principal: false,
        owner: false,
        project: false,
        objectIds: [],
        employeeIds: [],
        fieldCodes: [],
        sources: [],
        orgIds: [],
      },
      viewers: new Map(),
      healthAccess: new Map(),
      health: new Map((data.healthRows ?? []).map((row) => [healthKey(row.context, row.orgId), row])),
      healthLedger: new Map(),
      endedProjects: [],
    };
    for (const run of this.state.runs.values()) this.prebuild(run);
  }

  // ---- 测试控制面 ----
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
    this.state.viewers.set(userId, { employeeIds: [], fieldCodes: [], orgIds: [], ...denied });
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
    input: Parameters<TalentReviewSyncPort['readReviewFields']>[1],
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

  async readSuccessionEntries(
    _tx: Tx,
    input: Parameters<TalentReviewSyncPort['readSuccessionEntries']>[1],
  ): Promise<readonly SuccessionReadResult[]> {
    const denied = this.deniedFor(input.viewer);
    const byEmployee = (input.employeeIds ?? []).map((employeeId) => {
      const base = { employeeId, orgId: null, positionId: null };
      if (denied.employeeIds.includes(employeeId))
        return { ...base, status: 'forbidden' as const, nominations: [], source: null };
      const found = this.resolve(input.tenantId, (o) => o.employeeId === employeeId, input.context);
      return { ...base, ...this.succession(found, null) };
    });
    const byOrg = (input.orgIds ?? []).map((orgId) => {
      const base = { employeeId: null, orgId, positionId: null };
      if (denied.orgIds.includes(orgId))
        return { ...base, status: 'forbidden' as const, nominations: [], source: null };
      const found = this.resolve(input.tenantId, (o) => o.orgId === orgId, input.context);
      const match = (n: SyncNomination) => n.kind === 'org' && n.direction === 'successor' && n.orgId === orgId;
      return { ...base, ...this.succession(found, match) };
    });
    return [...byEmployee, ...byOrg];
  }

  async greenRate(
    _tx: Tx,
    input: Parameters<TalentReviewSyncPort['greenRate']>[1],
  ): Promise<ReadonlyMap<string, GreenRateResult>> {
    const result = new Map<string, GreenRateResult>();
    for (const orgId of input.orgIds) {
      const found = this.resolve(input.tenantId, (o) => o.orgId === orgId, input.context);
      const placed = (found?.raw.objects ?? []).filter((o) => o.orgId === orgId && !o.terminated && o.placement);
      const matrixId = placed[0]?.placement?.matrixId;
      const counted = placed.filter((o) => o.placement!.placement !== null);
      const green = counted.filter((o) => o.placement!.countsGreen).length;
      // 分母 0 或缺参考九宫格 → rate = null（DEC-305④）
      const rate = counted.length && matrixId ? green / counted.length : null;
      const source = found && matrixId ? { ...found.source, matrixId } : null;
      result.set(orgId, { green, placed: counted.length, rate, source });
    }
    return result;
  }

  // ---- 健康度（SP-15 / SP-16）----
  async readOrgHealthRows(
    _tx: Tx,
    input: Parameters<TalentReviewSyncPort['readOrgHealthRows']>[1],
  ): Promise<readonly OrgHealthRowState[]> {
    const denied = this.deniedFor(input.viewer);
    return input.orgIds.map((orgId): OrgHealthRowState => {
      const context = input.context;
      if (input.tenantId !== this.data.tenantId || denied.orgIds.includes(orgId))
        return { status: 'forbidden', orgId, context };
      const row = this.state.health.get(healthKey(context, orgId));
      if (!row) return { status: 'absent', orgId, context, revision: 0 };
      const { levelId, levelCode, manual, method, revision, status } = row;
      return { status, orgId, context, levelId, levelCode, manual, method, revision };
    });
  }

  async recordOrgHealth(_tx: Tx, input: OrgHealthWriteCommand): Promise<OrgHealthWriteReceipt> {
    return this.writeHealth(input);
  }

  async resetOrgHealth(_tx: Tx, input: OrgHealthResetCommand): Promise<OrgHealthWriteReceipt> {
    return this.writeHealth(input);
  }

  async listReadinessLevels(_tx: Tx, input: { tenantId: string }): Promise<readonly ReadinessLevel[]> {
    if (input.tenantId !== this.data.tenantId) return [];
    return [...(this.data.readiness ?? [])].sort((a, b) => a.sortNo - b.sortNo || cmp(a.code, b.code));
  }

  // ---- 内部 ----
  protected findRun(tenantId: string, runId: string) {
    return tenantId === this.data.tenantId ? this.state.runs.get(runId) : undefined;
  }
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
    return this.state.viewers.get(viewer.userId) ?? { employeeIds: [], fieldCodes: [], orgIds: [] };
  }

  /** 三档选择器 resolveReviewSource（SP-06）；terminated 对象不计。 */
  private resolve(
    tenantId: string,
    has: (o: InMemoryReviewSource['objects'][number]) => boolean,
    context: ReviewSourceContext,
  ) {
    if (tenantId !== this.data.tenantId) return null;
    const sources = (this.data.sources ?? []).filter((s) => s.objects.some((o) => has(o) && !o.terminated));
    const pick = (source: InMemoryReviewSource | undefined, tier: 1 | 2 | 3) => {
      if (!source) return null;
      const reviewSource: ReviewSource = {
        projectId: source.projectId,
        meetingId: source.meetingId,
        tier,
        businessDate: source.businessDate,
      };
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

  /** 员工查询 match = null（取该对象自己的提名）；组织查询取来源内全部对象中匹配的提名。 */
  private succession(found: ReturnType<InMemoryReads['resolve']>, match: ((n: SyncNomination) => boolean) | null) {
    if (!found) return { status: 'unavailable' as const, nominations: [], source: null };
    const lists = match
      ? found.raw.objects.filter((o) => !o.terminated).map((o) => o.succession)
      : [found.object!.succession];
    // module_absent（所用模板都没有继任模块）与 value + []（有模块、零提名）分开（A-19）
    if (lists.every((list) => list === null))
      return { status: 'module_absent' as const, nominations: [], source: found.source };
    const nominations = lists.flatMap((list) => list ?? []).filter(match ?? (() => true));
    return { status: 'value' as const, nominations, source: found.source };
  }

  /** 逐组织授权、锁内 CAS、命令台账（SP-16）；按 orgId 升序处理。 */
  private writeHealth(input: OrgHealthWriteCommand | OrgHealthResetCommand): OrgHealthWriteReceipt {
    const credential = input.credential;
    const ledgerKey = `${credential.kind}:${credential.commandId}`;
    const digest = JSON.stringify([input.context, input.rows]);
    const first = this.state.healthLedger.get(ledgerKey);
    if (first) {
      if (first.digest === digest) return first.receipt;
      throw new SyncPortError('IDEMPOTENCY_CONFLICT', '同一命令 ID 的内容不同');
    }
    const actor = credential.kind === 'compute' ? credential.principalUserId : credential.userId;
    const access = this.state.healthAccess.get(actor) ?? { forbidden: false, orgIds: [] };
    const ended = this.state.endedProjects.includes(input.context.projectId);
    const items = [...input.rows]
      .sort((a, b) => cmp(a.orgId, b.orgId))
      .map((row) => {
        const key = healthKey(input.context, row.orgId);
        const current = this.state.health.get(key);
        const snapshot = () => {
          const now = this.state.health.get(key);
          return {
            currentRevision: now?.revision ?? 0,
            currentLevelId: now?.levelId ?? null,
            currentManual: now?.manual ?? false,
          };
        };
        const outcome = access.forbidden
          ? 'FORBIDDEN'
          : access.orgIds.includes(row.orgId)
            ? 'OUT_OF_SCOPE'
            : ended
              ? 'PROJECT_ENDED'
              : this.applyHealth(credential.kind, input.context, row, current);
        return { orgId: row.orgId, outcome, ...snapshot() } as const;
      });
    const receipt = { items };
    this.state.healthLedger.set(ledgerKey, { digest, receipt });
    return receipt;
  }

  private applyHealth(
    kind: 'compute' | 'assign' | 'reset',
    context: OrgHealthContext,
    row: OrgHealthWriteCommand['rows'][number],
    current: InMemoryHealthRow | undefined,
  ) {
    // compute 遇手动值保留，优先于版本判断；reset 是覆盖手动值的明确例外（DEC-305④）
    if (kind === 'compute' && current?.manual) return 'MANUAL_KEPT' as const;
    if ((current?.revision ?? 0) !== row.expectedRevision) return 'REVISION_CONFLICT' as const;
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
    if (same) return 'unchanged' as const;
    this.state.health.set(healthKey(context, row.orgId), next);
    return 'written' as const;
  }
}
