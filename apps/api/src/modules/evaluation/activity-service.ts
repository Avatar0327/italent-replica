/**
 * 评定活动（`TEvaluation.EvaluationActivity`）与环节（`ev_chains`）的读写服务（设计 §3.2、§5.1；规格 24 EV-R9、R12～R14、R17；
 * 拆分方案 B5）。整份提交，环节嵌套，整体成功或失败（同一事务）：
 * - 所属组织必填手选且须在操作人范围内（DEC-082 / DEC-324②）；适用 / 通知组织范围、类型、周期、类别、级别、环节评价表、负责人
 *   的**新增**引用在命令事务内按当前授权校验，原有引用原样保留（activity-refs.ts、person-refs.ts）；
 * - 跨级限制 max_level_jump 必填 1～5，新建未传取 1（DEC-372②，输入结构层 400）；
 * - 环节规则（packages/domain activity-rules.ts）：apply 与 result 必有、各类 ≤ 1、日期在活动起止内、defense → result 只能手动、
 *   apply 审批流程必填（400 APPROVAL_PROCESS_REQUIRED，编辑锁下可改不可清空）；环节按类型就地更新、保留稳定 ID；
 * - 适用范围与进行中活动重复 → 409（activity-scope.ts，按“租户 + 申请类别”取锁后判断）；
 * - 编辑锁 EV-R14 / AC-EV-05：apply_count > 0 时只许改规格列出的字段，否则 409 ACTIVITY_HAS_APPLICANTS；
 * - status 本 PR 只写 draft，apply_count 只读（C2 在活动行锁内维护）；删除只允许草稿且没有报名（保守默认，需取证 #225）。
 * 每个写入口在命令台账的同一事务里写业务与审计（DEC-019 / 216）；审计只存 ID，不冻结负责人姓名等展示信息。
 */
