/**
 * 个人报告、报告模板与报告转发（`25` §10.1、§10.3 ⑬⑭⑮；DEC-149；DEC-262②）：
 * - 报告模板首版只有标准版一个（按需补齐），只有“文本答案中是否呈现评价角色”一个开关；
 * - “生成 / 更新报告”：活动停用并计分后，2 小时一次；作答数据在计分后有变化（清除作答、屏蔽）时拦截，须启用 → 停用；
 *   同步生成内容快照（原站异步约 3 分钟，🟡），并写评价对象的报告生成时间（Lastest360Cent 据此计入）；
 * - 查看：数据变化后已生成的报告被拦（原站文案），列表行仍在；
 * - 转发：按汇报关系（本人 / 直线上级 / 虚线上级，取组织员工当前任职记录）、按评价关系角色、其他人（姓名 + 邮箱）；
 *   预览给报告数、收件人数、无法转发数（尚未生成或找不到收件人），最多 3000 行；每位收件人一封邮件，发链接不发附件，
 *   收件人凭链接只看邮件里的报告。精细化下只转发范围内评价对象的报告，系统内收件人也须在范围内（不暴露范围外人员的
 *   邮箱）。
 */
import { randomBytes } from 'node:crypto';
import {
  getTenant,
  isUuid,
  sql,
  survey360ReportLinks,
  survey360Outbox,
  survey360ReportTemplates,
  type Tx,
  withTenant,
  eq,
  and,
} from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { handleError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantContext, type TenantEnv, tenantOf } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { type ActivityRow, iso, requireActivity } from './access.js';
import { LINK_TOKEN_HEADER } from './answering.js';
import { admitted, attachmentName, fileResponse, renderPdf, type ReportBody, reportDocument } from './export-files.js';
import {
  actor,
  type Admin,
  asIs,
  audit360,
  type C,
  email,
  fail,
  jsonOrEmpty,
  mapDbError,
  OBJECTS,
  parse,
  read,
  requireRevision,
  rows,
  type Survey360Context,
  text,
  trimAliases,
  trimBody,
  type Present,
  uuid,
  write,
} from './context.js';
import { hashToken } from './links.js';
import { personFilter, visiblePersonIds } from './people.js';
import { buildReport } from './report-content.js';
import { scoringChanged } from './changes.js';
import { SURVEY360_REPORT_LINK_POLICIES } from './policy.js';
import { policedSub } from '../../route-policy/index.js';
import { currentManager } from './sync.js';

export const DATA_CHANGED = '数据发生变化,请启用-停用活动后再生成/更新报告！';
const REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const STANDARD = 'standard';
const PREVIEW_LIMIT = 3000;

type TemplateRow = typeof survey360ReportTemplates.$inferSelect;

/** 标准版报告模板（每租户一个，按需补齐）。 */
export async function standardTemplate(tx: Tx, tenantId: string): Promise<TemplateRow> {
  await tx.insert(survey360ReportTemplates).values({ tenantId, code: STANDARD, name: '标准版' }).onConflictDoNothing();
  const [row] = await tx.select().from(survey360ReportTemplates).where(eq(survey360ReportTemplates.code, STANDARD));
  return row!;
}

const templateView = (row: TemplateRow) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  showTextRole: row.showTextRole,
  revision: row.revision,
});

interface ObjectRow {
  id: string;
  person_id: string;
  employee_id: string | null;
  name: string;
  email: string;
  department: string | null;
  position: string | null;
  report_id: string | null;
  report_batch_id: string | null;
  generated_at: Date | string | null;
}

/** 查看人范围内、未移除的评价对象，带标准版报告。 */
async function visibleObjects(tx: Tx, activityId: string, admin: Admin, templateId: string, objectIds?: string[]) {
  const filter = personFilter(admin, sql`p`);
  return rows<ObjectRow>(
    await tx.execute(sql`SELECT o.id, o.person_id, p.employee_id, p.name, p.email, p.department, p.position,
        rp.id AS report_id, rp.batch_id AS report_batch_id, rp.generated_at
      FROM survey360_objects o JOIN survey360_people p ON p.tenant_id = o.tenant_id AND p.id = o.person_id
      LEFT JOIN survey360_reports rp ON rp.tenant_id = o.tenant_id AND rp.object_id = o.id
        AND rp.template_id = ${templateId}::uuid
      WHERE o.activity_id = ${activityId}::uuid AND NOT o.removed ${filter ? sql`AND ${filter}` : sql``}
        ${objectIds ? sql`AND o.id = ANY(${`{${objectIds.join(',')}}`}::uuid[])` : sql``}
      ORDER BY o.sort, o.created_at, o.id`),
  );
}

