/**
 * 套卷（docs/02_业务建模/25 §3.1）：关键行为与等级评定两类（民主推荐表、多选题不在首版范围）。
 * 状态 草稿 / 已启用 / 已使用（E3-R2）：草稿与已启用可删可改；已使用不可删，只能在用到它的活动都不处于启用状态时
 * 按稳定键原位修改文字与权重（结构——指标、题目、选项、角色的增删与挂接、选项分值——不可改）。
 * 内容以“整卷提交”写入：客户端用稳定键描述结构，服务端落到明确的表与列（AGENTS.md §7）。
 * PR-B 题库 / 套卷模板（E3-R10）：模板与套卷同表同结构（template 标记），共用整卷保存与校验；套卷入口只取套卷、
 * 模板入口只取模板，互不可见（模板不能被评价对象选用）。“另存为模板”与“从模板新建套卷”都是复制，之后两边各改
 * 各的，互不回写。模板的修改权与套卷同一口径（本人或“编辑他人套卷”）；共享部门 / 共享人属 F-040，不在本 PR。
 */
import {
  and,
  eq,
  inArray,
  sql,
  survey360Dimensions,
  survey360QuestionnaireRoles,
  survey360Questionnaires,
  survey360Questions,
  survey360Roles,
  survey360ScaleOptions,
  survey360Scales,
  type Tx,
} from '@italent/db';
import { survey360 } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import {
  actor,
  type Admin,
  audit360,
  BUTTONS,
  can,
  fail,
  optionalText,
  read,
  requireNewObject,
  requireRevision,
  rows,
  type Survey360Context,
  text,
  uuid,
  write,
} from './context.js';
import { markQuestionnaireChanged } from './changes.js';

type QuestionnaireRow = typeof survey360Questionnaires.$inferSelect;

const key = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const weight = z.number().finite().min(0).max(1_000_000);
const contentSchema = z.strictObject({
  roles: z.array(z.strictObject({ key, roleId: uuid, weight: z.number().int().min(0).max(1_000_000) })).max(90),
  scales: z
    .array(
      z.strictObject({
        key,
        name: text(100),
        options: z
          .array(
            z.strictObject({
              key,
              label: text(100),
              value: z.number().finite().nullable().optional(),
              notScored: z.boolean().optional(),
              remarkRequired: z.boolean().optional(),
            }),
          )
          .max(50),
      }),
    )
    .max(50),
  dimensions: z
    .array(
      z.strictObject({
        key,
        parentKey: key.nullable().optional(),
        name: text(200),
        definition: optionalText(2000),
        weight,
        scaleKey: key.nullable().optional(),
        roleIds: z.array(uuid).max(15).optional(),
      }),
    )
    .max(500),
  questions: z
    .array(
      z.strictObject({
        key,
        dimensionKey: key,
        text: text(1000),
        weight: weight.optional(),
        scaleKey: key,
        allowRemark: z.boolean().optional(),
        roleIds: z.array(uuid).max(15).optional(),
      }),
    )
    .max(2000),
});
type Content = z.infer<typeof contentSchema>;

const excellence = z
  .strictObject({ linePercent: z.number().gt(0).max(100), maxRate: z.number().gt(0).max(100) })
  .nullable();
const headerSchema = {
  name: text(200),
  scoreMethod: z.enum(['weighted_average', 'weighted_sum']).optional(),
  guide: optionalText(5000),
  excellence: excellence.optional(),
};
const createSchema = z.strictObject({ ...headerSchema, type: z.enum(['key_behavior', 'rating']) });
const updateSchema = z.strictObject({ ...headerSchema, name: text(200).optional(), content: contentSchema.optional() });

export interface LoadedQuestionnaire {
  readonly row: QuestionnaireRow;
  readonly model: survey360.QuestionnaireModel;
  readonly roles: (typeof survey360QuestionnaireRoles.$inferSelect)[];
  readonly scales: (typeof survey360Scales.$inferSelect)[];
  readonly options: (typeof survey360ScaleOptions.$inferSelect)[];
  readonly dimensions: (typeof survey360Dimensions.$inferSelect)[];
  readonly questions: (typeof survey360Questions.$inferSelect)[];
}

