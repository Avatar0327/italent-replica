/**
 * 评定活动（`TEvaluation.EvaluationActivity`）与环节（`ev_chains`）的读写服务（设计 §3.2、§5.1；规格 24 EV-R9、R12～R14、R17 与
 * Q-M0-174 补充；DEC-412；拆分方案 B5）。整份提交，环节与组织范围嵌套，整体成功或失败（同一事务）：
 * - **没有活动编码**；必填项见 input.ts；申请人多选；适用组织范围最多 100 个，每个带“包含下级”（`ev_activity_orgs`）；
 * - 所属组织必填手选且须在操作人范围内（DEC-082 / DEC-324②）；适用 / 通知组织范围、类型、周期、类别、级别、答辩评审的评价表、负责人
 *   的**新增**引用在命令事务内按当前授权校验，原有引用原样保留（activity-refs.ts、person-refs.ts）；
 * - 跨级限制 max_level_jump 必填 1～5，新建未传取 1（DEC-372②，输入结构层 400）；
 * - 环节规则（packages/domain activity-rules.ts）：资格申报首、结果发布末各 1 个，材料举证 / 答辩评审各最多 3 个、先后不限，评价表
 *   只在答辩评审上且必填，apply 审批流程必填（400 APPROVAL_PROCESS_REQUIRED，编辑锁下可改不可清空）；环节按 ID（没带 ID 的按同类型
 *   顺序）就地更新、保留稳定 ID；
 * - 适用范围与进行中活动重复 → 409（activity-scope.ts，组织范围展开下级后求交集，按“租户 + 申请类别”取锁后判断）；
 * - 编辑锁 EV-R14 / AC-EV-05：apply_count > 0 时只许改规格列出的字段，否则 409 ACTIVITY_HAS_APPLICANTS；已完成的活动不能修改；
 * - status 本 PR 只写 draft，apply_count 只读（C2 在活动行锁内维护）；删除只允许草稿（进行中 / 已完成按原站文案拒绝）。
 * 每个写入口在命令台账的同一事务里写业务与审计（DEC-019 / 216）；审计只存 ID，不冻结负责人姓名等展示信息。
 */
