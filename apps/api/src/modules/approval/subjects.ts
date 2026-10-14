/**
 * F-048 主体冻结（docs/08_设计/F-048_审批多主体回避_设计.md §2.2、§5）：实例创建与重提时，把本单涵盖的主体员工 S 与其
 * 当时绑定的账号 U(S) 写入 approval_instance_subjects，按轮次插入、只增不减（DEC-329⑤）、行不可改（迁移触发器）。
 * 之后的回避判定只读冻结值；冻结之后才发生的首次绑定不追溯，下一次重提时冻结进来。
 * 没有冻结行的存量实例（F-048 之前创建）按单主体回退，单主体账号沿用实时绑定，行为与上线前一致（设计 §2.1）。
 */
import { sql, type Tx } from '@italent/db';
import { recusalFacts, type RecusalFacts } from '@italent/domain';
import { approvalError, auditApproval, canonicalId, rowsOf, type ApprovalContext } from './context.js';
import { userOfPerson } from './resolver.js';
import type { InstanceRow } from './store.js';

/** 每个实例的主体上限（设计 Q06，AGENTS §10 批量上限）。 */
export const MAX_INSTANCE_SUBJECTS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Instance = Pick<InstanceRow, 'id' | 'initiatorUserId' | 'subjectEmployeeId'>;

interface FrozenRow {
  readonly round: number;
  readonly employee_id: string;
  readonly user_id: string | null;
}

async function frozenRows(tx: Tx, tenantId: string, instanceId: string): Promise<FrozenRow[]> {
  return rowsOf<FrozenRow>(
    await tx.execute(sql`SELECT round, employee_id::text, user_id::text FROM approval_instance_subjects
      WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid ORDER BY round, employee_id`),
  );
}

/**
 * 冻结本轮主体：本轮员工 = 历史各轮员工 ∪ 适配器当前给出的员工 ∪ 单主体（只增不减）；账号按此刻的绑定重新取，
 * 不看账号 / 成员状态（设计 Q05）。员工必须是本租户已有员工，任何一个不认识即整单拒绝（不写入）。
 * 写入不取员工行或成员行的锁：表上没有指向它们的外键，存在性用一次不加锁的查询确认（设计 §5.4）。
 * @returns 本轮冻结的员工数
 */
export async function freezeSubjects(
  tx: Tx,
  ctx: ApprovalContext,
  instance: Instance,
  round: number,
  fromAdapter: readonly string[],
): Promise<number> {
  const previous = (await frozenRows(tx, ctx.tenantId, instance.id)).map((row) => row.employee_id);
  const given = [...fromAdapter, ...(instance.subjectEmployeeId ? [instance.subjectEmployeeId] : [])];
  if (given.some((id) => typeof id !== 'string' || !UUID.test(canonicalId(id)))) throw unknownSubject();
  const ids = [...new Set([...previous, ...given.map(canonicalId)])].sort();
  if (ids.length > MAX_INSTANCE_SUBJECTS) {
    throw approvalError(
      'VALIDATION_FAILED',
      'APPROVAL_SUBJECTS_TOO_MANY',
      `一张审批单最多涵盖 ${MAX_INSTANCE_SUBJECTS} 人`,
      {
        limit: MAX_INSTANCE_SUBJECTS,
      },
    );
  }
  if (!ids.length) return 0;
  const list = `{${ids.join(',')}}`;
  const [known] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM employment_employees
      WHERE tenant_id=${ctx.tenantId} AND id = ANY(${list}::uuid[])`),
  );
  if (Number(known?.n ?? 0) !== ids.length) throw unknownSubject();
  await tx.execute(sql`INSERT INTO approval_instance_subjects
      (tenant_id,instance_id,round,employee_id,user_id,created_at)
    SELECT ${ctx.tenantId}, ${instance.id}::uuid, ${round}, e.id, l.user_id, ${ctx.now.toISOString()}
    FROM unnest(${list}::uuid[]) AS e(id)
    LEFT JOIN permission_user_person_links l ON l.tenant_id=${ctx.tenantId} AND l.employee_id=e.id`);
  await auditApproval(tx, ctx, {
    action: 'approval.instance.subjects_freeze',
    objectType: 'approval-instance',
    objectId: instance.id,
    before: null,
    after: { round, subjectsFrozen: ids.length },
  });
  return ids.length;
}

function unknownSubject() {
  return approvalError('VALIDATION_FAILED', 'APPROVAL_SUBJECT_UNKNOWN', '审批单涵盖的人员不存在');
}

/**
 * 实例的回避事实（设计 §2.1）：全部轮次的冻结员工与账号并集（只增不减）；单主体账号取冻结值。存量实例没有冻结行，
 * 主体集合为单主体，单主体账号沿用实时绑定（userOfPerson，与上线前一致）。
 */
export async function loadRecusalFacts(tx: Tx, tenantId: string, instance: Instance): Promise<RecusalFacts> {
  const rows = await frozenRows(tx, tenantId, instance.id);
  const primary = instance.subjectEmployeeId;
  if (!rows.length) {
    const primaryUserId = await userOfPerson(tx, tenantId, primary);
    return recusalFacts({
      initiatorUserId: instance.initiatorUserId,
      primaryEmployeeId: primary,
      primaryUserId,
      subjectEmployeeIds: primary ? [primary] : [],
      subjectUserIds: primaryUserId ? [primaryUserId] : [],
    });
  }
  const primaryRow = primary ? rows.filter((row) => row.employee_id === canonicalId(primary)).at(-1) : undefined;
  return recusalFacts({
    initiatorUserId: instance.initiatorUserId,
    primaryEmployeeId: primary,
    primaryUserId: primaryRow?.user_id ?? null,
    subjectEmployeeIds: rows.map((row) => row.employee_id),
    subjectUserIds: rows.flatMap((row) => (row.user_id ? [row.user_id] : [])),
  });
}