async function questionnaireRow(tx: Tx, id: string, lock: boolean, template: boolean) {
  const query = tx
    .select()
    .from(survey360Questionnaires)
    .where(
      and(
        eq(survey360Questionnaires.id, id),
        eq(survey360Questionnaires.deleted, false),
        eq(survey360Questionnaires.template, template),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) fail('NOT_FOUND', template ? '套卷模板不存在' : '套卷不存在');
  return row;
}

export async function loadQuestionnaire(
  tx: Tx,
  id: string,
  lock = false,
  template = false,
): Promise<LoadedQuestionnaire> {
  const row = await questionnaireRow(tx, id, lock, template);
  const roles = await tx
    .select()
    .from(survey360QuestionnaireRoles)
    .where(eq(survey360QuestionnaireRoles.questionnaireId, id))
    .orderBy(survey360QuestionnaireRoles.sort);
  const scales = await tx
    .select()
    .from(survey360Scales)
    .where(eq(survey360Scales.questionnaireId, id))
    .orderBy(survey360Scales.sort);
  const options = await tx
    .select()
    .from(survey360ScaleOptions)
    .where(eq(survey360ScaleOptions.questionnaireId, id))
    .orderBy(survey360ScaleOptions.sort);
  const dimensions = await tx
    .select()
    .from(survey360Dimensions)
    .where(eq(survey360Dimensions.questionnaireId, id))
    .orderBy(survey360Dimensions.sort);
  const questions = await tx
    .select()
    .from(survey360Questions)
    .where(eq(survey360Questions.questionnaireId, id))
    .orderBy(survey360Questions.sort);
  const selfRole = roles.length
    ? (await tx.select({ id: survey360Roles.id }).from(survey360Roles).where(eq(survey360Roles.code, 'self')))[0]?.id
    : undefined;
  const model: survey360.QuestionnaireModel = {
    type: row.type as survey360.QuestionnaireType,
    scoreMethod: row.scoreMethod as survey360.ScoreMethod,
    roles: roles.map((r) => ({ roleId: r.roleId, weight: r.weight, isSelf: r.roleId === selfRole })),
    scales: scales.map((s) => ({
      id: s.id,
      name: s.name,
      options: options
        .filter((o) => o.scaleId === s.id)
        .map((o) => ({
          id: o.id,
          scaleId: o.scaleId,
          label: o.label,
          value: o.notScored ? null : o.value,
          notScored: o.notScored,
          remarkRequired: o.remarkRequired,
        })),
    })),
    dimensions: dimensions.map((d) => ({
      id: d.id,
      parentId: d.parentId,
      name: d.name,
      weight: d.weight,
      scaleId: d.scaleId,
      roleIds: d.roleIds,
    })),
    questions: questions.map((q) => ({
      id: q.id,
      dimensionId: q.dimensionId,
      text: q.text,
      weight: q.weight,
      scaleId: q.scaleId,
      roleIds: q.roleIds,
    })),
  };
  return { row, model, roles, scales, options, dimensions, questions };
}

/**
 * F-053：取套卷行锁的统一顺序——按 id 升序逐个 FOR UPDATE。活动启用、新增评价对象、替换套卷都经此取锁：
 * 后两者按请求数组顺序插入关联时，外键 KEY SHARE 锁的顺序由调用方决定，会与启用的升序行锁反向等待成死锁。
 * 调用方须已持有活动行锁（锁顺序 活动 → 套卷）；套卷编辑 / 删除只锁套卷，不会反向等活动。
 */
export async function lockQuestionnaires(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of [...ids].sort())
    await tx
      .select({ id: survey360Questionnaires.id })
      .from(survey360Questionnaires)
      .where(eq(survey360Questionnaires.id, id))
      .for('update');
}

export function questionnaireView(q: LoadedQuestionnaire) {
  const line = q.row.excellentLinePercent;
  const rate = q.row.excellentMaxRate;
  return {
    id: q.row.id,
    name: q.row.name,
    type: q.row.type,
    status: q.row.status,
    createdBy: q.row.createdBy,
    scoreMethod: q.row.scoreMethod,
    guide: q.row.guide,
    excellence: line !== null && rate !== null ? { linePercent: Number(line), maxRate: Number(rate) } : null,
    revision: q.row.revision,
    roles: q.roles.map((r) => ({ id: r.id, key: r.key, roleId: r.roleId, weight: r.weight })),
    scales: q.scales.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      options: q.options
        .filter((o) => o.scaleId === s.id)
        .map((o) => ({
          id: o.id,
          key: o.key,
          label: o.label,
          value: o.value,
          notScored: o.notScored,
          remarkRequired: o.remarkRequired,
        })),
    })),
    dimensions: q.dimensions.map((d) => ({
      id: d.id,
      key: d.key,
      parentId: d.parentId,
      name: d.name,
      definition: d.definition,
      weight: d.weight,
      scaleId: d.scaleId,
      roleIds: d.roleIds,
    })),
    questions: q.questions.map((x) => ({
      id: x.id,
      key: x.key,
      dimensionId: x.dimensionId,
      text: x.text,
      weight: x.weight,
      scaleId: x.scaleId,
      allowRemark: x.allowRemark,
      roleIds: x.roleIds,
    })),
  };
}

