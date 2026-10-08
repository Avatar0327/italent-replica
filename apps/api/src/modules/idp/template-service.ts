/**
 * 发展计划模板的写入（docs/02_业务建模/28 IDP-R6 / R7 / R9 / R10 / R12；Q-M0-115④；DEC-296④；口径 K-23～K-28）。
 * 模块、按节点配置的按钮、通用目标都是模板的组成部分：写入带模板的 revision（If-Match），成功后模板 revision + 1。
 */
import {
  and,
  eq,
  idpProcesses,
  idpTemplateCommonGoals,
  idpTemplateModules,
  idpTemplateNodeSettings,
  idpTemplates,
  sql,
  type Tx,
} from '@italent/db';
import {
  EDITABLE_AFTER_REFERENCED,
  KEY_INFO_SOURCES,
  type ModuleType,
  nodeButtonsOf,
  SINGLETON_MODULES,
  TEMPLATE_MODULE_FIELDS,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import {
  type Projection,
  requireCreatable,
  requireEditable,
  requireNestedWrite,
  requireReadable,
  requireViewable,
  rowsOf,
} from './access.js';
import type { TenantRouteDeps } from '../../routes.js';
import type {
  CommonGoalCreate,
  CommonGoalPatch,
  ModuleCreate,
  ModulePatch,
  NodeSettingInput,
  TemplateCopy,
  TemplateCreate,
  TemplatePatch,
} from './input.js';
import {
  loadCommonGoals,
  loadModuleRows,
  loadNodeSettings,
  loadTemplate,
  moduleView,
  type TemplateView,
} from './read-model.js';
import { templateReferencedByPlans } from './references.js';
import {
  audit,
  bumped,
  conflict,
  created,
  invalid,
  requireOrg,
  requireRevision,
  unique,
  type WriteContext,
} from './write-support.js';

type ModuleRow = typeof idpTemplateModules.$inferSelect;
type Deps = Pick<TenantRouteDeps, 'authorize'>;
type TemplateRow = typeof idpTemplates.$inferSelect;

const NAME_TAKEN = ['IDP_TEMPLATE_NAME_TAKEN', '模板名称已存在'] as const;

const templateRecord = (view: TemplateView) => {
  const { modules: _modules, commonGoals: _goals, referenced: _referenced, ...record } = view;
  return record;
};

/** 模板行锁 → 存在 → 可编辑（范围外 404，仅向下公开可见 403）→ revision。 */
async function lockTemplate(tx: Tx, ctx: WriteContext, id: string): Promise<TemplateRow> {
  const T = idpTemplates;
  const [row] = await tx
    .select()
    .from(T)
    .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', '发展计划模板不存在');
  await requireEditable(tx, ctx, ctx.scope, 'template', row);
  requireRevision(ctx, row.revision, '发展计划模板');
  return row;
}

/**
 * 模板引用的流程：共享锁（与流程的修改 / 删除串行）→ 存在且对操作人可见（自有或向下公开，范围外 404）→ 启用
 * （IDP-R6 只能选启用的流程，409）。流程的范围按流程对象解析（processScope）。
 */
async function requireUsableProcess(
  tx: Tx,
  ctx: WriteContext,
  processScope: WriteContext['scope'] | undefined,
  id: string,
) {
  if (!processScope) throw new Error('未解析发展计划流程的引用范围');
  const P = idpProcesses;
  const [row] = await tx
    .select()
    .from(P)
    .where(and(eq(P.tenantId, ctx.tenantId), eq(P.id, id)))
    .for('share');
  if (!row) throw new AppError('NOT_FOUND', '发展计划流程不存在');
  await requireReadable(tx, ctx, processScope, 'process', row);
  if (!row.enabled) conflict('IDP_PROCESS_DISABLED', '只能选择启用的发展计划流程');
  return row;
}

async function referenced(tx: Tx, ctx: WriteContext, templateId: string): Promise<boolean> {
  return templateReferencedByPlans(tx, ctx.tenantId, templateId);
}

async function finish(tx: Tx, ctx: WriteContext, id: string): Promise<TemplateView> {
  const T = idpTemplates;
  await tx
    .update(T)
    .set(bumped(ctx))
    .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)));
  return (await loadTemplate(tx, ctx.tenantId, id))!;
}

