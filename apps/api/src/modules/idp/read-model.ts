/**
 * IDP 配置的读模型：流程（含子流程与开启规则说明）、模板（含模块、节点按钮配置、通用目标）。
 * 读模型不做权限判断；范围谓词由调用方给出（列表在分页之前过滤），字段裁剪在路由层。
 */
import {
  and,
  asc,
  eq,
  idpProcesses,
  idpSubProcesses,
  idpTemplateCommonGoals,
  idpTemplateModules,
  idpTemplateNodeSettings,
  idpTemplates,
  inArray,
  sql,
  type Tx,
} from '@italent/db';
import {
  type ModuleType,
  type KeyInfoSource,
  keyInfoBlocksOf,
  nodeButtonsOf,
  type ReferencePoint,
  type StartFrom,
  type StartMode,
  startRuleText,
  type StartTimeType,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { templateReferencedByPlans } from './references.js';

export interface SubProcessView {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly category: string;
  readonly approvalType: string;
  readonly approvalProcessId: string;
  readonly endNoticeTemplate: string | null;
  readonly startMode: StartMode;
  readonly startTimeType: StartTimeType | null;
  readonly fixedDate: string | null;
  readonly referencePoint: ReferencePoint | null;
  readonly startFrom: StartFrom | null;
  readonly days: number | null;
  readonly ruleText: string;
}

export interface ProcessView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly orgId: string;
  readonly publicDown: boolean;
  readonly enabled: boolean;
  /** 是否被模板引用（IDP-R5）。 */
  readonly referenced: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly subProcesses: SubProcessView[];
}

export interface NodeSettingView {
  readonly subProcessId: string;
  readonly nodeKey: string;
  readonly enabled: boolean;
  readonly buttons: string[];
}

export interface ModuleView {
  readonly id: string;
  readonly moduleType: ModuleType;
  readonly name: string;
  readonly description: string | null;
  readonly displayOrder: number;
  readonly [setting: string]: unknown;
}

export interface CommonGoalView {
  readonly id: string;
  readonly moduleId: string;
  readonly name: string;
  readonly measure: string | null;
  readonly suggestion: string | null;
  readonly displayOrder: number;
}

export interface TemplateSummary {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description: string | null;
  readonly orgId: string;
  readonly publicDown: boolean;
  readonly processId: string;
  readonly status: 'draft' | 'published';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TemplateView extends TemplateSummary {
  /** 是否被发展计划引用（IDP-R12，判定经端口，PR-B 登记）。 */
  readonly referenced: boolean;
  readonly modules: ModuleView[];
  readonly commonGoals: CommonGoalView[];
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

const iso = (value: Date) => value.toISOString();

type ProcessRow = typeof idpProcesses.$inferSelect;
type SubProcessRow = typeof idpSubProcesses.$inferSelect;
type TemplateRow = typeof idpTemplates.$inferSelect;
type ModuleRow = typeof idpTemplateModules.$inferSelect;

export function subProcessView(row: SubProcessRow, index: number): SubProcessView {
  const rule = {
    startMode: row.startMode as StartMode,
    startTimeType: row.startTimeType as StartTimeType | null,
    fixedDate: row.fixedDate,
    referencePoint: row.referencePoint as ReferencePoint | null,
    startFrom: row.startFrom as StartFrom | null,
    days: row.days,
  };
  return {
    id: row.id,
    seq: row.seq,
    name: row.name,
    category: row.category,
    approvalType: row.approvalType,
    approvalProcessId: row.approvalProcessId,
    endNoticeTemplate: row.endNoticeTemplate,
    ...rule,
    ruleText: startRuleText(rule, index),
  };
}

/** lock：子流程行 FOR UPDATE（与模板写节点配置时对子流程行的 FOR SHARE 串行）。 */
export async function loadSubProcessRows(
  tx: Tx,
  tenantId: string,
  processId: string,
  lock = false,
): Promise<SubProcessRow[]> {
  const S = idpSubProcesses;
  const query = tx
    .select()
    .from(S)
    .where(and(eq(S.tenantId, tenantId), eq(S.processId, processId)))
    .orderBy(asc(S.seq));
  return lock ? query.for('update') : query;
}

export async function processReferenced(tx: Tx, tenantId: string, processId: string): Promise<boolean> {
  const T = idpTemplates;
  const [row] = await tx
    .select({ id: T.id })
    .from(T)
    .where(and(eq(T.tenantId, tenantId), eq(T.processId, processId)))
    .limit(1);
  return row !== undefined;
}

function processView(row: ProcessRow, subs: readonly SubProcessRow[], referenced: boolean): ProcessView {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    orgId: row.orgId,
    publicDown: row.publicDown,
    enabled: row.enabled,
    referenced,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    subProcesses: subs.map(subProcessView),
  };
}

/** 一页流程的子流程与“是否被引用”一次读出（有界查询，不逐行查询）。 */
async function processViews(tx: Tx, tenantId: string, rows: readonly ProcessRow[]): Promise<ProcessView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const S = idpSubProcesses;
  const subs = await tx
    .select()
    .from(S)
    .where(and(eq(S.tenantId, tenantId), inArray(S.processId, ids)))
    .orderBy(asc(S.processId), asc(S.seq));
  const T = idpTemplates;
  const used = await tx
    .selectDistinct({ processId: T.processId })
    .from(T)
    .where(and(eq(T.tenantId, tenantId), inArray(T.processId, ids)));
  const referenced = new Set(used.map((u) => u.processId));
  return rows.map((row) =>
    processView(
      row,
      subs.filter((s) => s.processId === row.id),
      referenced.has(row.id),
    ),
  );
}