import { sql, type Tx } from '@italent/db';
import {
  activityLockedChange,
  type ActivityLockInput,
  checkActivityChains,
  checkActivityDates,
  type ChainDraft,
  type ApplicantMode,
  type ActivityStatus,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { assertNewActivityRefs, assertNewOrgs } from './activity-refs.js';
import { assertScopeUnique } from './activity-scope.js';
import type * as input from './input.js';
import { assertNewPersonRefs, presentPersonRefs, type PersonRefAccess } from './person-refs.js';
import { loadRow, type Tracked, view } from './read-model.js';
import type { View } from './route-support.js';
import { audit, bumped, guardUnique, lockEditable, requireOwnerOrg, rowsOf, type WriteContext } from './store.js';

export interface ChainRecord extends ChainDraft {
  readonly id: string;
}
export type ActivityRecord = Tracked & {
  readonly code: string;
  readonly name: string;
  readonly typeId: string;
  readonly cycleId: string;
  readonly year: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly orgRange: string[];
  readonly managerEmployeeId: string | null;
  readonly applicantMode: ApplicantMode;
  readonly categoryIds: string[];
  readonly levelIds: string[];
  readonly maxLevelJump: number;
  readonly effectiveDate: string | null;
  readonly noticeOrgRange: string[];
  readonly status: ActivityStatus;
  readonly applyCount: number;
  readonly chains: ChainRecord[];
};

const invalid = (message: string, reason: string) => new AppError('VALIDATION_FAILED', message, { reason });
const unique = <T>(list: readonly T[] | undefined): T[] => [...new Set(list ?? [])];
const arrayLiteral = (ids: readonly string[]) => `{${ids.join(',')}}`;
/** 文本数组字面量：元素加引号并转义，避免逗号 / 引号 / 反斜杠破坏数组。 */
const textArray = (items: readonly string[]) =>
  `{${items.map((item) => `"${item.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;

const CHAIN_COLUMNS = sql`id, activity_id, type, seq, name, start_date::text AS start_date, end_date::text AS end_date,
  form_id, approval_process_code, material_template, hard_deadline, allow_exception, exception_roles,
  transfer_mode, notice_template_code`;

/** 读出环节（按提交顺序）并挂到活动上。 */
export async function withChains(tx: Tx, tenantId: string, rows: Record<string, unknown>[]): Promise<ActivityRecord[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id as string);
  const found = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT ${CHAIN_COLUMNS} FROM ev_chains
      WHERE tenant_id = ${tenantId}::uuid AND activity_id = ANY(${arrayLiteral(ids)}::uuid[])
      ORDER BY activity_id, seq`),
  );
  return rows.map((row) => ({
    ...view<Omit<ActivityRecord, 'chains'>>(row),
    chains: found
      .filter((chain) => chain.activity_id === row.id)
      .map((chain) => {
        const { activityId: _activity, seq: _seq, ...rest } = view<Record<string, unknown>>(chain);
        return rest as unknown as ChainRecord;
      }),
  }));
}

export async function loadActivity(tx: Tx, tenantId: string, id: string): Promise<ActivityRecord> {
  return (await withChains(tx, tenantId, [(await loadRow(tx, tenantId, 'evaluationActivity', id))!]))[0]!;
}

/** 呈现：负责人挂上人员引用出口（范围内 姓名 + 工号；范围外只有姓名；无权只剩 ID，规则见 person-refs.ts）。 */
export async function presentActivities(
  tx: Tx,
  tenantId: string,
  access: PersonRefAccess,
  views: readonly View[],
): Promise<View[]> {
  const activities = views as readonly ActivityRecord[];
  const refs = await presentPersonRefs(
    tx,
    tenantId,
    access,
    activities.flatMap((activity) => (activity.managerEmployeeId ? [activity.managerEmployeeId] : [])),
  );
  return activities.map((activity) => ({
    ...activity,
    manager: activity.managerEmployeeId ? { ...refs.get(activity.managerEmployeeId) } : null,
  })) as unknown as View[];
}

const toDraft = (chain: input.ChainInput): ChainDraft => ({
  type: chain.type,
  name: chain.name,
  startDate: chain.startDate,
  endDate: chain.endDate,
  formId: chain.formId ?? null,
  approvalProcessCode: chain.approvalProcessCode ?? null,
  materialTemplate: chain.materialTemplate ?? null,
  hardDeadline: chain.hardDeadline ?? false,
  allowException: chain.allowException ?? false,
  exceptionRoles: unique(chain.exceptionRoles),
  // 转入下一环节缺省手动（原站缺省未证实，保守不自动流转，#225）
  transferMode: chain.transferMode ?? 'manual',
  noticeTemplateCode: chain.noticeTemplateCode ?? null,
});

/** 整份规则校验（对合并后的完整值判）：日期、环节。 */
function checkRules(activity: { startDate: string; endDate: string }, chains: readonly ChainDraft[]): void {
  const dates = checkActivityDates(activity.startDate, activity.endDate);
  if (dates) throw invalid(dates.message, dates.reason);
  const broken = checkActivityChains(activity, chains);
  if (broken) throw invalid(broken.message, broken.reason);
}

const codeExists = () => new AppError('CONFLICT', '活动编码已存在，请重新输入', { reason: 'ACTIVITY_CODE_EXISTS' });

function activityAccess(ctx: WriteContext) {
  if (!ctx.activities || !ctx.persons) throw new Error('评定活动写命令缺少引用访问（activities / persons）');
  return { refs: ctx.activities, persons: ctx.persons };
}

/** 新增的引用：类型 / 周期 / 评价表 / 类别 / 级别 / 组织 / 负责人里原有集合之外的（原有的原样保留，不重校）。 */
interface RefsInput {
  readonly typeId: string;
  readonly cycleId: string;
  readonly orgRange: readonly string[];
  readonly noticeOrgRange: readonly string[];
  readonly categoryIds: readonly string[];
  readonly levelIds: readonly string[];
  readonly managerEmployeeId: string | null;
  readonly chains: readonly ChainDraft[];
}

async function assertAddedRefs(tx: Tx, ctx: WriteContext, next: RefsInput, before: ActivityRecord | undefined) {
  const { refs, persons } = activityAccess(ctx);
  const had = (list: readonly string[] | undefined, value: readonly string[]) =>
    value.filter((item) => !(list ?? []).includes(item));
  await assertNewOrgs(tx, ctx, [
    ...had(before?.orgRange, next.orgRange),
    ...had(before?.noticeOrgRange, next.noticeOrgRange),
  ]);
  await assertNewActivityRefs(tx, ctx, refs, {
    ...(before?.typeId === next.typeId ? {} : { typeId: next.typeId }),
    ...(before?.cycleId === next.cycleId ? {} : { cycleId: next.cycleId }),
    formIds: had(
      before?.chains.flatMap((chain) => (chain.formId ? [chain.formId] : [])),
      next.chains.flatMap((chain) => (chain.formId ? [chain.formId] : [])),
    ),
    categoryIds: had(before?.categoryIds, next.categoryIds),
    levelIds: had(before?.levelIds, next.levelIds),
  });
  if (next.managerEmployeeId && next.managerEmployeeId !== before?.managerEmployeeId) {
    await assertNewPersonRefs(tx, persons, [next.managerEmployeeId], '负责人');
  }
}

async function writeChains(
  tx: Tx,
  ctx: WriteContext,
  activityId: string,
  existing: readonly ChainRecord[],
  next: readonly ChainDraft[],
) {
  const kept = new Map(existing.map((chain) => [chain.type, chain.id]));
  for (const chain of existing) {
    if (!next.some((draft) => draft.type === chain.type)) {
      await tx.execute(sql`DELETE FROM ev_chains WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${chain.id}::uuid`);
    }
  }
  for (const [seq, chain] of next.entries()) {
    const values = {
      name: chain.name,
      startDate: chain.startDate,
      endDate: chain.endDate,
      formId: chain.formId,
      approvalProcessCode: chain.approvalProcessCode,
      materialTemplate: chain.materialTemplate,
      exceptionRoles: textArray(chain.exceptionRoles),
    };
    const id = kept.get(chain.type);
    if (id) {
      await tx.execute(sql`UPDATE ev_chains SET seq = ${seq}, name = ${values.name},
          start_date = ${values.startDate}::date, end_date = ${values.endDate}::date, form_id = ${values.formId},
          approval_process_code = ${values.approvalProcessCode}, material_template = ${values.materialTemplate},
          hard_deadline = ${chain.hardDeadline}, allow_exception = ${chain.allowException},
          exception_roles = ${values.exceptionRoles}::text[], transfer_mode = ${chain.transferMode},
          notice_template_code = ${chain.noticeTemplateCode}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
    } else {
      await tx.execute(sql`INSERT INTO ev_chains
          (tenant_id, activity_id, type, seq, name, start_date, end_date, form_id, approval_process_code,
           material_template, hard_deadline, allow_exception, exception_roles, transfer_mode, notice_template_code)
        VALUES (${ctx.tenantId}, ${activityId}, ${chain.type}, ${seq}, ${values.name}, ${values.startDate}::date,
          ${values.endDate}::date, ${values.formId}, ${values.approvalProcessCode}, ${values.materialTemplate},
          ${chain.hardDeadline}, ${chain.allowException}, ${values.exceptionRoles}::text[], ${chain.transferMode},
          ${chain.noticeTemplateCode})`);
    }
  }
}

