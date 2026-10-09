/**
 * 人员子集按子集登记的策略检查（R3-T02 P0 契约，拆分方案第 3 节②；设计 §1.3）。两道检查，都在调用方的命令事务里、
 * 锁人之后、写入之前执行，抛错即整笔回滚：
 * - beforeRequest（自助申请准入）：首次提交（createChange）与同单重提（resubmitChangeInTransaction，在“空修正且申请
 *   仍待审批”的提前返回之前）——拒绝时不留申请行、审批实例与申请审计；
 * - beforeSave（落地前复核）：saveSubset 一处覆盖 HR 子集写入、自助审批通过后的落地与信息采集；source 区分入口，
 *   防止提交后开关或权限变化。
 * 未登记的子集两道检查都不调用，行为不变。同一子集只能登记一份（C1-1 登记 qualification）。
 *
 * 直写边界：只覆盖经 saveSubset 的写入。以下直接调 persistSubset 的系统维护写入**不经过钩子**：
 * - employment-sync.ts 的 jobhistory 任职同步（本单位经历的生成与回写）；
 * - subsets.ts clearFlags 的连带清标记：education 的 isHighestEducation / isFirstEducation / isHighestDegree /
 *   isMainMajor，professional-technical-post 与 vocational-qualification 的 isHighestLevel——保存一行时把同员工
 *   其他行的同名标记改为 false，那些连带行不经 beforeSave。
 * 给 jobhistory、education、professional-technical-post、vocational-qualification 登记策略前，必须先在同一子 PR 里
 * 处理这些连带行的校验（改走 saveSubset 带系统来源，或在策略里显式覆盖），否则连带行会绕过策略。
 */
import type { Tx } from '@italent/db';
import type { SubsetKind } from '@italent/domain';
import type { PersonnelContext, Row } from './store.js';

/**
 * 写入来源（subsetMeta.source_type）。后三种是 R3-T02 的系统写入（任职同步 C1-4、子集初始化 C1-5、评定发布 C2-8），
 * 由 C1-1 的迁移放开 source_type CHECK 后才会传入；先在契约里冻结，C1 / C2 不再改本文件。
 */
export type SubsetSource = {
  readonly type: 'hr_direct' | 'self_service' | 'info_collection' | 'employment_sync' | 'initialization' | 'evaluation';
  readonly id: string | null;
};

export interface SubsetRequestCheck {
  readonly employeeId: string;
  readonly recordId: string | null;
  /** 申请载荷（同单重提时为合并修正后的完整载荷）。 */
  readonly values: Row;
}

export interface SubsetSaveCheck {
  readonly before: Row | null;
  /** 将要写入的完整行（含合并后的字段、来源与 revision）。 */
  readonly row: Row;
  readonly deleted: boolean;
  readonly source: SubsetSource;
}

/**
 * 取锁限制：钩子运行时调用方已持有员工锁（lockPerson）；经审批中心调用时（同单重提、审批通过后的落地）还持有审批
 * 实例锁。钩子内**禁止**再取员工锁集合以外的员工锁，也**禁止**反向首次取得业务 / 组织 / 编制等在审批实例锁之前的
 * 前序锁，否则会与正常顺序的命令死锁；确需这些锁的，由调用方在进入审批实例锁之前预取。钩子只做读取与判断，
 * 拒绝时抛 AppError，不写任何数据。
 */
export interface SubsetPolicy {
  readonly beforeRequest?: (tx: Tx, ctx: PersonnelContext, input: SubsetRequestCheck) => Promise<void>;
  readonly beforeSave?: (tx: Tx, ctx: PersonnelContext, input: SubsetSaveCheck) => Promise<void>;
}

const POLICIES = new Map<SubsetKind, SubsetPolicy>();

/** 登记某子集的策略；返回撤销函数（测试用）。重复登记抛错，避免两处静默覆盖。 */
export function registerSubsetPolicy(kind: SubsetKind, policy: SubsetPolicy): () => void {
  if (POLICIES.has(kind)) throw new Error(`人员子集 ${kind} 的策略已登记`);
  POLICIES.set(kind, policy);
  return () => {
    if (POLICIES.get(kind) === policy) POLICIES.delete(kind);
  };
}

export async function runSubsetRequestPolicy(
  tx: Tx,
  ctx: PersonnelContext,
  kind: SubsetKind,
  input: SubsetRequestCheck,
): Promise<void> {
  await POLICIES.get(kind)?.beforeRequest?.(tx, ctx, input);
}

export async function runSubsetSavePolicy(
  tx: Tx,
  ctx: PersonnelContext,
  kind: SubsetKind,
  input: SubsetSaveCheck,
): Promise<void> {
  await POLICIES.get(kind)?.beforeSave?.(tx, ctx, input);
}