/** 活动当前的报告有效性：计分组成是否在计分后变化，以及当前计分批次。 */
interface Validity {
  readonly changed: boolean;
  readonly batchId: string | null;
}

async function validity(tx: Tx, activity: ActivityRow): Promise<Validity> {
  return { changed: await scoringChanged(tx, activity), batchId: activity.score_batch_id };
}

/** 报告仍有效：计分后计分组成没变，且快照出自活动当前的计分批次（重算不让旧批次的报告复活，第 2 轮 P2-7）。 */
function current(v: Validity, batchId: string | null) {
  return !v.changed && batchId !== null && batchId === v.batchId;
}

function statusOf(v: Validity, object: ObjectRow) {
  if (!object.report_id) return 'not_generated';
  return current(v, object.report_batch_id) ? 'generated' : 'outdated';
}

function rowView(v: Validity, template: TemplateRow, object: ObjectRow) {
  return {
    id: object.report_id,
    objectId: object.id,
    objectName: object.name,
    department: object.department,
    position: object.position,
    template: { id: template.id, name: template.name },
    status: statusOf(v, object),
    generatedAt: iso(object.generated_at),
  };
}

interface ReportRow {
  id: string;
  object_id: string;
  batch_id: string;
  content: object;
  generated_at: Date | string;
}

/** 评价对象已移除的报告与不存在同一 404（第 2 轮 P2-8：收件人链接也一样）。 */
async function reportView(tx: Tx, activity: ActivityRow, reportId: string) {
  const [report] = rows<ReportRow>(
    await tx.execute(sql`SELECT rp.id, rp.object_id, rp.batch_id, rp.content, rp.generated_at FROM survey360_reports rp
      JOIN survey360_objects o ON o.tenant_id = rp.tenant_id AND o.id = rp.object_id AND NOT o.removed
      WHERE rp.id = ${reportId}::uuid AND rp.activity_id = ${activity.id}::uuid`),
  );
  if (!report) fail('NOT_FOUND', '报告不存在');
  if (!current(await validity(tx, activity), report.batch_id)) fail('CONFLICT', DATA_CHANGED, 'DATA_CHANGED');
  return { id: report.id, objectId: report.object_id, generatedAt: iso(report.generated_at), ...report.content };
}

async function generate(tx: Tx, ctx: Survey360Context, activity: ActivityRow, objectIds?: string[]) {
  if (activity.status !== 'disabled' || !activity.score_batch_id)
    fail('CONFLICT', '活动停用后才能生成报告', 'ACTIVITY_NOT_DISABLED');
  if (await scoringChanged(tx, activity)) fail('CONFLICT', DATA_CHANGED, 'DATA_CHANGED');
  const last = activity.reports_requested_at ? new Date(activity.reports_requested_at).getTime() : null;
  if (last !== null && ctx.now.getTime() - last < REPORT_INTERVAL_MS)
    fail('CONFLICT', '生成活动下所有报告120分钟后才可以重新生成报告！', 'RATE_LIMITED');
  const template = await standardTemplate(tx, ctx.tenantId);
  const objects = await visibleObjects(tx, activity.id, ctx.admin, template.id, objectIds);
  for (const object of objects) {
    const content = await buildReport(
      tx,
      {
        activityId: activity.id,
        activityName: activity.name,
        objectId: object.id,
        objectName: object.name,
        department: object.department,
        position: object.position,
      },
      { name: template.name, showTextRole: template.showTextRole },
      activity.score_batch_id!,
      ctx.now,
    );
    const now = ctx.now.toISOString();
    const [saved] = rows<{ id: string }>(
      await tx.execute(sql`INSERT INTO survey360_reports
          (tenant_id, activity_id, object_id, template_id, batch_id, content, generated_at)
        VALUES (${ctx.tenantId}::uuid, ${activity.id}::uuid, ${object.id}::uuid, ${template.id}::uuid,
          ${activity.score_batch_id}::uuid, ${JSON.stringify(content)}::jsonb, ${now}::timestamptz)
        ON CONFLICT (object_id, template_id) DO UPDATE SET batch_id = EXCLUDED.batch_id, content = EXCLUDED.content,
          generated_at = EXCLUDED.generated_at, revision = survey360_reports.revision + 1
        RETURNING id`),
    );
    await tx.execute(sql`UPDATE survey360_objects SET report_generated_at = ${now}::timestamptz
      WHERE id = ${object.id}::uuid`);
    await audit360(tx, actor(ctx), {
      action: 'survey360.report.generate',
      objectType: 'survey360-report',
      objectId: saved!.id,
      before: null,
      // 审计详情只用结果对象的字段名（template / generatedAt），按查看人字段权限裁剪（第 2 轮 P2-6）
      after: { activityId: activity.id, objectId: object.id, template: template.id, generatedAt: now },
    });
  }
  await tx.execute(sql`UPDATE survey360_activities SET reports_requested_at = ${ctx.now.toISOString()}::timestamptz
    WHERE id = ${activity.id}::uuid`);
  return { generated: objects.length };
}

const forwardSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('reporting'),
    targets: z.array(z.enum(['self', 'direct', 'dotted'])).min(1),
    objectIds: z.array(uuid).min(1).max(2000).optional(),
  }),
  z.strictObject({
    mode: z.literal('relation'),
    roleIds: z.array(uuid).min(1).max(90),
    objectIds: z.array(uuid).min(1).max(2000).optional(),
  }),
  z.strictObject({
    mode: z.literal('others'),
    others: z
      .array(z.strictObject({ name: text(100), email }))
      .min(1)
      .max(200),
    objectIds: z.array(uuid).min(1).max(2000).optional(),
  }),
]);
type Forward = z.infer<typeof forwardSchema>;

interface Recipient {
  readonly personId: string | null;
  readonly name: string;
  readonly email: string;
  readonly relation: string;
}

async function managerOf(tx: Tx, tenant: TenantContext, now: Date, employeeId: string, column: 'direct' | 'dotted') {
  const manager = currentManager(
    tenant.tenantId,
    sql`${employeeId}::uuid`,
    tenantLocalDate(now, tenant.timezone),
    column === 'direct' ? 'direct_manager_id' : 'dotted_manager_id',
  );
  const [row] = rows<{ id: string; name: string; email: string }>(
    await tx.execute(sql`SELECT p.id, p.name, p.email FROM (${manager}) cur
      JOIN survey360_people p ON p.employee_id = cur.manager_id WHERE cur.manager_id IS NOT NULL LIMIT 1`),
  );
  return row;
}

async function recipientsOf(
  tx: Tx,
  tenant: TenantContext,
  now: Date,
  input: Forward,
  object: ObjectRow,
): Promise<Recipient[]> {
  if (input.mode === 'others') return input.others.map((o) => ({ personId: null, ...o, relation: 'others' }));
  if (input.mode === 'relation') {
    const found = rows<{ id: string; name: string; email: string; role_name: string }>(
      await tx.execute(sql`SELECT p.id, p.name, p.email, ro.name AS role_name FROM survey360_relations r
        JOIN survey360_people p ON p.tenant_id = r.tenant_id AND p.id = r.appraiser_person_id
        JOIN survey360_roles ro ON ro.tenant_id = r.tenant_id AND ro.id = r.role_id
        WHERE r.object_id = ${object.id}::uuid AND NOT r.removed
          AND r.role_id = ANY(${`{${input.roleIds.join(',')}}`}::uuid[]) ORDER BY ro.sort, p.name, p.id`),
    );
    return found.map((p) => ({ personId: p.id, name: p.name, email: p.email, relation: p.role_name }));
  }
  const result: Recipient[] = [];
  for (const target of input.targets) {
    if (target === 'self') {
      result.push({ personId: object.person_id, name: object.name, email: object.email, relation: 'self' });
      continue;
    }
    if (!object.employee_id) continue;
    const manager = await managerOf(tx, tenant, now, object.employee_id, target);
    if (manager) result.push({ personId: manager.id, name: manager.name, email: manager.email, relation: target });
  }
  return result;
}