export async function createActivity(tx: Tx, ctx: WriteContext, body: input.ActivityCreate): Promise<ActivityRecord> {
  const chains = body.chains.map(toDraft);
  checkRules(body, chains);
  const next = {
    code: body.code,
    name: body.name,
    typeId: body.typeId,
    cycleId: body.cycleId,
    year: body.year,
    startDate: body.startDate,
    endDate: body.endDate,
    ownerId: ctx.userId,
    ownerOrgId: body.ownerOrgId,
    orgRange: unique(body.orgRange),
    managerEmployeeId: body.managerEmployeeId ?? null,
    applicantMode: body.applicantMode,
    categoryIds: unique(body.categoryIds),
    levelIds: unique(body.levelIds),
    maxLevelJump: body.maxLevelJump ?? 1,
    effectiveDate: body.effectiveDate ?? null,
    noticeOrgRange: unique(body.noticeOrgRange),
    status: 'draft' as const,
    applyCount: 0,
    chains,
  };
  await requireOwnerOrg(tx, ctx, next.ownerOrgId);
  await assertAddedRefs(tx, ctx, next, undefined);
  await assertScopeUnique(tx, {
    tenantId: ctx.tenantId,
    scope: ctx.scope,
    orgRange: next.orgRange,
    categoryIds: next.categoryIds,
    nameVisible: activityAccess(ctx).refs.nameVisible,
  });
  const now = ctx.now.toISOString();
  const result = await guardUnique(
    () =>
      tx.execute(sql`INSERT INTO ev_activities
        (tenant_id, code, name, type_id, cycle_id, year, start_date, end_date, owner_id, owner_org_id, org_range,
         manager_employee_id, applicant_mode, category_ids, level_ids, max_level_jump, effective_date,
         notice_org_range, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${next.code}, ${next.name}, ${next.typeId}, ${next.cycleId}, ${next.year},
        ${next.startDate}::date, ${next.endDate}::date, ${ctx.userId}, ${next.ownerOrgId},
        ${arrayLiteral(next.orgRange)}::uuid[], ${next.managerEmployeeId}, ${next.applicantMode},
        ${arrayLiteral(next.categoryIds)}::uuid[], ${arrayLiteral(next.levelIds)}::uuid[], ${next.maxLevelJump},
        ${next.effectiveDate}::date, ${arrayLiteral(next.noticeOrgRange)}::uuid[], ${ctx.userId}, ${now}, ${now})
      RETURNING id`),
    codeExists,
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  await writeChains(tx, ctx, id, [], chains);
  const after = await loadActivity(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'evaluationActivity', 'create', id, { before: null, after, orgId: after.ownerOrgId });
  return after;
}

const lockInput = (activity: {
  code: string;
  typeId: string;
  orgRange: readonly string[];
  categoryIds: readonly string[];
  levelIds: readonly string[];
  effectiveDate: string | null;
  noticeOrgRange: readonly string[];
  chains: readonly ChainDraft[];
}): ActivityLockInput => activity;

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);