import { sql, type Tx } from '@italent/db';
import {
  type ActivityLockInput,
  type ActivityStatus,
  type Applicant,
  activityLockedChange,
  checkActivityChains,
  checkActivityDates,
  type ChainDraft,
  defaultTransferMode,
  matchChains,
  type OrgRangeEntry,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { assertNewActivityRefs, assertNewOrgs } from './activity-refs.js';
import { assertScopeUnique } from './activity-scope.js';
import type * as input from './input.js';
import { assertNewPersonRefs, presentPersonRefs, type PersonRefAccess } from './person-refs.js';
import { loadRow, type Tracked, view } from './read-model.js';
import type { View } from './route-support.js';
import { audit, bumped, lockEditable, requireOwnerOrg, rowsOf, type WriteContext } from './store.js';

export interface ChainRecord extends ChainDraft {
  readonly id: string;
}
type Submitted = ChainDraft & { readonly id?: string };
export type ActivityRecord = Tracked & {
  readonly name: string;
  readonly typeId: string;
  readonly cycleId: string;
  readonly year: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly orgRange: OrgRangeEntry[];
  readonly managerEmployeeId: string;
  readonly applicants: Applicant[];
  readonly categoryIds: string[];
  readonly levelIds: string[];
  readonly maxLevelJump: number;
  readonly effectiveDate: string;
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

/** 读出组织范围与环节（按提交顺序）并挂到活动上。 */
export async function withDetails(
  tx: Tx,
  tenantId: string,
  rows: Record<string, unknown>[],
): Promise<ActivityRecord[]> {
  if (!rows.length) return [];
  const ids = arrayLiteral(rows.map((row) => row.id as string));
  const chains = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT ${CHAIN_COLUMNS} FROM ev_chains
      WHERE tenant_id = ${tenantId}::uuid AND activity_id = ANY(${ids}::uuid[]) ORDER BY activity_id, seq`),
  );
  const orgs = rowsOf<{ activity_id: string; org_id: string; include_descendants: boolean }>(
    await tx.execute(sql`SELECT activity_id, org_id, include_descendants FROM ev_activity_orgs
      WHERE tenant_id = ${tenantId}::uuid AND activity_id = ANY(${ids}::uuid[]) ORDER BY activity_id, seq`),
  );
  return rows.map((row) => ({
    ...view<Omit<ActivityRecord, 'chains' | 'orgRange'>>(row),
    orgRange: orgs
      .filter((org) => org.activity_id === row.id)
      .map((org) => ({ orgId: org.org_id, includeDescendants: org.include_descendants })),
    chains: chains
      .filter((chain) => chain.activity_id === row.id)
      .map((chain) => {
        const { activityId: _activity, seq: _seq, ...rest } = view<Record<string, unknown>>(chain);
        return rest as unknown as ChainRecord;
      }),
  }));
}

export async function loadActivity(tx: Tx, tenantId: string, id: string): Promise<ActivityRecord> {
  return (await withDetails(tx, tenantId, [(await loadRow(tx, tenantId, 'evaluationActivity', id))!]))[0]!;
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
    activities.map((activity) => activity.managerEmployeeId),
  );
  return activities.map((activity) => ({
    ...activity,
    manager: { ...refs.get(activity.managerEmployeeId) },
  })) as unknown as View[];
}

const toDraft = (chain: input.ChainInput): Submitted => ({
  ...(chain.id ? { id: chain.id } : {}),
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
  // 转入下一环节缺省：资格申报 / 材料举证“完成后自动转入”，答辩评审只有手动（Q-M0-174 第 6 点）
  transferMode: chain.transferMode ?? defaultTransferMode(chain.type),
  noticeTemplateCode: chain.noticeTemplateCode ?? null,
});

const toOrgRange = (items: input.ActivityCreate['orgRange']): OrgRangeEntry[] =>
  items.map((item) => ({ orgId: item.orgId, includeDescendants: item.includeDescendants }));

/**
 * 整份规则校验（对合并后的完整值判）：日期、环节。提示里的环节名称按操作人对 `chains` 字段的查看权披露：修改活动日期时校验的是
 * 库里已有的环节，看不到环节的人拿到不含名称的通用提示（机器错误码不变）。
 */
function checkRules(
  activity: { startDate: string | null; endDate: string | null },
  chains: readonly ChainDraft[],
  chainsVisible: boolean,
): void {
  const dates = checkActivityDates(activity.startDate, activity.endDate);
  if (dates) throw invalid(dates.message, dates.reason);
  const broken = checkActivityChains(activity, chains);
  if (broken) throw invalid(chainsVisible && broken.named ? broken.named : broken.message, broken.reason);
}

function activityAccess(ctx: WriteContext) {
  if (!ctx.activities || !ctx.persons) throw new Error('评定活动写命令缺少引用访问（activities / persons）');
  return { refs: ctx.activities, persons: ctx.persons };
}

function checkOrgRange(orgRange: readonly OrgRangeEntry[]): void {
  if (new Set(orgRange.map((entry) => entry.orgId)).size !== orgRange.length) {
    throw invalid('适用组织范围里同一个组织不能重复', 'ACTIVITY_ORG_RANGE_DUPLICATE');
  }
}

interface RefsInput {
  readonly typeId: string;
  readonly cycleId: string;
  readonly orgRange: readonly OrgRangeEntry[];
  readonly noticeOrgRange: readonly string[];
  readonly categoryIds: readonly string[];
  readonly levelIds: readonly string[];
  readonly managerEmployeeId: string;
  readonly chains: readonly ChainDraft[];
}

/** 新增的引用：类型 / 周期 / 评价表 / 类别 / 级别 / 组织 / 负责人里原有集合之外的（原有的原样保留，不重校）。 */
async function assertAddedRefs(tx: Tx, ctx: WriteContext, next: RefsInput, before: ActivityRecord | undefined) {
  const { refs, persons } = activityAccess(ctx);
  const added = (had: readonly string[] | undefined, now: readonly string[]) =>
    now.filter((item) => !(had ?? []).includes(item));
  await assertNewOrgs(tx, ctx, [
    ...added(
      before?.orgRange.map((entry) => entry.orgId),
      next.orgRange.map((entry) => entry.orgId),
    ),
    ...added(before?.noticeOrgRange, next.noticeOrgRange),
  ]);
  const formIds = (chains: readonly ChainDraft[] | undefined) =>
    (chains ?? []).flatMap((chain) => (chain.formId ? [chain.formId] : []));
  await assertNewActivityRefs(tx, ctx, refs, {
    ...(before?.typeId === next.typeId ? {} : { typeId: next.typeId }),
    ...(before?.cycleId === next.cycleId ? {} : { cycleId: next.cycleId }),
    formIds: added(formIds(before?.chains), formIds(next.chains)),
    categoryIds: added(before?.categoryIds, next.categoryIds),
    levelIds: added(before?.levelIds, next.levelIds),
  });
  if (next.managerEmployeeId !== before?.managerEmployeeId) {
    await assertNewPersonRefs(tx, persons, [next.managerEmployeeId], '负责人');
  }
}

async function writeOrgs(tx: Tx, ctx: WriteContext, activityId: string, orgRange: readonly OrgRangeEntry[]) {
  await tx.execute(
    sql`DELETE FROM ev_activity_orgs WHERE tenant_id = ${ctx.tenantId}::uuid AND activity_id = ${activityId}::uuid`,
  );
  for (const [seq, entry] of orgRange.entries()) {
    await tx.execute(sql`INSERT INTO ev_activity_orgs (tenant_id, activity_id, org_id, include_descendants, seq)
      VALUES (${ctx.tenantId}, ${activityId}, ${entry.orgId}, ${entry.includeDescendants}, ${seq})`);
  }
}

/** 环节按对应关系写入：移除的删除，对应上的就地更新（保留 ID），新增的插入；`seq` 取提交顺序。 */
async function writeChains(
  tx: Tx,
  ctx: WriteContext,
  activityId: string,
  match: { pairs: readonly (readonly [ChainRecord, Submitted])[]; removed: readonly ChainRecord[] },
  ordered: readonly Submitted[],
) {
  for (const chain of match.removed) {
    await tx.execute(sql`DELETE FROM ev_chains WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${chain.id}::uuid`);
  }
  const idOf = new Map(match.pairs.map(([existing, chain]) => [chain, existing.id]));
  for (const [seq, chain] of ordered.entries()) {
    const roles = textArray(chain.exceptionRoles);
    const id = idOf.get(chain);
    if (id) {
      await tx.execute(sql`UPDATE ev_chains SET seq = ${seq}, name = ${chain.name},
          start_date = ${chain.startDate}::date, end_date = ${chain.endDate}::date, form_id = ${chain.formId},
          approval_process_code = ${chain.approvalProcessCode}, material_template = ${chain.materialTemplate},
          hard_deadline = ${chain.hardDeadline}, allow_exception = ${chain.allowException},
          exception_roles = ${roles}::text[], transfer_mode = ${chain.transferMode},
          notice_template_code = ${chain.noticeTemplateCode}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
    } else {
      await tx.execute(sql`INSERT INTO ev_chains
          (tenant_id, activity_id, type, seq, name, start_date, end_date, form_id, approval_process_code,
           material_template, hard_deadline, allow_exception, exception_roles, transfer_mode, notice_template_code)
        VALUES (${ctx.tenantId}, ${activityId}, ${chain.type}, ${seq}, ${chain.name}, ${chain.startDate}::date,
          ${chain.endDate}::date, ${chain.formId}, ${chain.approvalProcessCode}, ${chain.materialTemplate},
          ${chain.hardDeadline}, ${chain.allowException}, ${roles}::text[], ${chain.transferMode},
          ${chain.noticeTemplateCode})`);
    }
  }
}