async function nextOrder(
  tx: Tx,
  ctx: WriteContext,
  table: 'idp_template_modules' | 'idp_template_common_goals',
  templateId: string,
) {
  const [row] = rowsOf<{ next: number }>(
    await tx.execute(sql`SELECT COALESCE(MAX(display_order), 0) + 1 AS next FROM ${sql.identifier(table)}
      WHERE tenant_id = ${ctx.tenantId} AND template_id = ${templateId}::uuid`),
  );
  return Number(row?.next ?? 1);
}

// ---- 模板 ----

/** 被引用流程的范围（按流程对象独立解析）；只在要校验引用的流程时提供。 */
export interface TemplateScopes {
  readonly process?: WriteContext['scope'] | undefined;
}

export async function createTemplate(tx: Tx, ctx: WriteContext, scopes: TemplateScopes, input: TemplateCreate) {
  requireCreatable(ctx.scope, 'template', input.orgId);
  await requireOrg(tx, ctx.tenantId, input.orgId);
  await requireUsableProcess(tx, ctx, scopes.process, input.processId);
  const [row] = await unique(
    () =>
      tx
        .insert(idpTemplates)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? null,
          orgId: input.orgId,
          publicDown: input.publicDown,
          processId: input.processId,
          ...created(ctx),
          updatedAt: ctx.now,
        })
        .returning({ id: idpTemplates.id }),
    ...NAME_TAKEN,
  );
  const id = row!.id;
  // IDP-R7：基本信息模块固定、不可删
  await tx.insert(idpTemplateModules).values({
    tenantId: ctx.tenantId,
    templateId: id,
    moduleType: 'basic',
    name: '基本信息',
    displayOrder: 1,
    ...created(ctx),
  });
  return auditCreated(tx, ctx, id);
}

async function auditCreated(tx: Tx, ctx: WriteContext, id: string) {
  const after = (await loadTemplate(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'template', 'create', id, { before: null, after: templateRecord(after), orgId: after.orgId });
  for (const module of after.modules) {
    await audit(tx, ctx, 'templateModule', 'create', module.id, { before: null, after: module, orgId: after.orgId });
  }
  for (const goal of after.commonGoals) {
    await audit(tx, ctx, 'commonGoal', 'create', goal.id, { before: null, after: goal, orgId: after.orgId });
  }
  return after;
}

export async function updateTemplate(
  tx: Tx,
  ctx: WriteContext,
  scopes: TemplateScopes,
  id: string,
  patch: TemplatePatch,
) {
  const row = await lockTemplate(tx, ctx, id);
  const before = (await loadTemplate(tx, ctx.tenantId, id))!;
  if (patch.orgId !== undefined && patch.orgId !== row.orgId) {
    requireCreatable(ctx.scope, 'template', patch.orgId);
    await requireOrg(tx, ctx.tenantId, patch.orgId);
  }
  if (patch.processId !== undefined && patch.processId !== row.processId) {
    if (await referenced(tx, ctx, id)) conflict('IDP_TEMPLATE_REFERENCED', '模板已被发展计划引用，不能更换流程');
    if (before.modules.some((m) => Array.isArray(m.nodeSettings) && m.nodeSettings.length > 0)) {
      conflict('IDP_NODE_SETTINGS_EXIST', '模板已按流程节点配置了按钮，请先清除节点配置再更换流程');
    }
    await requireUsableProcess(tx, ctx, scopes.process, patch.processId);
  }
  const T = idpTemplates;
  await unique(
    () =>
      tx
        .update(T)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.orgId === undefined ? {} : { orgId: patch.orgId }),
          ...(patch.publicDown === undefined ? {} : { publicDown: patch.publicDown }),
          ...(patch.processId === undefined ? {} : { processId: patch.processId }),
          ...bumped(ctx),
        })
        .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id))),
    ...NAME_TAKEN,
  );
  const after = (await loadTemplate(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'template', 'update', id, {
    before: templateRecord(before),
    after: templateRecord(after),
    orgId: after.orgId,
  });
  return after;
}

