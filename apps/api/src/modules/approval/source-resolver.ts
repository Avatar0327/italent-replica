/** DEC-686：类型登记负责取人，回避/空人/会签仍由既有路由负责。 */
import { createHash } from 'node:crypto';
import type { Tx } from '@italent/db';
import {
  expressionValue,
  sampleApprovers,
  sourceViolation,
  type ApproverSource,
  type ApproverSourceType,
  type Candidate,
} from '@italent/domain';
import { findCurrentRecord } from '../employment/read-model.js';
import { approvalError } from './context.js';
import { candidateOf, resolveCandidate, resolveFallbackCandidates, type RoutingSubject } from './resolver.js';
import type { TaskRow } from './store.js';
import { actualApprovals } from './task-history.js';

/** 调用方先按有效轮次裁剪；只认上一节点最后一次激活的人工同意，转交旧任务/跳过不算。 */
export function previousApproved(tasks: readonly TaskRow[], nodeKey: string | null): string[] {
  const previous = tasks.filter((task) => task.nodeKey === nodeKey);
  const activation = previous.at(-1)?.activationId;
  return [
    ...new Set(
      actualApprovals(previous.filter((task) => task.activationId === activation)).flatMap(
        (task) => task.assigneeUserId ?? [],
      ),
    ),
  ];
}

type Resolver = (tx: Tx, subject: RoutingSubject, source: ApproverSource) => Promise<Candidate[]>;
const nobody: Candidate = { personId: null, userId: null };
const fixed: Resolver = async (tx, subject, source) => {
  const value = expressionValue(source);
  if (!value) throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_INVALID', '审批人来源不合法');
  return [await resolveCandidate(tx, subject, value)];
};
const objectField: Resolver = async (tx, subject, source) => {
  if (source.value !== 'business_record_direct_manager') return fixed(tx, subject, source);
  if (!subject.businessDate || !subject.subjectEmployeeId) return [nobody];
  const record = await findCurrentRecord(tx, subject.tenantId, subject.subjectEmployeeId, subject.businessDate);
  return [await candidateOf(tx, subject, record?.fields.directManagerId ?? null)];
};
/** F-318c 接入只增登记与来源校验，不改分派主干。 */
const resolvers: Partial<Record<ApproverSourceType, Resolver>> = {
  custom_variable: fixed,
  object_field: objectField,
  department: fixed,
  identity: fixed,
  specified: (tx, subject, source) => resolveFallbackCandidates(tx, subject, [source.value]),
  context_variable: (tx, subject) => resolveFallbackCandidates(tx, subject, subject.previousApprovedUserIds ?? []),
};
export async function resolveSource(tx: Tx, subject: RoutingSubject, source: ApproverSource): Promise<Candidate[]> {
  const violation = sourceViolation(source);
  const resolver = resolvers[source.type];
  if (violation || !resolver)
    throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_INVALID', violation ?? '审批来源未登记');
  const candidates = await resolver(tx, subject, source);
  return candidates.length ? candidates : [nobody];
}
/** 抽样种子绑定实例/轮次/节点；相同命令预检与实际派单重复计算一致，台账回放不重新抽人。 */
export function limitApprovers<T>(items: readonly T[], key: (item: T) => string | null, seed: string): T[] {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return sampleApprovers(items, key, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  });
}