/**
 * 修改权（DEC-280①）：套卷创建人，或持“编辑他人套卷”按钮者（360 系统管理员）。命令前（含重放）与命令事务内各判一次。
 */
function editableBy(deps: TenantRouteDeps, tenant: TenantContext, id: string, deleted = false, template = false) {
  // deleted：删除命令的命令前校验（含重放）按删除前的行判定本人 / 编辑他人套卷，重放返回原回执
  return async (tx: Tx, admin: Admin): Promise<void> => {
    const [row] = await tx
      .select({ createdBy: survey360Questionnaires.createdBy })
      .from(survey360Questionnaires)
      .where(
        and(
          eq(survey360Questionnaires.id, id),
          eq(survey360Questionnaires.template, template),
          deleted ? undefined : eq(survey360Questionnaires.deleted, false),
        ),
      );
    if (!row) fail('NOT_FOUND', template ? '套卷模板不存在' : '套卷不存在');
    if (row.createdBy === admin.userId) return;
    if (!(await can(tx, deps, tenant, 'questionnaire', 'update', BUTTONS.editOthers)))
      fail('FORBIDDEN', '不能编辑非本人创建的套卷', 'QUESTIONNAIRE_NOT_OWNER');
  };
}

/** 结构引用校验（保存时）：键唯一、引用存在、等级评定与关键行为的挂接方式。 */
function checkReferences(content: Content, type: string): void {
  const unique = (keys: string[], what: string) => {
    if (new Set(keys).size !== keys.length) fail('VALIDATION_FAILED', `${what}的键重复`, 'DUPLICATE_KEY');
  };
  unique(
    content.roles.map((r) => r.key),
    '角色',
  );
  unique(
    content.roles.map((r) => r.roleId),
    '角色',
  );
  unique(
    content.scales.map((s) => s.key),
    '选项组',
  );
  unique(
    content.scales.flatMap((s) => s.options.map((o) => o.key)),
    '选项',
  );
  unique(
    content.dimensions.map((d) => d.key),
    '指标',
  );
  unique(
    content.questions.map((q) => q.key),
    '题目',
  );
  const scales = new Set(content.scales.map((s) => s.key));
  const dims = new Set(content.dimensions.map((d) => d.key));
  for (const s of content.scales)
    for (const o of s.options)
      if (!o.notScored && (o.value === null || o.value === undefined))
        fail('VALIDATION_FAILED', '计分选项必须有分值', 'OPTION_VALUE_REQUIRED');
  for (const d of content.dimensions) {
    if (d.parentKey && (!dims.has(d.parentKey) || d.parentKey === d.key))
      fail('VALIDATION_FAILED', '上级指标不存在', 'PARENT_NOT_FOUND');
    if (d.scaleKey && !scales.has(d.scaleKey)) fail('VALIDATION_FAILED', '评定等级不存在', 'SCALE_NOT_FOUND');
    if (d.scaleKey && type !== 'rating')
      fail('VALIDATION_FAILED', '只有等级评定的指标设评定等级', 'SCALE_ON_DIMENSION');
  }
  // 指标只允许两层（复合 → 基础），避免成环
  const parent = new Map(content.dimensions.map((d) => [d.key, d.parentKey ?? null]));
  for (const d of content.dimensions)
    if (d.parentKey && parent.get(d.parentKey)) fail('VALIDATION_FAILED', '指标最多两层', 'DIMENSION_TOO_DEEP');
  for (const q of content.questions) {
    if (!dims.has(q.dimensionKey)) fail('VALIDATION_FAILED', '题目所属指标不存在', 'DIMENSION_NOT_FOUND');
    if (!scales.has(q.scaleKey)) fail('VALIDATION_FAILED', '题目的选项组不存在', 'SCALE_NOT_FOUND');
  }
  if (content.roles.length > survey360.SURVEY360_LIMITS.rolesPerQuestionnaire)
    fail('VALIDATION_FAILED', '单套卷最多 15 个角色（含自评）', 'TOO_MANY_ROLES');
  for (const s of content.scales)
    if (s.options.length > survey360.SURVEY360_LIMITS.optionsPerScale)
      fail('VALIDATION_FAILED', '选项最多 15 个', 'TOO_MANY_OPTIONS');
}