export async function loadProcess(tx: Tx, tenantId: string, id: string): Promise<ProcessView | undefined> {
  const P = idpProcesses;
  const [row] = await tx
    .select()
    .from(P)
    .where(and(eq(P.tenantId, tenantId), eq(P.id, id)));
  return row ? (await processViews(tx, tenantId, [row]))[0] : undefined;
}

export async function listProcesses(
  tx: Tx,
  tenantId: string,
  query: Page & { readonly enabled?: boolean | undefined; readonly visible: SQL },
): Promise<ProcessView[]> {
  const P = idpProcesses;
  const rows = await tx
    .select()
    .from(P)
    .where(
      and(
        eq(P.tenantId, tenantId),
        query.enabled === undefined ? undefined : eq(P.enabled, query.enabled),
        sql`${query.visible}`,
      ),
    )
    .orderBy(asc(P.createdAt), asc(P.id))
    .limit(query.limit)
    .offset(query.offset);
  return processViews(tx, tenantId, rows);
}

function templateSummary(row: TemplateRow): TemplateSummary {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    description: row.description,
    orgId: row.orgId,
    publicDown: row.publicDown,
    processId: row.processId,
    status: row.status as 'draft' | 'published',
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** 模块视图：只带本模块类型用到的配置；可按节点配置按钮的模块带 nodeSettings。 */
export function moduleView(row: ModuleRow, nodeSettings: readonly NodeSettingView[]): ModuleView {
  const base = {
    id: row.id,
    moduleType: row.moduleType as ModuleType,
    name: row.name,
    description: row.description,
    displayOrder: row.displayOrder,
  };
  const settings: Record<string, unknown> = {};
  if (row.moduleType === 'goal') {
    Object.assign(settings, {
      allowCustomGoal: row.allowCustomGoal,
      allowLibraryGoal: row.allowLibraryGoal,
      competencySource: row.competencySource,
      goalReviewEnabled: row.goalReviewEnabled,
      taskEnabled: row.taskEnabled,
      checkNoneGoal: row.checkNoneGoal,
    });
  }
  if (row.moduleType === 'key_info') {
    const sources = (row.keyInfoSources ?? []) as KeyInfoSource[];
    settings.keyInfoSources = sources;
    settings.keyInfoBlocks = keyInfoBlocksOf(sources, row.keyInfoFields);
  }
  if (row.moduleType === 'talent_review') {
    Object.assign(settings, {
      reviewTimeBasis: row.reviewTimeBasis,
      planTimeBasis: row.planTimeBasis,
      reviewCategoryIds: row.reviewCategoryIds ?? [],
    });
  }
  if (nodeButtonsOf(row.moduleType as ModuleType)) settings.nodeSettings = [...nodeSettings];
  return { ...base, ...settings };
}

export async function loadModuleRows(tx: Tx, tenantId: string, templateId: string): Promise<ModuleRow[]> {
  const M = idpTemplateModules;
  return tx
    .select()
    .from(M)
    .where(and(eq(M.tenantId, tenantId), eq(M.templateId, templateId)))
    .orderBy(asc(M.displayOrder), asc(M.createdAt), asc(M.id));
}

export async function loadNodeSettings(
  tx: Tx,
  tenantId: string,
  moduleIds: readonly string[],
): Promise<Map<string, NodeSettingView[]>> {
  const N = idpTemplateNodeSettings;
  const result = new Map<string, NodeSettingView[]>();
  if (!moduleIds.length) return result;
  const rows = await tx
    .select()
    .from(N)
    .where(and(eq(N.tenantId, tenantId), inArray(N.moduleId, [...moduleIds])))
    .orderBy(asc(N.moduleId), asc(N.seq));
  for (const row of rows) {
    const list = result.get(row.moduleId) ?? [];
    list.push({ subProcessId: row.subProcessId, nodeKey: row.nodeKey, enabled: row.enabled, buttons: row.buttons });
    result.set(row.moduleId, list);
  }
  return result;
}

export async function loadCommonGoals(tx: Tx, tenantId: string, templateId: string): Promise<CommonGoalView[]> {
  const G = idpTemplateCommonGoals;
  const rows = await tx
    .select()
    .from(G)
    .where(and(eq(G.tenantId, tenantId), eq(G.templateId, templateId)))
    .orderBy(asc(G.displayOrder), asc(G.createdAt), asc(G.id));
  return rows.map((row) => ({
    id: row.id,
    moduleId: row.moduleId,
    name: row.name,
    measure: row.measure,
    suggestion: row.suggestion,
    displayOrder: row.displayOrder,
  }));
}

async function templateView(tx: Tx, row: TemplateRow): Promise<TemplateView> {
  const modules = await loadModuleRows(tx, row.tenantId, row.id);
  const nodes = await loadNodeSettings(
    tx,
    row.tenantId,
    modules.map((m) => m.id),
  );
  return {
    ...templateSummary(row),
    referenced: await templateReferencedByPlans(tx, row.tenantId, row.id),
    modules: modules.map((m) => moduleView(m, nodes.get(m.id) ?? [])),
    commonGoals: await loadCommonGoals(tx, row.tenantId, row.id),
  };
}

export async function loadTemplate(tx: Tx, tenantId: string, id: string): Promise<TemplateView | undefined> {
  const T = idpTemplates;
  const [row] = await tx
    .select()
    .from(T)
    .where(and(eq(T.tenantId, tenantId), eq(T.id, id)));
  return row ? templateView(tx, row) : undefined;
}

export async function listTemplates(
  tx: Tx,
  tenantId: string,
  query: Page & {
    readonly status?: 'draft' | 'published' | undefined;
    readonly processId?: string | undefined;
    readonly visible: SQL;
  },
): Promise<TemplateSummary[]> {
  const T = idpTemplates;
  const rows = await tx
    .select()
    .from(T)
    .where(
      and(
        eq(T.tenantId, tenantId),
        query.status === undefined ? undefined : eq(T.status, query.status),
        query.processId === undefined ? undefined : eq(T.processId, query.processId),
        sql`${query.visible}`,
      ),
    )
    .orderBy(asc(T.createdAt), asc(T.id))
    .limit(query.limit)
    .offset(query.offset);
  return rows.map(templateSummary);
}