/** 提交的环节与库里已有环节的对应；对不上的 ID → 400。 */
function matchOrFail(existing: readonly ChainRecord[], submitted: readonly Submitted[]) {
  const match = matchChains(existing, submitted);
  if (!match.ok) throw invalid('环节不属于本活动或类型不一致', match.reason);
  return match;
}

export async function createActivity(tx: Tx, ctx: WriteContext, body: input.ActivityCreate): Promise<ActivityRecord> {
  const chains = body.chains.map(toDraft);
  const startDate = body.startDate ?? null;
  const endDate = body.endDate ?? null;
  checkRules({ startDate, endDate }, chains, activityAccess(ctx).refs.chainsVisible);
  const orgRange = toOrgRange(body.orgRange);
  checkOrgRange(orgRange);
  const next = {
    typeId: body.typeId,
    cycleId: body.cycleId,
    orgRange,
    managerEmployeeId: body.managerEmployeeId,
    categoryIds: unique(body.categoryIds),
    levelIds: unique(body.levelIds),
    noticeOrgRange: unique(body.noticeOrgRange),
    chains,
  };
  await requireOwnerOrg(tx, ctx, body.ownerOrgId);
  await assertAddedRefs(tx, ctx, next, undefined);
  await assertScopeUnique(tx, {
    tenantId: ctx.tenantId,
    timezone: ctx.timezone,
    now: ctx.now,
    scope: ctx.scope,
    orgRange,
    categoryIds: next.categoryIds,
    nameVisible: activityAccess(ctx).refs.nameVisible,
  });
  const now = ctx.now.toISOString();
  const result = await tx.execute(sql`INSERT INTO ev_activities
      (tenant_id, name, type_id, cycle_id, year, start_date, end_date, owner_id, owner_org_id, manager_employee_id,
       applicants, category_ids, level_ids, max_level_jump, effective_date, notice_org_range,
       created_by, created_at, updated_at)
    VALUES (${ctx.tenantId}, ${body.name}, ${next.typeId}, ${next.cycleId}, ${body.year}, ${startDate}::date,
      ${endDate}::date, ${ctx.userId}, ${body.ownerOrgId}, ${next.managerEmployeeId},
      ${textArray(unique(body.applicants))}::text[], ${arrayLiteral(next.categoryIds)}::uuid[],
      ${arrayLiteral(next.levelIds)}::uuid[], ${body.maxLevelJump ?? 1}, ${body.effectiveDate}::date,
      ${arrayLiteral(next.noticeOrgRange)}::uuid[], ${ctx.userId}, ${now}, ${now})
    RETURNING id`);
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  await writeOrgs(tx, ctx, id, orgRange);
  await writeChains(tx, ctx, id, { pairs: [], removed: [] }, chains);
  const after = await loadActivity(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'evaluationActivity', 'create', id, { before: null, after, orgId: after.ownerOrgId });
  return after;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);