async function replaceContent(tx: Tx, ctx: Survey360Context, id: string, content: Content): Promise<void> {
  const roleIds = content.roles.map((r) => r.roleId);
  if (roleIds.length) {
    const known = await tx
      .select({ id: survey360Roles.id })
      .from(survey360Roles)
      .where(inArray(survey360Roles.id, roleIds));
    if (known.length !== roleIds.length) fail('VALIDATION_FAILED', '评价角色不存在', 'ROLE_NOT_FOUND');
  }
  await tx.delete(survey360Questions).where(eq(survey360Questions.questionnaireId, id));
  await tx.execute(sql`UPDATE survey360_dimensions SET parent_id = NULL WHERE questionnaire_id = ${id}::uuid`);
  await tx.delete(survey360Dimensions).where(eq(survey360Dimensions.questionnaireId, id));
  await tx.delete(survey360ScaleOptions).where(eq(survey360ScaleOptions.questionnaireId, id));
  await tx.delete(survey360Scales).where(eq(survey360Scales.questionnaireId, id));
  await tx.delete(survey360QuestionnaireRoles).where(eq(survey360QuestionnaireRoles.questionnaireId, id));
  const base = { tenantId: ctx.tenantId, questionnaireId: id };
  if (content.roles.length)
    await tx
      .insert(survey360QuestionnaireRoles)
      .values(content.roles.map((r, sort) => ({ ...base, key: r.key, sort, roleId: r.roleId, weight: r.weight })));
  const scaleIds = new Map<string, string>();
  for (const [sort, s] of content.scales.entries()) {
    const [row] = await tx
      .insert(survey360Scales)
      .values({ ...base, key: s.key, sort, name: s.name })
      .returning();
    scaleIds.set(s.key, row!.id);
    if (s.options.length)
      await tx.insert(survey360ScaleOptions).values(
        s.options.map((o, i) => ({
          ...base,
          key: o.key,
          sort: i,
          scaleId: row!.id,
          label: o.label,
          value: o.notScored ? null : (o.value ?? null),
          notScored: o.notScored ?? false,
          remarkRequired: o.remarkRequired ?? false,
        })),
      );
  }
  const dimensionIds = new Map<string, string>();
  const ordered = [...content.dimensions].sort((a, b) => Number(!!a.parentKey) - Number(!!b.parentKey));
  for (const d of ordered) {
    const [row] = await tx
      .insert(survey360Dimensions)
      .values({
        ...base,
        key: d.key,
        sort: content.dimensions.indexOf(d),
        parentId: d.parentKey ? dimensionIds.get(d.parentKey)! : null,
        name: d.name,
        definition: d.definition ?? null,
        weight: d.weight,
        scaleId: d.scaleKey ? scaleIds.get(d.scaleKey)! : null,
        roleIds: d.roleIds ?? [],
      })
      .returning();
    dimensionIds.set(d.key, row!.id);
  }
  if (content.questions.length)
    await tx.insert(survey360Questions).values(
      content.questions.map((q, sort) => ({
        ...base,
        key: q.key,
        sort,
        dimensionId: dimensionIds.get(q.dimensionKey)!,
        text: q.text,
        weight: q.weight ?? 1,
        scaleId: scaleIds.get(q.scaleKey)!,
        allowRemark: q.allowRemark ?? false,
        roleIds: q.roleIds ?? [],
      })),
    );
}