async function forwardPlan(
  tx: Tx,
  tenant: TenantContext,
  admin: Admin,
  now: Date,
  activity: ActivityRow,
  input: Forward,
) {
  const template = await standardTemplate(tx, tenant.tenantId);
  const v = await validity(tx, activity);
  const items: {
    reportId: string;
    objectName: string;
    department: string | null;
    position: string | null;
    template: string;
    status: string;
    recipientName: string;
    recipientEmail: string;
    relation: string;
  }[] = [];
  const mail = new Map<string, { name: string; reportIds: Set<string> }>();
  let unresolved = 0;
  let reports = 0;
  for (const object of await visibleObjects(tx, activity.id, admin, template.id, input.objectIds)) {
    const ready = object.report_id && current(v, object.report_batch_id);
    let recipients = ready ? await recipientsOf(tx, tenant, now, input, object) : [];
    // 精细化下系统内收件人也须在范围内：不暴露范围外人员的邮箱
    const people = recipients.filter((r) => r.personId).map((r) => r.personId!);
    const visible = admin.people ? await visiblePersonIds(tx, admin, people) : null;
    if (visible) recipients = recipients.filter((r) => !r.personId || visible.has(r.personId));
    if (!recipients.length) {
      unresolved += 1;
      continue;
    }
    reports += 1;
    for (const r of recipients) {
      const key = r.email.toLowerCase();
      const entry = mail.get(key) ?? { name: r.name, reportIds: new Set<string>() };
      entry.reportIds.add(object.report_id!);
      mail.set(key, entry);
      items.push({
        reportId: object.report_id!,
        objectName: object.name,
        department: object.department,
        position: object.position,
        template: template.name,
        status: statusOf(v, object),
        recipientName: r.name,
        recipientEmail: r.email,
        relation: r.relation,
      });
    }
  }
  return { reportCount: reports, recipientCount: mail.size, unresolvedReports: unresolved, items, mail };
}

async function sendForward(tx: Tx, ctx: Survey360Context, activity: ActivityRow, input: Forward) {
  const plan = await forwardPlan(tx, ctx, ctx.admin, ctx.now, activity, input);
  for (const [address, entry] of plan.mail) {
    const token = randomBytes(32).toString('base64url');
    const reportIds = [...entry.reportIds].sort();
    await tx.insert(survey360ReportLinks).values({
      tenantId: ctx.tenantId,
      activityId: activity.id,
      recipientName: entry.name,
      recipientEmail: address,
      reportIds,
      tokenHash: hashToken(token),
      commandId: ctx.commandId,
      createdBy: ctx.userId,
    });
    await tx.insert(survey360Outbox).values({
      tenantId: ctx.tenantId,
      eventType: 'survey360.report_forward',
      objectId: activity.id,
      commandId: ctx.commandId,
      payload: {
        channel: 'email',
        activityId: activity.id,
        to: address,
        name: entry.name,
        subject: '请下载报告',
        reportIds,
        token,
      },
    });
  }
  const receipt = {
    reportCount: plan.reportCount,
    recipientCount: plan.recipientCount,
    unresolvedReports: plan.unresolvedReports,
  };
  await audit360(tx, actor(ctx), {
    action: 'survey360.report.forward',
    objectType: 'survey360-report',
    objectId: activity.id,
    before: null,
    // 收件人邮箱记在结果对象的 recipientEmail 字段下，看不到该字段的审计查看人看不到（第 2 轮 P2-6）
    after: { activityId: activity.id, relation: input.mode, ...receipt, recipientEmail: [...plan.mail.keys()].sort() },
  });
  return receipt;
}

const VIEW = { object: 'result' } as const;

/**
 * 报告快照的嵌套键 → 结果对象字段（第 2 轮 P2-4）：分数的各种表示（自评 / 他评 / 差值 / 概况值 / 参照标准）都归
 * score，评价关系表的完成 / 邀请人数与完成率归 raterCount；指标 / 题目的名称、定义与编号归 itemName / itemId，
 * 模板名归 template；看不到该字段时任何层级都去掉。
 */
