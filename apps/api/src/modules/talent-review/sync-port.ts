/**
 * 盘点 → 继任同步端口（《R3-T04/T05 同步协议》v4 SP-05、SP-06；docs/08_设计/R3-T04-T05_同步协议.md）。
 * 消费方（R3-T05 继任、R3-T06 人才池）只从本文件引用类型与接口；值类型定义在领域层（talent-review/sync-protocol.ts，
 * 纯规则同样要用），这里统一再导出。替身见 sync-port-memory.ts，共用契约测试见 sync-port.contract.test.ts（SP-18）；
 * 真实实现随 T04 PR-D 交付，两者跑同一套契约。
 */
import type { Tx } from '@italent/db';
import type {
  ConsumptionState,
  GreenRateResult,
  OrgHealthContext,
  OrgHealthResetCommand,
  OrgHealthRowState,
  OrgHealthWriteCommand,
  OrgHealthWriteReceipt,
  OutcomeItem,
  PageCommit,
  ReviewFieldDescriptor,
  ReviewFieldReadResult,
  ReviewSourceContext,
  RowKind,
  SourceReadAuthorization,
  SourceViewer,
  SuccessionReadResult,
  SyncConsumer,
  SyncErrorCode,
  SyncNomination,
  SyncObjectResult,
  SyncOrgHealth,
  SyncRunHeader,
  SyncTargetRegistration,
} from '@italent/domain';

export type {
  ConsumptionCounts,
  ConsumptionState,
  FieldRead,
  FieldStatus,
  GreenRateResult,
  HealthCredential,
  HealthLevel,
  ObjectStatus,
  OrgHealthContext,
  OrgHealthOutcome,
  OrgHealthResetCommand,
  OrgHealthRowState,
  OrgHealthRowWrite,
  OrgHealthWriteCommand,
  OrgHealthWriteReceipt,
  OutcomeItem,
  PageCommit,
  PortScalar,
  PortValue,
  ReviewFieldDescriptor,
  ReviewFieldReadResult,
  ReviewSource,
  ReviewSourceContext,
  RowKind,
  RowRecovery,
  RowStatus,
  RunRecovery,
  SourceReadAuthorization,
  SourceTier,
  SourceViewer,
  SuccessionReadResult,
  SyncConsumer,
  SyncErrorCode,
  SyncMatrixPlacement,
  SyncNomination,
  SyncObjectResult,
  SyncOrgHealth,
  SyncRunHeader,
  SyncTargetAction,
  SyncTargetKey,
  SyncTargetKind,
  SyncTargetRegistration,
} from '@italent/domain';
export type { ReadinessLevel } from './readiness-port.js';
import type { ReadinessLevel } from './readiness-port.js';

/** 端口分页：after 为上一页的 next 游标（按行键升序）；next = null 表示没有下一页。 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/** 协议违例与执行失效（SP-14“不写回执的码”）：抛给消费方，调用整体不写。 */
export class SyncPortError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
    readonly params: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'SyncPortError';
  }
}

interface RunKey {
  readonly tenantId: string;
  readonly runId: string;
}
interface ConsumerKey extends RunKey {
  readonly consumer: SyncConsumer;
}
interface ExecutionKey extends ConsumerKey {
  readonly executionNo: number;
}

/** 每页上限（SP-06）：对象 500、提名 2000。 */
export const SYNC_OBJECT_PAGE_LIMIT = 500;
export const SYNC_NOMINATION_PAGE_LIMIT = 2000;