/** 已使用套卷的局部修改：结构（键集合、挂接、选项分值与计分属性、角色）必须完全一致，只改文字与权重。 */
async function updateInPlace(tx: Tx, current: LoadedQuestionnaire, content: Content): Promise<void> {
  const structural = () => fail('CONFLICT', '已使用的套卷不能修改结构，只能修改文字与权重', 'QUESTIONNAIRE_USED');
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const sorted = (xs: string[]) => [...xs].sort();
  const keyOf = <T extends { id: string; key: string }>(list: T[], id: string | null) =>
    id === null ? null : (list.find((x) => x.id === id)?.key ?? null);
  if (
    !same(
      sorted(content.roles.map((r) => `${r.key}:${r.roleId}`)),
      sorted(current.roles.map((r) => `${r.key}:${r.roleId}`)),
    )
  )
    structural();
  const optionSig = (
    s: { key: string; label?: string },
    o: { key: string; value?: number | null; notScored?: boolean; remarkRequired?: boolean },
  ) => `${s.key}/${o.key}:${o.notScored ? 'n' : String(o.value)}:${o.remarkRequired ? 'r' : ''}`;
  const currentOptions = current.options.map((o) =>
    optionSig({ key: keyOf(current.scales, o.scaleId)! }, { ...o, value: o.notScored ? null : o.value }),
  );
  if (!same(sorted(content.scales.flatMap((s) => s.options.map((o) => optionSig(s, o)))), sorted(currentOptions)))
    structural();
  if (!same(sorted(content.scales.map((s) => s.key)), sorted(current.scales.map((s) => s.key)))) structural();
  const dimSig = (d: { key: string; parentKey?: string | null; scaleKey?: string | null; roleIds?: string[] }) =>
    `${d.key}<${d.parentKey ?? ''}>${d.scaleKey ?? ''}[${sorted(d.roleIds ?? []).join(',')}]`;
  const currentDims = current.dimensions.map((d) =>
    dimSig({
      key: d.key,
      parentKey: keyOf(current.dimensions, d.parentId),
      scaleKey: keyOf(current.scales, d.scaleId),
      roleIds: d.roleIds,
    }),
  );
  if (!same(sorted(content.dimensions.map(dimSig)), sorted(currentDims))) structural();
  const qSig = (q: {
    key: string;
    dimensionKey: string;
    scaleKey: string;
    roleIds?: string[];
    allowRemark?: boolean;
  }) => `${q.key}<${q.dimensionKey}>${q.scaleKey}[${sorted(q.roleIds ?? []).join(',')}]${q.allowRemark ? 'r' : ''}`;
  const currentQs = current.questions.map((q) =>
    qSig({
      key: q.key,
      dimensionKey: keyOf(current.dimensions, q.dimensionId)!,
      scaleKey: keyOf(current.scales, q.scaleId)!,
      roleIds: q.roleIds,
      allowRemark: q.allowRemark,
    }),
  );
  if (!same(sorted(content.questions.map(qSig)), sorted(currentQs))) structural();
  const id = current.row.id;
  for (const r of content.roles)
    await tx
      .update(survey360QuestionnaireRoles)
      .set({ weight: r.weight })
      .where(and(eq(survey360QuestionnaireRoles.questionnaireId, id), eq(survey360QuestionnaireRoles.key, r.key)));
  for (const s of content.scales) {
    await tx
      .update(survey360Scales)
      .set({ name: s.name })
      .where(and(eq(survey360Scales.questionnaireId, id), eq(survey360Scales.key, s.key)));
    for (const o of s.options)
      await tx
        .update(survey360ScaleOptions)
        .set({ label: o.label })
        .where(and(eq(survey360ScaleOptions.questionnaireId, id), eq(survey360ScaleOptions.key, o.key)));
  }
  for (const d of content.dimensions)
    await tx
      .update(survey360Dimensions)
      .set({ name: d.name, definition: d.definition ?? null, weight: d.weight })
      .where(and(eq(survey360Dimensions.questionnaireId, id), eq(survey360Dimensions.key, d.key)));
  for (const q of content.questions)
    await tx
      .update(survey360Questions)
      .set({ text: q.text, weight: q.weight ?? 1 })
      .where(and(eq(survey360Questions.questionnaireId, id), eq(survey360Questions.key, q.key)));
}

/** 用到该套卷、且当前处于启用状态的活动数。 */
async function enabledActivitiesUsing(tx: Tx, id: string): Promise<number> {
  const [row] = rows<{ n: number }>(
    await tx.execute(sql`SELECT count(DISTINCT a.id)::int AS n FROM survey360_object_questionnaires oq
      JOIN survey360_objects o ON o.tenant_id = oq.tenant_id AND o.id = oq.object_id AND NOT o.removed
      JOIN survey360_activities a ON a.tenant_id = o.tenant_id AND a.id = o.activity_id
      WHERE oq.questionnaire_id = ${id}::uuid AND a.status = 'enabled' AND NOT a.deleted`),
  );
  return row!.n;
}