export const REPORT_ALIASES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['score', 'self', 'other', 'gap', 'value', 'reference'].map((k) => [k, 'score'])),
  ...Object.fromEntries(['completed', 'invited', 'rate'].map((k) => [k, 'raterCount'])),
  ...Object.fromEntries(['name', 'question', 'definition', 'highest', 'lowest'].map((k) => [k, 'itemName'])),
  dimensionId: 'itemId',
  templateName: 'template',
  ...Object.fromEntries(
    [
      'roleId',
      'roleName',
      'objectName',
      'department',
      'position',
      'generatedAt',
      'questionnaireId',
      'itemId',
      'level',
      'scope',
    ].map((k) => [k, k]),
  ),
};

/** 套卷一层的 name 是套卷名（questionnaireName），其下各层的 name 才是指标 / 题目名。 */
function trimReport(fields: ReadonlySet<string> | undefined, body: unknown): unknown {
  const top = trimBody(fields, body) as { questionnaires?: unknown };
  if (fields === undefined || !Array.isArray(top.questionnaires)) return trimAliases(fields, top, REPORT_ALIASES);
  const questionnaires = top.questionnaires.map(({ name, ...rest }: Record<string, unknown>) => ({
    ...(fields.has('questionnaireName') ? { name } : {}),
    ...(trimAliases(fields, rest, REPORT_ALIASES) as object),
  }));
  return { ...(trimAliases(fields, { ...top, questionnaires: [] }, REPORT_ALIASES) as object), questionnaires };
}

/**
 * 报告内容按结果字段裁剪；封面里的活动名称来自 Activity.name，隐藏该字段的查看人同样拿不到（F-060 第 2 轮 P2-1，
 * 详情接口与 PDF 下载同一处）。
 */
const reportPresent: Present = async (viewer, body: unknown) => {
  const trimmed = trimReport(await viewer.fields('result'), body) as { cover?: Record<string, unknown> };
  const activityFields = await viewer.fields('activity');
  if (!trimmed.cover || !activityFields || activityFields.has('name')) return trimmed;
  const { activityName: _hidden, ...cover } = trimmed.cover;
  return { ...trimmed, cover };
};

/**
 * 报告详情（已按查看人裁剪）→ PDF 附件；文件名是评价对象姓名，被裁掉时用通用名。经应用层并发准入与超时（tenantKey 只用于
 * 计数）。
 */
async function reportPdf(tenantKey: string, report: ReportBody): Promise<Response> {
  const pdf = await admitted(tenantKey, () => renderPdf(reportDocument(report)));
  const subject = report.cover?.objectName;
  return fileResponse(pdf, 'application/pdf', attachmentName(`${subject ? `${subject}-` : ''}个人报告`, 'pdf'));
}

/**
 * 转发让收件人看到整份报告：发送人须能看到报告正文涉及的全部结果字段，以及封面里活动名称的来源 Activity.name，
 * 否则 403（第 2 轮 P2-5；F-060 第 3 轮 P2-R2-1：收件人报告不按发送人裁剪，转发给自己就能读回被隐藏的名称）。
 * 预览与执行同一处检查。
 */
const REPORT_FIELDS = [
  'cover',
  'questionnaires',
  'statement',
  'questionnaireName',
  ...new Set(Object.values(REPORT_ALIASES)),
];
async function requireFullReportView(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext) {
  const fields = await getModuleViewableFieldsInTransaction(deps, tenant, OBJECTS.result.code, tx);
  const activityFields = await getModuleViewableFieldsInTransaction(deps, tenant, OBJECTS.activity.code, tx);
  const restricted =
    (fields && REPORT_FIELDS.some((f) => !fields.has(f))) || (activityFields && !activityFields.has('name'));
  if (restricted) fail('FORBIDDEN', '对报告内容没有完整的查看权限，不能转发', 'REPORT_FIELDS_RESTRICTED');
}

