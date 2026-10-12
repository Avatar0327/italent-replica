/**
 * 评价表（`TEvaluation.EvaluationForm`，标准模式）的读写服务（设计 §3.2、§5.2 #6；规格 24 EV-R3～R5、R40；拆分方案 B4）：
 * - 所属组织必填手选，须存在且在操作人 TEvaluation 范围内（DEC-082 / DEC-324②，范围外与不存在同一 404），读写同一谓词；
 * - DEC-413：按指标 / 评总分 / 投票，投票比例与参考评分；通过分可超过满分，评总分无总分规则和权重；
 * - 评分项整组编辑：standard 至多 1 个、general 任意条；权重经 B2 纯函数校验；新增的通用评分项 / 隐藏指标引用校验权限与
 *   存在性（form-refs.ts），原有引用原样保留不重校；
 * - EV-R5 锁（form-lock.ts）：被“已发布且有提名”的活动引用后，评分相关字段有变化 → 409 FORM_LOCKED（B6 接真实引用）；
 * - 停用 / 删除前检查“被引用”钩子（usage.ts，B5 登记活动环节引用），行锁内检查，评分项随表删除并审计。
 * 评分项只存引用（ID 与权重），不冻结名称：通用评分项 / 指标的名称在读取时按查看人当前权限投影（presentForms）。
 * 每个写入口在命令台账的同一事务里写业务与审计（DEC-019 / 216）。
 */
import { sql, type Tx } from '@italent/db';
import { computeScoreWeights, type ScoreItemInput } from '@italent/domain';
import { AppError } from '../../errors.js';
import { assertNewFormRefs, type FormRefAccess, referenceNames } from './form-refs.js';
import { formLockedByActivities } from './form-lock.js';
import { coordinateActivityForms } from './reference-locks.js';
import type * as input from './input.js';
import { type Tracked, view } from './read-model.js';
import type { View } from './route-support.js';
import { audit, bumped, lockEditable, requireOwnerOrg, rowsOf, type WriteContext } from './store.js';
import { rejectInUse } from './usage.js';

export interface StoredItem {
  readonly kind: 'standard' | 'general';
  readonly generalItemId: string | null;
  readonly weight: number | null;
  readonly hiddenTargetIds: string[];
}
export type FormRecord = Tracked & {
  readonly name: string;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly enabled: boolean;
  readonly scoreMode: 'by_indicator' | 'by_total' | 'by_vote';
  readonly fullScore: number | null;
  readonly passScore: number | null;
  readonly totalRule: 'average' | 'weighted' | 'sum' | null;
  readonly votePassRatio: number | null;
  readonly indicatorReference: boolean;
  readonly weightWarning: { readonly total: number; readonly message: string } | null;
  readonly items: StoredItem[];
};

const invalid = (message: string, reason: string) => new AppError('VALIDATION_FAILED', message, { reason });
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** 读出评分项（按提交顺序）并挂到评价表上；数值列（numeric）转成数字。 */
export async function withItems(tx: Tx, tenantId: string, rows: Record<string, unknown>[]): Promise<FormRecord[]> {
  if (!rows.length) return [];
  const formIds = rows.map((row) => row.id as string);
  const found = rowsOf<{
    form_id: string;
    kind: StoredItem['kind'];
    general_item_id: string | null;
    weight: string | null;
    hidden_target_ids: string[];
  }>(
    await tx.execute(sql`SELECT form_id, kind, general_item_id, weight, hidden_target_ids FROM ev_form_items
      WHERE tenant_id = ${tenantId}::uuid AND form_id = ANY(${`{${formIds.join(',')}}`}::uuid[])
      ORDER BY form_id, seq`),
  );
  return rows.map((row) => {
    const base = view<Omit<FormRecord, 'items'>>(row);
    const form = {
      ...base,
      fullScore: num(base.fullScore),
      passScore: num(base.passScore),
      votePassRatio: num(base.votePassRatio),
      items: found
        .filter((item) => item.form_id === row.id)
        .map((item) => ({
          kind: item.kind,
          generalItemId: item.general_item_id,
          weight: num(item.weight),
          hiddenTargetIds: item.hidden_target_ids,
        })),
    };
    return { ...form, weightWarning: weightWarning(form) };
  });
}