function issuesFail(issues: survey360.QuestionnaireIssue[]): void {
  if (issues.length)
    fail('VALIDATION_FAILED', '套卷不满足启用条件', 'QUESTIONNAIRE_INVALID', {
      issues: issues.map((i) => ({ code: i.code, message: i.message, ...(i.itemId ? { itemId: i.itemId } : {}) })),
    });
}

async function auditQuestionnaire(
  tx: Tx,
  ctx: Survey360Context,
  action: string,
  before: unknown,
  after: LoadedQuestionnaire,
) {
  await audit360(tx, actor(ctx), {
    action,
    objectType: 'survey360-questionnaire',
    objectId: after.row.id,
    before,
    after: questionnaireView(after),
  });
}

const QUESTIONNAIRES = '/questionnaires';
const TEMPLATES = '/questionnaire-templates';
const SAVE_AS_TEMPLATE = `${QUESTIONNAIRES}/:id/save-as-template`;
const INSTANTIATE = `${TEMPLATES}/:id/instantiate`;

export function registerQuestionnaireRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerQuestionnaireReads(module, deps);
  registerQuestionnaireUpdate(module, deps);
  registerQuestionnaireDelete(module, deps);
  registerQuestionnaireEnable(module, deps);
  registerTemplateCopies(module, deps);
}

const VIEW = { object: 'questionnaire' } as const;

function registerQuestionnaireReads(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // 套卷与套卷模板同一套处理函数；路径写成字面量数组，F-039 静态扫描按注册处求值
  for (const base of [QUESTIONNAIRES, TEMPLATES]) {
    const template = base === TEMPLATES;
    module.get(base, (c) =>
      read(c, deps, VIEW, async (tx) => ({
        items: (
          await tx
            .select()
            .from(survey360Questionnaires)
            .where(and(eq(survey360Questionnaires.deleted, false), eq(survey360Questionnaires.template, template)))
            .orderBy(survey360Questionnaires.createdAt)
            .limit(500)
        ).map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          status: r.status,
          createdBy: r.createdBy,
          revision: r.revision,
        })),
      })),
    );
    module.get(`${base}/:id`, (c) =>
      read(c, deps, VIEW, async (tx) => questionnaireView(await loadQuestionnaire(tx, uuidParam(c), false, template))),
    );
    module.post(base, (c) =>
      write(
        c,
        deps,
        createSchema,
        async (tx, ctx, input) => {
          requireNewObject(ctx);
          const [row] = await tx
            .insert(survey360Questionnaires)
            .values({
              tenantId: ctx.tenantId,
              name: input.name,
              type: input.type,
              scoreMethod: input.scoreMethod ?? 'weighted_average',
              guide: input.guide ?? null,
              excellentLinePercent: input.excellence ? String(input.excellence.linePercent) : null,
              excellentMaxRate: input.excellence ? String(input.excellence.maxRate) : null,
              template,
              createdBy: ctx.userId,
            })
            .returning();
          const loaded = await loadQuestionnaire(tx, row!.id, false, template);
          await auditQuestionnaire(tx, ctx, 'survey360.questionnaire.create', null, loaded);
          return questionnaireView(loaded);
        },
        { need: { object: 'questionnaire', operation: 'create' }, fields: 'body', status: 201 },
      ),
    );
  }
}