export async function updateActivity(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  body: input.ActivityPatch,
): Promise<ActivityRecord> {
  const row = await lockEditable(tx, ctx, 'evaluationActivity', id);
  const before = await loadActivity(tx, ctx.tenantId, id);
  const chains = body.chains ? body.chains.map(toDraft) : before.chains;
  const merged = {
    code: body.code ?? before.code,
    name: body.name ?? before.name,
    typeId: body.typeId ?? before.typeId,
    cycleId: body.cycleId ?? before.cycleId,
    year: body.year ?? before.year,
    startDate: body.startDate ?? before.startDate,
    endDate: body.endDate ?? before.endDate,
    ownerId: before.ownerId,
    ownerOrgId: body.ownerOrgId ?? before.ownerOrgId,
    orgRange: body.orgRange ? unique(body.orgRange) : before.orgRange,
    managerEmployeeId: body.managerEmployeeId !== undefined ? body.managerEmployeeId : before.managerEmployeeId,
    applicantMode: body.applicantMode ?? before.applicantMode,
    categoryIds: body.categoryIds ? unique(body.categoryIds) : before.categoryIds,
    levelIds: body.levelIds ? unique(body.levelIds) : before.levelIds,
    maxLevelJump: body.maxLevelJump ?? before.maxLevelJump,
    effectiveDate: body.effectiveDate !== undefined ? body.effectiveDate : before.effectiveDate,
    noticeOrgRange: body.noticeOrgRange ? unique(body.noticeOrgRange) : before.noticeOrgRange,
    status: before.status,
    applyCount: before.applyCount,
    chains,
  };
  checkRules(merged, chains);
  // EV-R14 / AC-EV-05：已有报名后只许改规定的字段（apply_count 取行锁后的当前值）
  if (Number(row.apply_count) > 0 && activityLockedChange(lockInput(before), lockInput(merged))) {
    throw new AppError(
      'CONFLICT',
      '活动已有报名人员，只能修改名称、所属组织、年度、周期、负责人、起止日期、申请人、可申报级别、参评条件，以及环节的名称、日期、顺序、流程、转入方式和通知',
      { reason: 'ACTIVITY_HAS_APPLICANTS' },
    );
  }
  if (merged.ownerOrgId !== before.ownerOrgId) await requireOwnerOrg(tx, ctx, merged.ownerOrgId);
  await assertAddedRefs(tx, ctx, merged, before);
  // 改适用组织范围 / 申请类别才重新检查重复（值没变不重判，历史数据里已有的冲突不挡改名等）
  if (!sameList(merged.orgRange, before.orgRange) || !sameList(merged.categoryIds, before.categoryIds)) {
    await assertScopeUnique(tx, {
      tenantId: ctx.tenantId,
      scope: ctx.scope,
      selfId: id,
      orgRange: merged.orgRange,
      categoryIds: merged.categoryIds,
      nameVisible: activityAccess(ctx).refs.nameVisible,
    });
  }
  const bump = bumped(ctx);
  await guardUnique(
    () =>
      tx.execute(sql`UPDATE ev_activities SET code = ${merged.code}, name = ${merged.name},
        type_id = ${merged.typeId}, cycle_id = ${merged.cycleId}, year = ${merged.year},
        start_date = ${merged.startDate}::date, end_date = ${merged.endDate}::date, owner_org_id = ${merged.ownerOrgId},
        org_range = ${arrayLiteral(merged.orgRange)}::uuid[], manager_employee_id = ${merged.managerEmployeeId},
        applicant_mode = ${merged.applicantMode}, category_ids = ${arrayLiteral(merged.categoryIds)}::uuid[],
        level_ids = ${arrayLiteral(merged.levelIds)}::uuid[], max_level_jump = ${merged.maxLevelJump},
        effective_date = ${merged.effectiveDate}::date,
        notice_org_range = ${arrayLiteral(merged.noticeOrgRange)}::uuid[],
        revision = ${bump.revision}, updated_at = ${bump.updatedAt}
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`),
    codeExists,
  );
  if (body.chains) await writeChains(tx, ctx, id, before.chains, chains);
  const after = await loadActivity(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'evaluationActivity', 'update', id, { before, after, orgId: after.ownerOrgId });
  return after;
}

export async function deleteActivity(tx: Tx, ctx: WriteContext, id: string): Promise<ActivityRecord> {
  const row = await lockEditable(tx, ctx, 'evaluationActivity', id);
  // TODO(需取证 #225)：删除条件按保守默认——只有草稿且没有报名的活动能删；环节随活动删除（外键 CASCADE）
  if (Number(row.apply_count) > 0) {
    throw new AppError('CONFLICT', '活动已有报名人员，不能删除', { reason: 'ACTIVITY_HAS_APPLICANTS' });
  }
  if (row.status !== 'draft') {
    throw new AppError('CONFLICT', '只有草稿活动可以删除', { reason: 'ACTIVITY_NOT_DRAFT' });
  }
  const before = await loadActivity(tx, ctx.tenantId, id);
  await tx.execute(sql`DELETE FROM ev_activities WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  await audit(tx, ctx, 'evaluationActivity', 'delete', id, { before, after: null, orgId: before.ownerOrgId });
  return before;
}