/** 发布 / 取消发布（🟡 K-26）：发布要求流程仍启用。 */
export async function setTemplateStatus(tx: Tx, ctx: WriteContext, id: string, status: 'draft' | 'published') {
  const row = await lockTemplate(tx, ctx, id);
  const before = (await loadTemplate(tx, ctx.tenantId, id))!;
  if (status === 'published') {
    const P = idpProcesses;
    const [process] = await tx
      .select({ enabled: P.enabled })
      .from(P)
      .where(and(eq(P.tenantId, ctx.tenantId), eq(P.id, row.processId)))
      .for('share');
    if (!process?.enabled) conflict('IDP_PROCESS_DISABLED', '模板引用的流程已停用，不能发布');
  }
  const warnings = status === 'published' ? await discardedApprovals(tx, ctx.tenantId, row.processId) : [];
  const T = idpTemplates;
  await tx
    .update(T)
    .set({ status, ...bumped(ctx) })
    .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)));
  const after = (await loadTemplate(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'template', 'update', id, {
    before: templateRecord(before),
    after: templateRecord(after),
    orgId: after.orgId,
  });
  return { ...after, warnings };
}

export interface PublishWarning {
  readonly code: 'IDP_APPROVAL_PROCESS_DISCARDED';
  readonly subProcessId: string;
}

/**
 * 审批流程废弃后（DEC-309④-3）：配置照常保存、发布照常成功，但提示哪些子流程引用的审批流程已废弃（提示不拦截）；
 * 阶段开启时失败（stage-service.openStage）。
 */