export async function loadForm(tx: Tx, tenantId: string, id: string): Promise<FormRecord> {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT * FROM ev_forms WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`),
  );
  return (await withItems(tx, tenantId, rows))[0]!;
}

/** 响应的评分项：通用评分项带名称（字典查看权 + 范围 + 名称字段权），隐藏指标带名称（指标查看权 + 名称字段权），否则只给 ID。 */
export async function presentForms(
  tx: Tx,
  tenantId: string,
  access: FormRefAccess,
  views: readonly View[],
): Promise<View[]> {
  const forms = views as readonly FormRecord[];
  const items = forms.flatMap((form) => form.items);
  const names = await referenceNames(tx, tenantId, access, {
    generalItemIds: items.flatMap((item) => (item.generalItemId ? [item.generalItemId] : [])),
    targetIds: items.flatMap((item) => item.hiddenTargetIds),
  });
  return forms.map((form) => ({
    ...form,
    items: form.items.map((item) =>
      item.kind === 'general'
        ? {
            kind: item.kind,
            generalItemId: item.generalItemId,
            ...(names.general.has(item.generalItemId!) ? { name: names.general.get(item.generalItemId!) } : {}),
            ...(hasIndicators(form) ? { weight: item.weight } : {}),
          }
        : {
            kind: item.kind,
            ...(hasIndicators(form) ? { weight: item.weight } : {}),
            hiddenTargets: item.hiddenTargetIds.map((id) => ({
              id,
              ...(names.target.has(id) ? { name: names.target.get(id) } : {}),
            })),
          },
    ),
  })) as unknown as View[];
}

interface Settings {
  readonly scoreMode: FormRecord['scoreMode'];
  readonly fullScore: number | null;
  readonly passScore: number | null;
  readonly totalRule: FormRecord['totalRule'];
  readonly votePassRatio: number | null;
  readonly indicatorReference: boolean;
}

const hasIndicators = (settings: Pick<Settings, 'scoreMode' | 'indicatorReference'>) =>
  settings.scoreMode === 'by_indicator' || (settings.scoreMode === 'by_vote' && settings.indicatorReference);
const hasScores = (settings: Pick<Settings, 'scoreMode' | 'indicatorReference'>) =>
  settings.scoreMode !== 'by_vote' || settings.indicatorReference;

/** DEC-413：合计按百分数的小数位精确相加，仅给警示，保存不阻断。 */
function weightWarning(form: Settings & { items: readonly StoredItem[] }): FormRecord['weightWarning'] {
  if (!hasIndicators(form) || form.totalRule !== 'weighted') return null;
  const scaled = form.items.reduce((sum, item) => sum + Math.round((item.weight ?? 0) * 100), 0);
  return scaled === 10_000 ? null : { total: scaled / 100, message: '评分项权重合计不等于100%' };
}

/** 表单设置的跨字段规则（对合并后的完整值判）。 */
function checkSettings(settings: Settings): void {
  if (hasIndicators(settings) && !settings.totalRule) {
    throw invalid('按指标评分须设置总分计算规则', 'FORM_TOTAL_RULE_REQUIRED');
  }
  if (!hasIndicators(settings) && settings.totalRule) {
    throw invalid('评总分只设满分与通过分数，不设总分计算规则', 'FORM_TOTAL_RULE_NOT_ALLOWED');
  }
  if (hasScores(settings)) {
    if (settings.fullScore === null || settings.passScore === null) {
      throw invalid('满分与通过分数必填', 'FORM_SCORES_REQUIRED');
    }
  } else if (settings.fullScore !== null || settings.passScore !== null) {
    throw invalid('未启用参考评分的投票不设满分与通过分数', 'FORM_SCORES_NOT_ALLOWED');
  }
  if (settings.scoreMode === 'by_vote') {
    if (settings.votePassRatio === null) throw invalid('通过票数比例必填', 'FORM_VOTE_RATIO_REQUIRED');
  } else if (settings.votePassRatio !== null || settings.indicatorReference) {
    throw invalid('只有投票设置通过票数比例与参考评分', 'FORM_VOTE_SETTINGS_NOT_ALLOWED');
  }
}

const toStored = (item: input.FormItemInput): StoredItem =>
  item.kind === 'general'
    ? { kind: 'general', generalItemId: item.generalItemId, weight: item.weight ?? null, hiddenTargetIds: [] }
    : {
        kind: 'standard',
        generalItemId: null,
        weight: item.weight ?? null,
        hiddenTargetIds: [...new Set(item.hiddenTargetIds ?? [])],
      };

/** 评分项的结构规则：standard 至多 1 个；权重 0～100（B2 纯函数，EV-R40）。 */
function checkItems(items: readonly StoredItem[]): void {
  if (items.filter((item) => item.kind === 'standard').length > 1) {
    throw invalid('任职资格标准评分项最多一个', 'FORM_STANDARD_ITEM_DUPLICATE');
  }
  const generalIds = items.flatMap((item) => (item.generalItemId ? [item.generalItemId] : []));
  if (new Set(generalIds).size !== generalIds.length) {
    throw invalid('通用评分项不能重复', 'FORM_GENERAL_ITEM_DUPLICATE');
  }
  const scoreItems: ScoreItemInput[] = items.map((item, index) =>
    item.kind === 'general'
      ? { kind: 'general', id: String(index), weight: item.weight }
      : { kind: 'standard', id: String(index), weight: item.weight, indicators: [] },
  );
  const weights = computeScoreWeights('weighted', scoreItems);
  if (!weights.ok) throw invalid('评分项权重须在 0～100 之间', weights.code);
}

/** 新增的引用：通用评分项 / 隐藏指标 ID 里原有集合之外的（原有的原样保留，不重校）。 */
function addedRefs(items: readonly StoredItem[], existing: readonly StoredItem[]) {
  const had = {
    general: new Set(existing.flatMap((item) => (item.generalItemId ? [item.generalItemId] : []))),
    target: new Set(existing.flatMap((item) => item.hiddenTargetIds)),
  };
  return {
    generalItemIds: items.flatMap((item) =>
      item.generalItemId && !had.general.has(item.generalItemId) ? [item.generalItemId] : [],
    ),
    targetIds: items.flatMap((item) => item.hiddenTargetIds.filter((id) => !had.target.has(id))),
  };
}

async function replaceItems(tx: Tx, ctx: WriteContext, formId: string, items: readonly StoredItem[]) {
  await tx.execute(
    sql`DELETE FROM ev_form_items WHERE tenant_id = ${ctx.tenantId}::uuid AND form_id = ${formId}::uuid`,
  );
  for (const [seq, item] of items.entries()) {
    await tx.execute(sql`INSERT INTO ev_form_items
        (tenant_id, form_id, kind, general_item_id, weight, hidden_target_ids, seq)
      VALUES (${ctx.tenantId}, ${formId}, ${item.kind}, ${item.generalItemId}, ${item.weight},
        ${`{${item.hiddenTargetIds.join(',')}}`}::uuid[], ${seq})`);
  }
}

function formAccess(ctx: WriteContext): FormRefAccess {
  if (!ctx.forms) throw new Error('评价表写命令缺少引用访问（forms）');
  return ctx.forms;
}

/** 派生警示只用于响应；审计记录实际业务字段，避免合计成为评分项字段裁剪以外的披露出口。 */
const auditSnapshot = (form: FormRecord) =>
  Object.fromEntries(Object.entries(form).filter(([field]) => field !== 'weightWarning'));

export async function createForm(tx: Tx, ctx: WriteContext, body: input.FormCreate): Promise<FormRecord> {
  await coordinateActivityForms(tx, ctx.tenantId);
  const settings: Settings = {
    scoreMode: body.scoreMode,
    fullScore: body.fullScore ?? null,
    passScore: body.passScore ?? null,
    totalRule: body.totalRule ?? null,
    votePassRatio: body.votePassRatio ?? null,
    indicatorReference: body.indicatorReference ?? false,
  };
  checkSettings(settings);
  const items = body.items.map(toStored);
  checkItems(items);
  checkItemMode(settings, items);
  await requireOwnerOrg(tx, ctx, body.ownerOrgId);
  await assertNewFormRefs(tx, ctx, formAccess(ctx), addedRefs(items, []));
  const now = ctx.now.toISOString();
  const result = await tx.execute(sql`INSERT INTO ev_forms
      (tenant_id, name, owner_id, owner_org_id, enabled, score_mode, full_score, pass_score, total_rule,
       vote_pass_ratio, indicator_reference,
       created_by, created_at, updated_at)
    VALUES (${ctx.tenantId}, ${body.name}, ${ctx.userId}, ${body.ownerOrgId}, ${body.enabled ?? true},
      ${settings.scoreMode}, ${settings.fullScore}, ${settings.passScore}, ${settings.totalRule},
      ${settings.votePassRatio}, ${settings.indicatorReference},
      ${ctx.userId}, ${now}, ${now}) RETURNING id`);
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  await replaceItems(tx, ctx, id, items);
  const after = await loadForm(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'evaluationForm', 'create', id, {
    before: null,
    after: auditSnapshot(after),
    orgId: after.ownerOrgId,
  });
  return after;
}

/** 评分相关内容的规范形（EV-R5 锁比较用）：评分项里隐藏指标与顺序无关的部分排序。 */
const lockedContent = (form: Settings & { items: readonly StoredItem[] }) =>
  JSON.stringify({
    scoreMode: form.scoreMode,
    fullScore: form.fullScore,
    passScore: form.passScore,
    totalRule: form.totalRule,
    votePassRatio: form.votePassRatio,
    indicatorReference: form.indicatorReference,
    items: form.items.map((item) => ({ ...item, hiddenTargetIds: [...item.hiddenTargetIds].sort() })),
  });

/** 模式切换清空不适用的值；显式提交不适用的值仍按规则拒绝，不能默默吞掉输入（DEC-413）。 */
function settingValue<T>(next: T | undefined, current: T, applicable: boolean): T | null {
  if (next !== undefined) return next;
  return applicable ? current : null;
}

function mergedSettings(before: FormRecord, body: input.FormPatch): Settings & { items: StoredItem[] } {
  const scoreMode = body.scoreMode ?? before.scoreMode;
  const indicatorReference = body.indicatorReference ?? (scoreMode === 'by_vote' && before.indicatorReference);
  const mode = { scoreMode, indicatorReference };
  const items = body.items ? body.items.map(toStored) : before.items;
  return {
    ...mode,
    fullScore: settingValue(body.fullScore, before.fullScore, hasScores(mode)),
    passScore: settingValue(body.passScore, before.passScore, hasScores(mode)),
    totalRule: settingValue(body.totalRule, before.totalRule, hasIndicators(mode)),
    votePassRatio: settingValue(body.votePassRatio, before.votePassRatio, scoreMode === 'by_vote'),
    items: !body.items && !hasIndicators(mode) ? items.map((item) => ({ ...item, weight: null })) : items,
  };
}

function checkItemMode(settings: Settings, items: readonly StoredItem[]): void {
  if (!hasIndicators(settings) && items.some((item) => item.weight !== null)) {
    throw invalid('当前打分规则不设评分项权重', 'FORM_WEIGHT_NOT_ALLOWED');
  }
}

/** 载荷之外的实际变更同样复核编辑权（#218 P2-2）；权重属于 items，清空分数 / 投票设置各用自身字段权。 */
async function checkImplicitFields(
  ctx: WriteContext,
  before: FormRecord,
  merged: Settings & { items: StoredItem[] },
  body: input.FormPatch,
): Promise<void> {
  const changes: Record<string, unknown> = {};
  for (const field of [
    'fullScore',
    'passScore',
    'totalRule',
    'votePassRatio',
    'indicatorReference',
    'items',
  ] as const) {
    if (body[field] === undefined && JSON.stringify(merged[field]) !== JSON.stringify(before[field])) {
      changes[field] = merged[field];
    }
  }
  if (Object.keys(changes).length) {
    if (!ctx.checkFields) throw new Error('评价表写命令缺少字段授权校验（checkFields）');
    await ctx.checkFields(changes);
  }
}

export async function updateForm(tx: Tx, ctx: WriteContext, id: string, body: input.FormPatch): Promise<FormRecord> {
  await coordinateActivityForms(tx, ctx.tenantId, id);
  const row = await lockEditable(tx, ctx, 'evaluationForm', id);
  const before = await loadForm(tx, ctx.tenantId, id);
  const merged = mergedSettings(before, body);
  checkSettings(merged);
  await checkImplicitFields(ctx, before, merged, body);
  checkItems(merged.items);
  checkItemMode(merged, merged.items);
  // 协调入口先锁引用活动，再锁评价表；引用集合稳定后检查，包含新增环节的外键隐式锁（B6 P2-2）。
  if (body.enabled === false && before.enabled) await rejectInUse(tx, ctx, 'evaluationForm', id, 'disable');
  if (lockedContent(merged) !== lockedContent(before) && (await formLockedByActivities(tx, ctx.tenantId, id))) {
    throw new AppError('CONFLICT', '评价表已被进行中且已有提名人员的活动引用，评分相关内容不能修改', {
      reason: 'FORM_LOCKED',
    });
  }
  // 改所属组织：新组织同样须在范围内（DEC-082）；没改就不重判
  if (body.ownerOrgId !== undefined && body.ownerOrgId !== row.owner_org_id) {
    await requireOwnerOrg(tx, ctx, body.ownerOrgId);
  }
  if (body.items) await assertNewFormRefs(tx, ctx, formAccess(ctx), addedRefs(merged.items, before.items));
  const bump = bumped(ctx);
  const sets = [
    sql`score_mode = ${merged.scoreMode}`,
    sql`full_score = ${merged.fullScore}`,
    sql`pass_score = ${merged.passScore}`,
    sql`total_rule = ${merged.totalRule}`,
    sql`vote_pass_ratio = ${merged.votePassRatio}`,
    sql`indicator_reference = ${merged.indicatorReference}`,
    ...(body.name !== undefined ? [sql`name = ${body.name}`] : []),
    ...(body.enabled !== undefined ? [sql`enabled = ${body.enabled}`] : []),
    ...(body.ownerOrgId !== undefined ? [sql`owner_org_id = ${body.ownerOrgId}`] : []),
    sql`revision = ${bump.revision}`,
    sql`updated_at = ${bump.updatedAt}`,
  ];
  await tx.execute(sql`UPDATE ev_forms SET ${sql.join(sets, sql`, `)}
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  if (body.items || JSON.stringify(merged.items) !== JSON.stringify(before.items)) {
    await replaceItems(tx, ctx, id, merged.items);
  }
  const after = await loadForm(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'evaluationForm', 'update', id, {
    before: auditSnapshot(before),
    after: auditSnapshot(after),
    orgId: after.ownerOrgId,
  });
  return after;
}

export async function deleteForm(tx: Tx, ctx: WriteContext, id: string): Promise<FormRecord> {
  await coordinateActivityForms(tx, ctx.tenantId, id);
  await lockEditable(tx, ctx, 'evaluationForm', id);
  // B5 登记“被评定活动环节引用”（usage.ts 钩子位）
  await rejectInUse(tx, ctx, 'evaluationForm', id);
  const before = await loadForm(tx, ctx.tenantId, id);
  // 评分项随评价表删除（外键 CASCADE），删除快照连同评分项写进审计
  await tx.execute(sql`DELETE FROM ev_forms WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  await audit(tx, ctx, 'evaluationForm', 'delete', id, {
    before: auditSnapshot(before),
    after: null,
    orgId: before.ownerOrgId,
  });
  return before;
}