export interface TalentReviewSyncPort {
  loadRun(tx: Tx, key: RunKey): Promise<SyncRunHeader | null>;
  /** SP-07：每次执行开始、每页事务内、每次重试前按 run 的源读取主体当前授权复核本页实际使用的内容。 */
  authorizeSourceRead(
    tx: Tx,
    input: ConsumerKey & {
      readonly page: {
        readonly objectIds?: readonly string[];
        readonly nominationIds?: readonly string[];
        readonly orgIds?: readonly string[];
        readonly fieldCodes?: readonly string[];
      };
    },
  ): Promise<SourceReadAuthorization>;
  listRunObjects(tx: Tx, input: RunKey & { after?: string; limit: number }): Promise<Page<SyncObjectResult>>;
  listRunNominations(tx: Tx, input: RunKey & { after?: string; limit: number }): Promise<Page<SyncNomination>>;
  listRunOrgHealth(tx: Tx, key: RunKey): Promise<readonly SyncOrgHealth[]>;
  // 消费协议（SP-08～SP-13）
  beginConsumption(
    tx: Tx,
    input: ConsumerKey & { leaseOwner: string; leaseSeconds: number },
  ): Promise<ConsumptionState>;
  renewLease(tx: Tx, input: ExecutionKey & { leaseOwner: string; leaseSeconds: number }): Promise<ConsumptionState>;
  /** 计划提交（SP-10）：登记并封存目标、写计划阶段已确定的终态行、写 kind = 'plan' 的 PageCommit，一次原子完成。 */
  registerTargets(
    tx: Tx,
    input: ExecutionKey & {
      planCommandId: string;
      targets: readonly SyncTargetRegistration[];
      planOutcomes: readonly OutcomeItem[];
    },
  ): Promise<{ state: ConsumptionState; pageCommit: PageCommit }>;
  assertExecutionActive(tx: Tx, input: ExecutionKey & { leaseOwner: string; requireSealed?: boolean }): Promise<void>;
  /** 执行页（pageNo ≥ 1）专用；计划页不用本方法。 */
  recordOutcome(
    tx: Tx,
    input: ExecutionKey & { pageNo: number; pageCommandId: string; items: readonly OutcomeItem[] },
  ): Promise<PageCommit>;
  getPageCommit(tx: Tx, input: ConsumerKey & { pageCommandId: string }): Promise<PageCommit | null>;
  getOutcomes(
    tx: Tx,
    input: ConsumerKey & { rowKind?: RowKind; pageCommandId?: string; after?: string; limit?: number },
  ): Promise<Page<OutcomeItem>>;
  completeConsumption(tx: Tx, input: ExecutionKey): Promise<ConsumptionState>;
  abortConsumption(
    tx: Tx,
    input: ConsumerKey & { executionNo: number | null; code: SyncErrorCode; recovery: 'terminate' | 'new_run' },
  ): Promise<ConsumptionState>;
  // 字段目录与三档取数（无 run 也可用；按 viewer 当前授权逐字段 / 逐来源 / 逐组织返回 forbidden）
  listReviewFields(tx: Tx, input: { tenantId: string }): Promise<readonly ReviewFieldDescriptor[]>;
  readReviewFields(
    tx: Tx,
    input: {
      tenantId: string;
      employeeIds: readonly string[];
      fieldCodes: readonly string[];
      context: ReviewSourceContext;
      viewer: SourceViewer;
    },
  ): Promise<ReadonlyMap<string, ReviewFieldReadResult>>;
  readSuccessionEntries(
    tx: Tx,
    input: {
      tenantId: string;
      employeeIds?: readonly string[];
      orgIds?: readonly string[];
      positionIds?: readonly string[];
      context: ReviewSourceContext;
      viewer: SourceViewer;
    },
  ): Promise<readonly SuccessionReadResult[]>;
  greenRate(
    tx: Tx,
    input: { tenantId: string; orgIds: readonly string[]; context: ReviewSourceContext; viewer: SourceViewer },
  ): Promise<ReadonlyMap<string, GreenRateResult>>;
  // 健康度（SP-15 / SP-16）
  /** 回写前取逐组织 revision（SP-16）；无读权的组织只返回 forbidden。 */
  readOrgHealthRows(
    tx: Tx,
    input: { tenantId: string; context: OrgHealthContext; orgIds: readonly string[]; viewer: SourceViewer },
  ): Promise<readonly OrgHealthRowState[]>;
  recordOrgHealth(tx: Tx, input: OrgHealthWriteCommand): Promise<OrgHealthWriteReceipt>;
  resetOrgHealth(tx: Tx, input: OrgHealthResetCommand): Promise<OrgHealthWriteReceipt>;
  listReadinessLevels(tx: Tx, input: { tenantId: string }): Promise<readonly ReadinessLevel[]>;
}