async function discardedApprovals(tx: Tx, tenantId: string, processId: string): Promise<PublishWarning[]> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT s.id FROM idp_sub_processes s
      JOIN approval_processes p ON p.tenant_id = s.tenant_id AND p.id = s.approval_process_id
      WHERE s.tenant_id = ${tenantId} AND s.process_id = ${processId}::uuid
        AND (p.status <> 'active' OR p.current_version_id IS NULL)
      ORDER BY s.seq`),
  );
  return rows.map((r) => ({ code: 'IDP_APPROVAL_PROCESS_DISCARDED', subProcessId: r.id }));
}

/**
 * 被计划引用的模板不能删除（🟡 K-25）；删除保留模板、模块、通用目标的快照。级联删除模块与通用目标须有两者的删除权
 * （DEC-309④-2，不论是否存在都要求，避免以存在性泄露隐藏内容；缺权整次 403），记入台账、重放复核。
 */
export async function deleteTemplate(tx: Tx, deps: Deps, ctx: WriteContext, id: string) {
  await lockTemplate(tx, ctx, id);
  await requireNestedWrite(tx, deps, ctx, 'templateModule', 'delete');
  await requireNestedWrite(tx, deps, ctx, 'commonGoal', 'delete');
  if (await referenced(tx, ctx, id)) conflict('IDP_TEMPLATE_REFERENCED', '模板已被发展计划引用，不能删除');
  const before = (await loadTemplate(tx, ctx.tenantId, id))!;
  for (const goal of before.commonGoals) {
    await audit(tx, ctx, 'commonGoal', 'delete', goal.id, { before: goal, after: null, orgId: before.orgId });
  }
  for (const module of before.modules) {
    await audit(tx, ctx, 'templateModule', 'delete', module.id, { before: module, after: null, orgId: before.orgId });
  }
  const T = idpTemplates;
  await tx.delete(T).where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)));
  await audit(tx, ctx, 'template', 'delete', id, { before: templateRecord(before), after: null, orgId: before.orgId });
  return before;
}

/** 复制时继承内容的字段投影（事务外按当前权限预先解析，见 routes.ts）。 */
export interface CopyProjections {
  readonly template: Projection;
  readonly templateModule: Projection;
  readonly commonGoal: Projection;
}

/**
 * 复制模板（IDP-R6，🟡 K-27）：源模板对操作人可见即可（含向下公开）；新模板挂在操作人范围内的组织（缺省同源模板），
 * 带出模块、节点按钮配置与通用目标，名称须新填且不重复，副本为草稿。
 * 第 2 轮 P2-3 / P2-4：继承的每个字段都须对操作人可见、且操作人在目标位置有权创建（模板、每个模块、每个通用目标），
 * 有一项不满足即整次拒绝（403），不做“看不到的字段不复制”的部分复制；节点配置按审批流程当前已发布版本复核（409）。
 */
export async function copyTemplate(
  tx: Tx,
  deps: Deps,
  ctx: WriteContext,
  scopes: TemplateScopes & { readonly projections: CopyProjections },
  sourceId: string,
  input: TemplateCopy,
) {
  const T = idpTemplates;
  const [source] = await tx
    .select()
    .from(T)
    .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, sourceId)))
    .for('share');
  if (!source) throw new AppError('NOT_FOUND', '发展计划模板不存在');
  await requireReadable(tx, ctx, ctx.scope, 'template', source);
  // 第 4 轮：先判继承字段的查看权（只看权限、不看源数据），再用这些字段（缺省组织、流程）做范围与状态校验，
  // 否则 404 / 409 的差别会泄露隐藏的流程关联或源组织
  requireCopyViewable(ctx, scopes.projections, !input.orgId);
  const orgId = input.orgId ?? source.orgId;
  requireCreatable(ctx.scope, 'template', orgId);
  await requireOrg(tx, ctx.tenantId, orgId);
  await requireUsableProcess(tx, ctx, scopes.process, source.processId);
  const modules = await loadModuleRows(tx, ctx.tenantId, sourceId);
  const nodes = await loadNodeSettings(
    tx,
    ctx.tenantId,
    modules.map((m) => m.id),
  );
  const goals = await loadCommonGoals(tx, ctx.tenantId, sourceId);
  await checkCopyWritable(tx, deps, ctx, { source, modules, nodes, goals });

  const [row] = await unique(
    () =>
      tx
        .insert(T)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          description: source.description,
          orgId,
          publicDown: source.publicDown,
          processId: source.processId,
          ...created(ctx),
          updatedAt: ctx.now,
        })
        .returning({ id: T.id }),
    ...NAME_TAKEN,
  );
  const id = row!.id;
  const moduleIds = new Map<string, string>();
  for (const module of modules) {
    const { id: oldId, templateId: _t, createdAt: _c, createdBy: _b, ...fields } = module;
    const [copy] = await tx
      .insert(idpTemplateModules)
      .values({ ...fields, templateId: id, ...created(ctx) })
      .returning({ id: idpTemplateModules.id });
    moduleIds.set(oldId, copy!.id);
    await writeNodeSettings(tx, ctx, copy!.id, nodes.get(oldId) ?? []);
  }
  for (const goal of goals) {
    const { id: _id, moduleId, ...fields } = goal;
    await tx.insert(idpTemplateCommonGoals).values({
      tenantId: ctx.tenantId,
      templateId: id,
      moduleId: moduleIds.get(moduleId)!,
      ...fields,
      ...created(ctx),
    });
  }
  return auditCreated(tx, ctx, id);
}

interface CopySource {
  readonly source: TemplateRow;
  readonly modules: readonly ModuleRow[];
  readonly nodes: ReadonlyMap<string, readonly NodeSettingInput[]>;
  readonly goals: readonly { readonly id: string }[];
}

const COMMON_GOAL_COPY_FIELDS = ['moduleId', 'name', 'measure', 'suggestion', 'displayOrder'];

/**
 * 继承内容的查看门禁（P2-3，第 3 / 4 轮）：要求查看的字段只取决于请求（是否缺省组织），与源模板的数据无关——
 * 模板的继承字段（含流程、集合字段）、模块与通用目标对象的全部可继承字段。必须先于任何用源数据做的校验执行。
 */
function requireCopyViewable(ctx: WriteContext, views: CopyProjections, orgDefaulted: boolean) {
  const templateFields = ['description', 'publicDown', 'processId', 'modules', 'commonGoals'];
  if (orgDefaulted) templateFields.push('orgId');
  requireViewable(ctx, views.template, 'template', templateFields);
  requireViewable(ctx, views.templateModule, 'templateModule', [...TEMPLATE_MODULE_FIELDS]);
  requireViewable(ctx, views.commonGoal, 'commonGoal', COMMON_GOAL_COPY_FIELDS);
}

/** 继承内容在目标位置可创建（只对实际继承的模块 / 通用目标判定，此时内容对操作人可见），节点配置仍在已发布版本里。 */
async function checkCopyWritable(tx: Tx, deps: Deps, ctx: WriteContext, copy: CopySource) {
  await requireNestedWrite(tx, deps, ctx, 'template', 'create', {
    name: true,
    description: true,
    orgId: true,
    publicDown: true,
    processId: true,
  });
  for (const module of copy.modules) {
    const settings = copy.nodes.get(module.id) ?? [];
    const fields = Object.keys(moduleView(module, settings)).filter((field) => field !== 'id');
    await requireNestedWrite(tx, deps, ctx, 'templateModule', 'create', Object.fromEntries(fields.map((f) => [f, 1])));
    if (settings.length) await validateNodeSettings(tx, ctx, copy.source, module.moduleType as ModuleType, settings);
  }
  if (copy.goals.length) {
    const fields = Object.fromEntries(COMMON_GOAL_COPY_FIELDS.map((f) => [f, 1]));
    await requireNestedWrite(tx, deps, ctx, 'commonGoal', 'create', fields);
  }
}

// ---- 模块 ----

const GOAL_SETTINGS = [
  'allowCustomGoal',
  'allowLibraryGoal',
  'competencySource',
  'goalReviewEnabled',
  'taskEnabled',
  'checkNoneGoal',
] as const;
const REVIEW_SETTINGS = ['reviewTimeBasis', 'planTimeBasis', 'reviewCategoryIds'] as const;

/** 各模块类型只认自己的配置项（Q-M0-115④）；其他类型的配置项出现即 400。 */
function allowedSettings(type: ModuleType): ReadonlySet<string> {
  const common = ['name', 'description', 'displayOrder'];
  const own: readonly string[] =
    type === 'goal'
      ? GOAL_SETTINGS
      : type === 'key_info'
        ? ['keyInfoSources']
        : type === 'talent_review'
          ? REVIEW_SETTINGS
          : [];
  return new Set([...common, ...own, ...(nodeButtonsOf(type) ? ['nodeSettings'] : [])]);
}

function checkSettingKeys(type: ModuleType, input: Readonly<Record<string, unknown>>) {
  const allowed = allowedSettings(type);
  const extra = Object.keys(input).filter((key) => key !== 'moduleType' && !allowed.has(key));
  if (extra.length) invalid(`该模块类型不支持这些配置：${extra.join('、')}`, { fields: extra });
}

/** 从胜任力库引用须选来源（IDP-R8）。 */
function checkGoalSettings(row: Pick<ModuleRow, 'allowLibraryGoal' | 'competencySource'>) {
  if (row.allowLibraryGoal && !row.competencySource) invalid('允许从胜任力库引用目标时须选择胜任力来源');
}

/** 新模块的缺省配置（🟡：手册缺省；关键信息缺省展示全部来源）。 */
function defaultsOf(type: ModuleType): Partial<ModuleRow> {
  if (type === 'goal') {
    return {
      allowCustomGoal: true,
      allowLibraryGoal: false,
      competencySource: null,
      goalReviewEnabled: false,
      taskEnabled: false,
      checkNoneGoal: false,
    };
  }
  if (type === 'key_info') return { keyInfoSources: [...KEY_INFO_SOURCES] };
  if (type === 'talent_review')
    return { reviewTimeBasis: 'project_end', planTimeBasis: 'plan_start', reviewCategoryIds: [] };
  return {};
}

/**
 * 节点按钮配置（DEC-296④，K-12）：子流程须属于模板所用流程、节点须在该子流程所引用审批流程的已发布版本里
 * （409 IDP_NODE_NOT_FOUND）；按钮限于本模块类型的候选集（400），同一节点不能重复。
 */
async function validateNodeSettings(
  tx: Tx,
  ctx: WriteContext,
  template: TemplateRow,
  type: ModuleType,
  settings: readonly NodeSettingInput[],
) {
  const candidates = nodeButtonsOf(type);
  if (!candidates) invalid('该模块类型不能按流程节点配置按钮');
  const seen = new Set<string>();
  for (const setting of settings) {
    const key = `${setting.subProcessId}:${setting.nodeKey}`;
    if (seen.has(key)) invalid('同一流程节点重复配置');
    seen.add(key);
    const bad = setting.buttons.filter((b) => !(candidates as readonly string[]).includes(b));
    if (bad.length || new Set(setting.buttons).size !== setting.buttons.length) {
      invalid(`可用按钮只能从 ${candidates.join('、')} 中选择且不重复`, { buttons: bad });
    }
  }
  if (!settings.length) return;
  const subIds = [...new Set(settings.map((s) => s.subProcessId))];
  const nodes = rowsOf<{ sub_process_id: string; node_key: string }>(
    await tx.execute(sql`SELECT s.id AS sub_process_id, n.node_key FROM idp_sub_processes s
      JOIN approval_processes p ON p.tenant_id = s.tenant_id AND p.id = s.approval_process_id
      JOIN approval_process_nodes n ON n.tenant_id = p.tenant_id AND n.version_id = p.current_version_id
      WHERE s.tenant_id = ${ctx.tenantId} AND s.process_id = ${template.processId}::uuid
        AND s.id = ANY(${`{${subIds.join(',')}}`}::uuid[])
      FOR SHARE OF s`),
  );
  const known = new Set(nodes.map((n) => `${n.sub_process_id}:${n.node_key}`));
  for (const key of seen) {
    if (!known.has(key)) conflict('IDP_NODE_NOT_FOUND', '节点不属于本模板流程的子流程，或不在审批流程的已发布版本中');
  }
}

async function writeNodeSettings(tx: Tx, ctx: WriteContext, moduleId: string, settings: readonly NodeSettingInput[]) {
  const N = idpTemplateNodeSettings;
  await tx.delete(N).where(and(eq(N.tenantId, ctx.tenantId), eq(N.moduleId, moduleId)));
  if (!settings.length) return;
  await tx.insert(N).values(
    settings.map((s, index) => ({
      tenantId: ctx.tenantId,
      moduleId,
      subProcessId: s.subProcessId,
      nodeKey: s.nodeKey,
      seq: index + 1,
      enabled: s.enabled,
      buttons: [...s.buttons],
    })),
  );
}

async function loadModule(tx: Tx, ctx: WriteContext, templateId: string, moduleId: string): Promise<ModuleRow> {
  const M = idpTemplateModules;
  const [row] = await tx
    .select()
    .from(M)
    .where(and(eq(M.tenantId, ctx.tenantId), eq(M.templateId, templateId), eq(M.id, moduleId)));
  if (!row) throw new AppError('NOT_FOUND', '模板模块不存在');
  return row;
}

async function moduleSnapshot(tx: Tx, ctx: WriteContext, row: ModuleRow) {
  const nodes = await loadNodeSettings(tx, ctx.tenantId, [row.id]);
  return moduleView(row, nodes.get(row.id) ?? []);
}

function moduleColumns(input: ModuleCreate | ModulePatch): Partial<ModuleRow> {
  const { nodeSettings: _nodes, ...fields } = input as ModuleCreate;
  const { moduleType: _type, ...rest } = fields;
  return rest as Partial<ModuleRow>;
}

/** IDP-R12：被计划引用的模板不能增删模块（409 IDP_TEMPLATE_REFERENCED）。 */
export async function addModule(tx: Tx, ctx: WriteContext, templateId: string, input: ModuleCreate) {
  const template = await lockTemplate(tx, ctx, templateId);
  if (await referenced(tx, ctx, templateId)) conflict('IDP_TEMPLATE_REFERENCED', '模板已被发展计划引用，不能增删模块');
  const type = input.moduleType;
  checkSettingKeys(type, input);
  if (SINGLETON_MODULES.has(type)) {
    const M = idpTemplateModules;
    const [existing] = await tx
      .select({ id: M.id })
      .from(M)
      .where(and(eq(M.tenantId, ctx.tenantId), eq(M.templateId, templateId), eq(M.moduleType, type)));
    if (existing) conflict('IDP_MODULE_DUPLICATE', '该类型的模块每个模板只能有一个');
  }
  const values = { ...defaultsOf(type), ...moduleColumns(input) };
  if (type === 'goal') checkGoalSettings(values as ModuleRow);
  if (input.nodeSettings) await validateNodeSettings(tx, ctx, template, type, input.nodeSettings);
  const [row] = await tx
    .insert(idpTemplateModules)
    .values({
      tenantId: ctx.tenantId,
      templateId,
      moduleType: type,
      name: input.name,
      ...values,
      displayOrder: input.displayOrder ?? (await nextOrder(tx, ctx, 'idp_template_modules', templateId)),
      ...created(ctx),
    })
    .returning();
  await writeNodeSettings(tx, ctx, row!.id, input.nodeSettings ?? []);
  const after = await moduleSnapshot(tx, ctx, row!);
  await audit(tx, ctx, 'templateModule', 'create', row!.id, { before: null, after, orgId: template.orgId });
  return finish(tx, ctx, templateId);
}

/** IDP-R12：被计划引用后只能改 基本信息 / 关键信息 / 发展目标 模块，改动对已生成计划实时生效（G-056a）。 */
export async function updateModule(
  tx: Tx,
  ctx: WriteContext,
  templateId: string,
  moduleId: string,
  patch: ModulePatch,
) {
  const template = await lockTemplate(tx, ctx, templateId);
  const row = await loadModule(tx, ctx, templateId, moduleId);
  const type = row.moduleType as ModuleType;
  if ((await referenced(tx, ctx, templateId)) && !EDITABLE_AFTER_REFERENCED.has(type)) {
    conflict('IDP_TEMPLATE_REFERENCED', '模板已被发展计划引用，只能修改基本信息、关键信息、发展目标模块');
  }
  checkSettingKeys(type, patch);
  const columns = moduleColumns(patch);
  if (type === 'goal') checkGoalSettings({ ...row, ...columns } as ModuleRow);
  if (patch.nodeSettings) await validateNodeSettings(tx, ctx, template, type, patch.nodeSettings);
  const before = await moduleSnapshot(tx, ctx, row);
  const M = idpTemplateModules;
  if (Object.keys(columns).length) {
    await tx
      .update(M)
      .set(columns)
      .where(and(eq(M.tenantId, ctx.tenantId), eq(M.id, moduleId)));
  }
  if (patch.nodeSettings) await writeNodeSettings(tx, ctx, moduleId, patch.nodeSettings);
  const after = await moduleSnapshot(tx, ctx, await loadModule(tx, ctx, templateId, moduleId));
  await audit(tx, ctx, 'templateModule', 'update', moduleId, { before, after, orgId: template.orgId });
  return finish(tx, ctx, templateId);
}

/**
 * 基本信息模块固定不可删（IDP-R7）；删除发展目标模块连带其通用目标（各留快照），须有通用目标删除权（DEC-309④-2，
 * 不论该模块下是否有通用目标都要求）。
 */
export async function deleteModule(tx: Tx, deps: Deps, ctx: WriteContext, templateId: string, moduleId: string) {
  const template = await lockTemplate(tx, ctx, templateId);
  const row = await loadModule(tx, ctx, templateId, moduleId);
  if (row.moduleType === 'basic') conflict('IDP_BASIC_MODULE_FIXED', '基本信息模块固定，不能删除');
  if (row.moduleType === 'goal') await requireNestedWrite(tx, deps, ctx, 'commonGoal', 'delete');
  if (await referenced(tx, ctx, templateId)) conflict('IDP_TEMPLATE_REFERENCED', '模板已被发展计划引用，不能增删模块');
  const goals = (await loadCommonGoals(tx, ctx.tenantId, templateId)).filter((g) => g.moduleId === moduleId);
  for (const goal of goals) {
    await audit(tx, ctx, 'commonGoal', 'delete', goal.id, { before: goal, after: null, orgId: template.orgId });
  }
  const before = await moduleSnapshot(tx, ctx, row);
  const M = idpTemplateModules;
  await tx.delete(M).where(and(eq(M.tenantId, ctx.tenantId), eq(M.id, moduleId)));
  await audit(tx, ctx, 'templateModule', 'delete', moduleId, { before, after: null, orgId: template.orgId });
  return finish(tx, ctx, templateId);
}

// ---- 通用目标（IDP-R9：只对之后新发起的计划生效；模板被引用后仍可维护） ----

async function requireGoalModule(tx: Tx, ctx: WriteContext, templateId: string, moduleId: string) {
  const module = await loadModule(tx, ctx, templateId, moduleId);
  if (module.moduleType !== 'goal') conflict('IDP_MODULE_NOT_GOAL', '通用目标只能挂在发展目标模块下');
}

async function loadGoal(tx: Tx, ctx: WriteContext, templateId: string, goalId: string) {
  const goal = (await loadCommonGoals(tx, ctx.tenantId, templateId)).find((g) => g.id === goalId);
  if (!goal) throw new AppError('NOT_FOUND', '模板通用目标不存在');
  return goal;
}

export async function addCommonGoal(tx: Tx, ctx: WriteContext, templateId: string, input: CommonGoalCreate) {
  const template = await lockTemplate(tx, ctx, templateId);
  await requireGoalModule(tx, ctx, templateId, input.moduleId);
  const [row] = await tx
    .insert(idpTemplateCommonGoals)
    .values({
      tenantId: ctx.tenantId,
      templateId,
      moduleId: input.moduleId,
      name: input.name,
      measure: input.measure ?? null,
      suggestion: input.suggestion ?? null,
      displayOrder: input.displayOrder ?? (await nextOrder(tx, ctx, 'idp_template_common_goals', templateId)),
      ...created(ctx),
    })
    .returning({ id: idpTemplateCommonGoals.id });
  const after = await loadGoal(tx, ctx, templateId, row!.id);
  await audit(tx, ctx, 'commonGoal', 'create', after.id, { before: null, after, orgId: template.orgId });
  return finish(tx, ctx, templateId);
}

export async function updateCommonGoal(
  tx: Tx,
  ctx: WriteContext,
  templateId: string,
  goalId: string,
  patch: CommonGoalPatch,
) {
  const template = await lockTemplate(tx, ctx, templateId);
  const before = await loadGoal(tx, ctx, templateId, goalId);
  const G = idpTemplateCommonGoals;
  if (Object.keys(patch).length) {
    await tx
      .update(G)
      .set(patch)
      .where(and(eq(G.tenantId, ctx.tenantId), eq(G.id, goalId)));
  }
  const after = await loadGoal(tx, ctx, templateId, goalId);
  await audit(tx, ctx, 'commonGoal', 'update', goalId, { before, after, orgId: template.orgId });
  return finish(tx, ctx, templateId);
}

export async function deleteCommonGoal(tx: Tx, ctx: WriteContext, templateId: string, goalId: string) {
  const template = await lockTemplate(tx, ctx, templateId);
  const before = await loadGoal(tx, ctx, templateId, goalId);
  const G = idpTemplateCommonGoals;
  await tx.delete(G).where(and(eq(G.tenantId, ctx.tenantId), eq(G.id, goalId)));
  await audit(tx, ctx, 'commonGoal', 'delete', goalId, { before, after: null, orgId: template.orgId });
  return finish(tx, ctx, templateId);
}