/** 报告详情与 PDF 下载：同一个 detail（权限、范围、报告失效拦截都在这里），只是响应格式不同。 */
function registerReportViewRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  const detail = async (c: C, tx: Tx, admin: Admin, tenant: TenantContext) => {
    const activity = await requireActivity(tx, admin, uuidParam(c));
    const template = await standardTemplate(tx, tenant.tenantId);
    const reportId = uuidParam(c, 'reportId');
    // 评价对象须在查看人范围内：范围外的与不存在同一 404
    if (!(await visibleObjects(tx, activity.id, admin, template.id)).some((o) => o.report_id === reportId))
      fail('NOT_FOUND', '报告不存在');
    return reportView(tx, activity, reportId);
  };
  module.get('/activities/:id/reports/:reportId', (c) =>
    read(c, deps, VIEW, (tx, admin, tenant) => detail(c, tx, admin, tenant), reportPresent),
  );
  // 个人报告“下载”是 PDF（`25` §10.3 ⑬⑭）：与详情接口同一权限、同一范围与字段裁剪，文件由同一份数据生成
  module.get('/activities/:id/reports/:reportId/download', (c) =>
    read(
      c,
      deps,
      VIEW,
      (tx, admin, tenant) => detail(c, tx, admin, tenant),
      reportPresent,
      (cc, report) => reportPdf(tenantOf(cc).tenantId, report),
    ),
  );
}

export function registerReportRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerTemplateRoutes(module, deps);
  registerReportViewRoutes(module, deps);
  module.get('/activities/:id/reports', (c) =>
    read(c, deps, VIEW, async (tx, admin, tenant) => {
      const activity = await requireActivity(tx, admin, uuidParam(c));
      const template = await standardTemplate(tx, tenant.tenantId);
      const objects = await visibleObjects(tx, activity.id, admin, template.id);
      const v = await validity(tx, activity);
      return { items: objects.map((o) => rowView(v, template, o)) };
    }),
  );
  // 生成 / 转发共用的命令处理函数；注册路径写字面量（F-039 静态扫描按注册处求值）
  const command =
    (
      button: string,
      schema: z.ZodType,
      run: (tx: Tx, ctx: Survey360Context, a: ActivityRow, input: never) => Promise<object>,
      fullView = false,
    ) =>
    (c: C) => {
      const id = uuidParam(c);
      return write(
        c,
        deps,
        schema,
        async (tx, ctx, input) => run(tx, ctx, await requireActivity(tx, ctx.admin, id, true), input as never),
        {
          need: { object: 'result', operation: 'update', button },
          fields: 'none',
          revisionFree: true,
          guard: async (tx, admin) => {
            await requireActivity(tx, admin, id);
            if (fullView) await requireFullReportView(tx, deps, tenantOf(c));
          },
          // 回执只有人数（协议字段）
          present: asIs,
        },
      );
    };
  module.post(
    '/activities/:id/reports/generate',
    command(
      'generateReport',
      z.strictObject({ objectIds: z.array(uuid).min(1).max(2000).optional() }),
      (tx, ctx, activity, input: { objectIds?: string[] }) => generate(tx, ctx, activity, input.objectIds),
    ),
  );
  module.post(
    '/activities/:id/reports/forward',
    command(
      'forwardReport',
      forwardSchema,
      (tx, ctx, activity, input: Forward) => sendForward(tx, ctx, activity, input),
      true,
    ),
  );
  module.post('/activities/:id/reports/forward/preview', (c) =>
    read(c, deps, { ...VIEW, button: 'forwardReport' }, async (tx, admin, tenant) => {
      const activity = await requireActivity(tx, admin, uuidParam(c));
      await requireFullReportView(tx, deps, tenant);
      const input = parse(forwardSchema, await jsonOrEmpty(c));
      const { mail: _mail, items, ...counts } = await forwardPlan(tx, tenant, admin, deps.clock(), activity, input);
      return { ...counts, items: items.slice(0, PREVIEW_LIMIT) };
    }),
  );
}

function registerTemplateRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  module.get('/report-template', (c) =>
    read(c, deps, { object: 'settings' }, async (tx, _admin, tenant) =>
      templateView(await standardTemplate(tx, tenant.tenantId)),
    ),
  );
  module.put('/report-template', (c) =>
    write(
      c,
      deps,
      z.strictObject({ name: text(100).optional(), showTextRole: z.boolean().optional() }),
      async (tx, ctx, input) => {
        const current = await standardTemplate(tx, ctx.tenantId);
        requireRevision(current.revision, ctx.expectedRevision);
        const [saved] = await tx
          .update(survey360ReportTemplates)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.showTextRole !== undefined ? { showTextRole: input.showTextRole } : {}),
            revision: current.revision + 1,
          })
          .where(
            and(eq(survey360ReportTemplates.id, current.id), eq(survey360ReportTemplates.revision, current.revision)),
          )
          .returning();
        if (!saved) fail('REVISION_CONFLICT', '报告模板已被修改，请刷新后显式重提');
        await audit360(tx, actor(ctx), {
          action: 'survey360.report_template.update',
          objectType: 'survey360-settings',
          objectId: current.id,
          before: templateView(current),
          after: templateView(saved),
        });
        return templateView(saved);
      },
      { need: { object: 'settings', operation: 'update' }, fields: 'body' },
    ),
  );
}

/** 报告转发的收件人链接（/api/survey360/report-link）：不经租户成员中间件；租户、令牌无效一律 404。 */
export function registerReportLinkRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // F-039：收件人链接子应用套登记表（SURVEY360_REPORT_LINK_POLICIES）
  const module = policedSub(router, SURVEY360_REPORT_LINK_POLICIES, () => new Hono<TenantEnv>());
  module.onError((error, c) => handleError(mapDbError(error) ?? error, c));
  const resolve = async (c: C) => {
    const tenantId = c.req.header('x-tenant-id');
    const token = c.req.header(LINK_TOKEN_HEADER);
    if (!tenantId || !isUuid(tenantId) || !token || token.length > 200) fail('NOT_FOUND', '链接无效或已失效');
    const tenant = await getTenant(deps.db, tenantId!);
    if (!tenant || tenant.status !== 'active') fail('NOT_FOUND', '链接无效或已失效');
    return { tenantId: tenant!.id, hash: hashToken(token!) };
  };
  const linkOf = async (tx: Tx, hash: string) => {
    const [link] = await tx.select().from(survey360ReportLinks).where(eq(survey360ReportLinks.tokenHash, hash));
    if (!link) fail('NOT_FOUND', '链接无效或已失效');
    const [activity] = rows<ActivityRow>(
      await tx.execute(sql`SELECT * FROM survey360_activities WHERE id = ${link!.activityId}::uuid AND NOT deleted`),
    );
    if (!activity) fail('NOT_FOUND', '链接无效或已失效');
    return { link: link!, activity: activity! };
  };
  module.get('/', async (c) => {
    const { tenantId, hash } = await resolve(c);
    const body = await withTenant(deps.db, tenantId, async (tx) => {
      const { link } = await linkOf(tx, hash);
      const reports = link.reportIds.length
        ? rows<{ id: string; object_name: string; template_name: string }>(
            await tx.execute(sql`SELECT rp.id, p.name AS object_name, t.name AS template_name FROM survey360_reports rp
              JOIN survey360_objects o ON o.tenant_id = rp.tenant_id AND o.id = rp.object_id AND NOT o.removed
              JOIN survey360_people p ON p.tenant_id = o.tenant_id AND p.id = o.person_id
              JOIN survey360_report_templates t ON t.tenant_id = rp.tenant_id AND t.id = rp.template_id
              WHERE rp.id = ANY(${`{${link.reportIds.join(',')}}`}::uuid[]) ORDER BY o.sort, o.created_at, rp.id`),
          )
        : [];
      return { reports: reports.map((r) => ({ id: r.id, objectName: r.object_name, templateName: r.template_name })) };
    });
    return c.json(body);
  });
  const linked = async (c: C) => {
    const { tenantId, hash } = await resolve(c);
    const reportId = uuidParam(c, 'reportId');
    const report = await withTenant(deps.db, tenantId, async (tx) => {
      const { link, activity } = await linkOf(tx, hash);
      if (!link.reportIds.includes(reportId)) fail('NOT_FOUND', '报告不存在');
      return reportView(tx, activity, reportId);
    });
    return { tenantId, report };
  };
  module.get('/reports/:reportId', async (c) => c.json((await linked(c)).report));
  // 收件人下载 PDF：与上面同一份报告内容（邮件里发的是链接，不发附件）
  module.get('/reports/:reportId/download', async (c) => {
    const { tenantId, report } = await linked(c);
    return reportPdf(tenantId, report as never);
  });
  router.route('/api/survey360/report-link', module);
}