function registerQuestionnaireUpdate(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  for (const base of [QUESTIONNAIRES, TEMPLATES]) {
    const template = base === TEMPLATES;
    module.put(`${base}/:id`, (c) => {
      const id = uuidParam(c);
      const options = {
        need: { object: 'questionnaire', operation: 'update' },
        guard: editableBy(deps, tenantOf(c), id, false, template),
        // 整卷保存的 content 写的是角色、量表、指标、题目四个字段
        fields: ({ content, ...header }: z.infer<typeof updateSchema>) => [
          ...Object.keys(header),
          ...(content ? ['roles', 'scales', 'dimensions', 'questions'] : []),
        ],
      } as const;
      return write(
        c,
        deps,
        updateSchema,
        async (tx, ctx, input) => {
          const current = await loadQuestionnaire(tx, id, true, template);
          requireRevision(current.row.revision, ctx.expectedRevision);
          if (current.row.status === 'used' && (await enabledActivitiesUsing(tx, id)) > 0)
            fail('CONFLICT', '用到该套卷的活动处于启用状态，停用后才能修改', 'ACTIVITY_ENABLED');
          if (input.content) {
            checkReferences(input.content, current.row.type);
            if (current.row.status === 'used') await updateInPlace(tx, current, input.content);
            else await replaceContent(tx, ctx, id, input.content);
          }
          // 已使用套卷改权重 / 计分方式：用到它的活动计分组成变了，旧报告失效（第 2 轮 P2-7）
          if (current.row.status === 'used' && (input.content || input.scoreMethod !== undefined))
            await markQuestionnaireChanged(tx, id);
          await tx
            .update(survey360Questionnaires)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.scoreMethod !== undefined ? { scoreMethod: input.scoreMethod } : {}),
              ...(input.guide !== undefined ? { guide: input.guide } : {}),
              ...(input.excellence !== undefined
                ? {
                    excellentLinePercent: input.excellence ? String(input.excellence.linePercent) : null,
                    excellentMaxRate: input.excellence ? String(input.excellence.maxRate) : null,
                  }
                : {}),
              revision: current.row.revision + 1,
            })
            .where(eq(survey360Questionnaires.id, id));
          const saved = await loadQuestionnaire(tx, id, false, template);
          // 已启用 / 已使用的套卷修改后仍须满足启用条件
          if (saved.row.status !== 'draft') issuesFail(survey360.validateQuestionnaire(saved.model));
          await auditQuestionnaire(tx, ctx, 'survey360.questionnaire.update', questionnaireView(current), saved);
          return questionnaireView(saved);
        },
        options,
      );
    });
  }
}

function registerQuestionnaireEnable(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.post('/questionnaires/:id/enable', (c) => {
    const id = uuidParam(c);
    return write(
      c,
      deps,
      z.object({}).passthrough(),
      async (tx, ctx) => {
        const current = await loadQuestionnaire(tx, id, true);
        requireRevision(current.row.revision, ctx.expectedRevision);
        if (current.row.status !== 'draft') fail('CONFLICT', '只有草稿套卷可以启用', 'NOT_DRAFT');
        issuesFail(survey360.validateQuestionnaire(current.model));
        await tx
          .update(survey360Questionnaires)
          .set({ status: 'enabled', revision: current.row.revision + 1 })
          .where(eq(survey360Questionnaires.id, id));
        const saved = await loadQuestionnaire(tx, id);
        await auditQuestionnaire(tx, ctx, 'survey360.questionnaire.enable', questionnaireView(current), saved);
        return questionnaireView(saved);
      },
      {
        need: { object: 'questionnaire', operation: 'update', button: 'enable' },
        fields: 'none', // 状态流转，不写套卷字段
        guard: editableBy(deps, tenantOf(c), id),
      },
    );
  });
}

function registerQuestionnaireDelete(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  for (const base of [QUESTIONNAIRES, TEMPLATES]) {
    const template = base === TEMPLATES;
    module.delete(`${base}/:id`, (c) => {
      const id = uuidParam(c);
      return write(
        c,
        deps,
        z.object({}).passthrough(),
        async (tx, ctx) => {
          const current = await loadQuestionnaire(tx, id, true, template);
          requireRevision(current.row.revision, ctx.expectedRevision);
          // E3-R2 / AC-360-09：已使用的套卷不可删除
          if (current.row.status === 'used') fail('CONFLICT', '已使用的套卷不能删除', 'QUESTIONNAIRE_USED');
          const [ref] = rows<{ n: number }>(
            await tx.execute(sql`SELECT count(*)::int AS n FROM survey360_object_questionnaires oq
            JOIN survey360_objects o ON o.tenant_id = oq.tenant_id AND o.id = oq.object_id AND NOT o.removed
            WHERE oq.questionnaire_id = ${id}::uuid`),
          );
          if (ref!.n > 0) fail('CONFLICT', '套卷已被评价对象引用，不能删除', 'QUESTIONNAIRE_REFERENCED');
          await tx
            .update(survey360Questionnaires)
            .set({ deleted: true, revision: current.row.revision + 1 })
            .where(eq(survey360Questionnaires.id, id));
          await audit360(tx, actor(ctx), {
            action: 'survey360.questionnaire.delete',
            objectType: 'survey360-questionnaire',
            objectId: id,
            before: questionnaireView(current),
            after: { id, deleted: true },
          });
          return { id, deleted: true };
        },
        {
          need: { object: 'questionnaire', operation: 'delete' },
          fields: 'none',
          guard: editableBy(deps, tenantOf(c), id, true, template),
        },
      );
    });
  }
}