const orgKey = (entries: readonly OrgRangeEntry[]) => entries.map((e) => `${e.orgId}:${e.includeDescendants}`);

const lockInput = (activity: {
  typeId: string;
  orgRange: readonly OrgRangeEntry[];
  categoryIds: readonly string[];
  levelIds: readonly string[];
  effectiveDate: string | null;
  noticeOrgRange: readonly string[];
}): ActivityLockInput => activity;

export async function updateActivity(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  body: input.ActivityPatch,
): Promise<ActivityRecord> {
  const row = await lockEditable(tx, ctx, 'evaluationActivity', id);
  // Q-M0-174 第 8 点：已完成的活动不能修改（原站“编辑”置灰，悬停提示原文）
  if (row.status === 'completed') {
    throw new AppError('CONFLICT', '此活动已完成，无法修改', { reason: 'ACTIVITY_COMPLETED' });
  }
  const before = await loadActivity(tx, ctx.tenantId, id);
  const submitted = body.chains ? body.chains.map(toDraft) : undefined;
  const match = submitted ? matchOrFail(before.chains, submitted) : undefined;
  const chains: readonly ChainDraft[] = submitted ?? before.chains;
  const orgRange = body.orgRange ? toOrgRange(body.orgRange) : before.orgRange;
  checkOrgRange(orgRange);
  const merged = {
    name: body.name ?? before.name,
    typeId: body.typeId ?? before.typeId,
    cycleId: body.cycleId ?? before.cycleId,
    year: body.year ?? before.year,
    startDate: body.startDate !== undefined ? body.startDate : before.startDate,
    endDate: body.endDate !== undefined ? body.endDate : before.endDate,
    ownerOrgId: body.ownerOrgId ?? before.ownerOrgId,
    orgRange,
    managerEmployeeId: body.managerEmployeeId ?? before.managerEmployeeId,
    applicants: body.applicants ? unique(body.applicants) : before.applicants,
    categoryIds: body.categoryIds ? unique(body.categoryIds) : before.categoryIds,
    levelIds: body.levelIds ? unique(body.levelIds) : before.levelIds,
    maxLevelJump: body.maxLevelJump ?? before.maxLevelJump,
    effectiveDate: body.effectiveDate ?? before.effectiveDate,
    noticeOrgRange: body.noticeOrgRange ? unique(body.noticeOrgRange) : before.noticeOrgRange,
    chains,
  };
  checkRules(merged, chains, activityAccess(ctx).refs.chainsVisible);
  // EV-R14 / AC-EV-05：已有报名后只许改规定的字段（apply_count 取行锁后的当前值）
  if (Number(row.apply_count) > 0) {
    const chainChange = match
      ? { pairs: match.pairs, added: match.added.length, removed: match.removed.length }
      : { pairs: [], added: 0, removed: 0 };
    if (activityLockedChange(lockInput(before), lockInput(merged), chainChange)) {
      throw new AppError(
        'CONFLICT',
        '活动已有报名人员，只能修改名称、所属组织、年度、周期、负责人、起止日期、申请人、可申报级别、参评条件，以及环节的名称、日期、顺序、流程、转入方式和通知',
        { reason: 'ACTIVITY_HAS_APPLICANTS' },
      );
    }
  }
  if (merged.ownerOrgId !== before.ownerOrgId) await requireOwnerOrg(tx, ctx, merged.ownerOrgId);
  await assertAddedRefs(tx, ctx, merged, before);
  // 改适用组织范围（含“包含下级”）/ 申请类别才重新检查重复（值没变不重判，历史数据里已有的冲突不挡改名等）
  if (!sameSet(orgKey(orgRange), orgKey(before.orgRange)) || !sameSet(merged.categoryIds, before.categoryIds)) {
    await assertScopeUnique(tx, {
      tenantId: ctx.tenantId,
      timezone: ctx.timezone,
      now: ctx.now,
      scope: ctx.scope,
      selfId: id,
      orgRange,
      categoryIds: merged.categoryIds,
      nameVisible: activityAccess(ctx).refs.nameVisible,
    });
  }
  const bump = bumped(ctx);
  await tx.execute(sql`UPDATE ev_activities SET name = ${merged.name},
      type_id = ${merged.typeId}, cycle_id = ${merged.cycleId}, year = ${merged.year},
      start_date = ${merged.startDate}::date, end_date = ${merged.endDate}::date, owner_org_id = ${merged.ownerOrgId},
      manager_employee_id = ${merged.managerEmployeeId}, applicants = ${textArray(merged.applicants)}::text[],
      category_ids = ${arrayLiteral(merged.categoryIds)}::uuid[], level_ids = ${arrayLiteral(merged.levelIds)}::uuid[],
      max_level_jump = ${merged.maxLevelJump}, effective_date = ${merged.effectiveDate}::date,
      notice_org_range = ${arrayLiteral(merged.noticeOrgRange)}::uuid[],
      revision = ${bump.revision}, updated_at = ${bump.updatedAt}
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  if (body.orgRange) await writeOrgs(tx, ctx, id, orgRange);
  if (submitted && match) await writeChains(tx, ctx, id, match, submitted);
  const after = await loadActivity(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'evaluationActivity', 'update', id, { before, after, orgId: after.ownerOrgId });
  return after;
}

/** 删除只允许草稿（Q-M0-174 第 7 点）：进行中 / 已完成按原站文案拒绝；草稿有报名的也拒绝（保守，正常不会出现）。 */
export async function deleteActivity(tx: Tx, ctx: WriteContext, id: string): Promise<ActivityRecord> {
  const row = await lockEditable(tx, ctx, 'evaluationActivity', id);
  if (row.status === 'published') {
    throw new AppError('CONFLICT', '此活动进行中，无法删除', { reason: 'ACTIVITY_NOT_DRAFT' });
  }
  if (row.status === 'completed') {
    throw new AppError('CONFLICT', '此活动已完成，无法删除', { reason: 'ACTIVITY_NOT_DRAFT' });
  }
  if (Number(row.apply_count) > 0) {
    throw new AppError('CONFLICT', '活动已有报名人员，不能删除', { reason: 'ACTIVITY_HAS_APPLICANTS' });
  }
  const before = await loadActivity(tx, ctx.tenantId, id);
  // 环节与组织范围随活动删除（外键 CASCADE）
  await tx.execute(sql`DELETE FROM ev_activities WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  await audit(tx, ctx, 'evaluationActivity', 'delete', id, { before, after: null, orgId: before.ownerOrgId });
  return before;
}