/** 已保存内容转回整卷提交的结构（按稳定键），用于复制。 */
function contentOf(q: LoadedQuestionnaire): Content {
  const keyOf = <T extends { id: string; key: string }>(list: readonly T[], id: string | null) =>
    id === null ? null : (list.find((x) => x.id === id)?.key ?? null);
  return {
    roles: q.roles.map((r) => ({ key: r.key, roleId: r.roleId, weight: r.weight })),
    scales: q.scales.map((s) => ({
      key: s.key,
      name: s.name,
      options: q.options
        .filter((o) => o.scaleId === s.id)
        .map((o) => ({
          key: o.key,
          label: o.label,
          value: o.value,
          notScored: o.notScored,
          remarkRequired: o.remarkRequired,
        })),
    })),
    dimensions: q.dimensions.map((d) => ({
      key: d.key,
      parentKey: keyOf(q.dimensions, d.parentId),
      name: d.name,
      definition: d.definition,
      weight: d.weight,
      scaleKey: keyOf(q.scales, d.scaleId),
      roleIds: d.roleIds,
    })),
    questions: q.questions.map((x) => ({
      key: x.key,
      dimensionKey: keyOf(q.dimensions, x.dimensionId)!,
      text: x.text,
      weight: x.weight,
      scaleKey: keyOf(q.scales, x.scaleId)!,
      allowRemark: x.allowRemark,
      roleIds: x.roleIds,
    })),
  };
}

/** 复制一份（E3-R10 引用即复制）：新对象为草稿，由操作人创建。 */
async function copyOf(tx: Tx, ctx: Survey360Context, source: LoadedQuestionnaire, name: string, template: boolean) {
  const [row] = await tx
    .insert(survey360Questionnaires)
    .values({
      tenantId: ctx.tenantId,
      name,
      type: source.row.type,
      scoreMethod: source.row.scoreMethod,
      guide: source.row.guide,
      excellentLinePercent: source.row.excellentLinePercent,
      excellentMaxRate: source.row.excellentMaxRate,
      template,
      createdBy: ctx.userId,
    })
    .returning();
  await replaceContent(tx, ctx, row!.id, contentOf(source));
  const loaded = await loadQuestionnaire(tx, row!.id, false, template);
  await auditQuestionnaire(
    tx,
    ctx,
    `survey360.questionnaire.${template ? 'save_as_template' : 'from_template'}`,
    null,
    loaded,
  );
  return questionnaireView(loaded);
}

function registerTemplateCopies(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // 路径写成字面量数组：F-039 静态扫描按注册处求值
  for (const path of [SAVE_AS_TEMPLATE, INSTANTIATE]) {
    const fromTemplate = path === INSTANTIATE;
    module.post(path, (c) => {
      const id = uuidParam(c);
      return write(
        c,
        deps,
        z.strictObject({ name: text(200) }),
        async (tx, ctx, input) => {
          requireNewObject(ctx);
          return copyOf(tx, ctx, await loadQuestionnaire(tx, id, false, fromTemplate), input.name, !fromTemplate);
        },
        {
          need: { object: 'questionnaire', operation: 'create' },
          // 复制写入的是整套套卷字段
          fields: () => [
            'name',
            'type',
            'scoreMethod',
            'guide',
            'excellence',
            'roles',
            'scales',
            'dimensions',
            'questions',
          ],
          status: 201,
          guard: async (tx) => void (await loadQuestionnaire(tx, id, false, fromTemplate)),
        },
      );
    });
  }
}

/** 活动启用时把用到的套卷标为已使用（E3-R2）。 */
export async function markUsed(tx: Tx, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await tx
    .update(survey360Questionnaires)
    .set({ status: 'used', revision: sql`${survey360Questionnaires.revision} + 1` })
    .where(and(inArray(survey360Questionnaires.id, [...ids]), eq(survey360Questionnaires.status, 'enabled')));
}
