/**
 * 签署模板库与场景设置的读写（F-481 设计 §3.2、§5.4、§10.4）。写入都在调用方的租户事务内，
 * 与审计同事务；配置写入以租户级咨询锁串行化，先比 revision（陈旧 → 409 REVISION_CONFLICT）再查唯一性。
 */
import { esignSceneSettings, esignTemplates, and, asc, eq, type Tx } from '@italent/db';
import {
  ESIGN_DEFAULT_REMIND_BEFORE_EXPIRY,
  ESIGN_DEFAULT_VALIDITY_DAYS,
  unknownTemplateVariables,
} from '@italent/domain';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import type { CreateTemplateInput, PatchTemplateInput, SceneSettingsInput } from './input.js';

export const ESIGN_TEMPLATE_AUDIT_TYPE = 'esign-template';
export const ESIGN_SCENE_AUDIT_TYPE = 'esign-scene-settings';

export interface TemplateView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly body: string;
  readonly status: string;
  readonly sortOrder: number;
  readonly revision: number;
}
export interface SceneView {
  readonly scene: 'transfer';
  readonly validityDays: number;
  readonly remindBeforeExpiry: boolean;
  readonly revision: number;
}

type Row = typeof esignTemplates.$inferSelect;
const view = (row: Row): TemplateView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  body: row.body,
  status: row.status,
  sortOrder: row.sortOrder,
  revision: row.revision,
});

/** 正文里只允许内置变量（设计 §3.2）；创建与编辑同一检查。 */
export function assertKnownVariables(body: string): void {
  const unknown = unknownTemplateVariables(body);
  if (unknown.length > 0)
    throw new AppError('VALIDATION_FAILED', `正文含未支持的变量：${unknown.join('、')}`, {
      reason: 'ESIGN_TEMPLATE_VARIABLE_UNKNOWN',
      variables: unknown,
    });
}

const lockConfig = (tx: Tx, tenantId: string) => advisoryLock(tx, asUuid(tenantId), ':esign-config');
const ordered = [asc(esignTemplates.sortOrder), asc(esignTemplates.name)] as const;

export async function listTemplates(tx: Tx, tenantId: string): Promise<TemplateView[]> {
  const rows = await tx
    .select()
    .from(esignTemplates)
    .where(eq(esignTemplates.tenantId, tenantId))
    .orderBy(...ordered)
    .limit(1001);
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '签署模板超过单次处理上限');
  return rows.map(view);
}

/** 调动表单下拉：只给启用模板的 id 与 name，不按场景过滤（设计 §4.3）。 */
export async function templateOptions(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({ id: esignTemplates.id, name: esignTemplates.name })
    .from(esignTemplates)
    .where(and(eq(esignTemplates.tenantId, tenantId), eq(esignTemplates.status, 'enabled')))
    .orderBy(...ordered)
    .limit(1000);
  return { items: rows };
}

async function auditTemplate(
  tx: Tx,
  ctx: ScopeBusinessContext,
  action: string,
  id: string,
  before: TemplateView | null,
  after: TemplateView,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action,
    objectType: ESIGN_TEMPLATE_AUDIT_TYPE,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function assertUnique(tx: Tx, tenantId: string, input: { code?: string; name?: string }, selfId?: string) {
  const rows = await tx
    .select({ id: esignTemplates.id, code: esignTemplates.code, name: esignTemplates.name })
    .from(esignTemplates)
    .where(eq(esignTemplates.tenantId, tenantId))
    .limit(1001);
  for (const row of rows) {
    if (row.id === selfId) continue;
    if (input.code !== undefined && row.code === input.code)
      throw new AppError('CONFLICT', '模板编码已存在', { reason: 'ESIGN_TEMPLATE_CODE_DUPLICATE' });
    if (input.name !== undefined && row.name === input.name)
      throw new AppError('CONFLICT', '模板名称已存在', { reason: 'ESIGN_TEMPLATE_NAME_DUPLICATE' });
  }
}

export async function createTemplate(tx: Tx, ctx: ScopeBusinessContext, input: CreateTemplateInput) {
  await lockConfig(tx, ctx.tenantId);
  await assertUnique(tx, ctx.tenantId, input);
  const [row] = await tx
    .insert(esignTemplates)
    .values({
      tenantId: ctx.tenantId,
      code: input.code,
      name: input.name,
      body: input.body,
      sortOrder: input.sortOrder ?? 0,
      updatedBy: ctx.userId,
    })
    .returning();
  const created = view(row!);
  await auditTemplate(tx, ctx, 'esign.template.create', created.id, null, created);
  return created;
}

export async function patchTemplate(tx: Tx, ctx: ScopeBusinessContext, id: string, input: PatchTemplateInput) {
  await lockConfig(tx, ctx.tenantId);
  const [current] = await tx
    .select()
    .from(esignTemplates)
    .where(and(eq(esignTemplates.tenantId, ctx.tenantId), eq(esignTemplates.id, id)));
  if (!current) throw new AppError('NOT_FOUND', '签署模板不存在');
  if (current.revision !== ctx.expectedRevision)
    throw new AppError('REVISION_CONFLICT', '签署模板已被修改，请刷新后重试', { expected: current.revision });
  await assertUnique(tx, ctx.tenantId, input, id);
  const [row] = await tx
    .update(esignTemplates)
    .set({ ...input, revision: current.revision + 1, updatedAt: ctx.now, updatedBy: ctx.userId })
    .where(and(eq(esignTemplates.tenantId, ctx.tenantId), eq(esignTemplates.id, id)))
    .returning();
  const after = view(row!);
  await auditTemplate(tx, ctx, 'esign.template.update', id, view(current), after);
  return after;
}

export async function getSceneSettings(tx: Tx, tenantId: string): Promise<SceneView> {
  const [row] = await tx
    .select()
    .from(esignSceneSettings)
    .where(and(eq(esignSceneSettings.tenantId, tenantId), eq(esignSceneSettings.scene, 'transfer')));
  return row
    ? {
        scene: 'transfer',
        validityDays: row.validityDays,
        remindBeforeExpiry: row.remindBeforeExpiry,
        revision: row.revision,
      }
    : {
        scene: 'transfer',
        validityDays: ESIGN_DEFAULT_VALIDITY_DAYS,
        remindBeforeExpiry: ESIGN_DEFAULT_REMIND_BEFORE_EXPIRY,
        revision: 0,
      };
}

/** 没有行时 If-Match: 0 建第一版（revision 1）；之后按行 revision 乐观锁。 */
export async function saveSceneSettings(tx: Tx, ctx: ScopeBusinessContext, input: SceneSettingsInput) {
  await lockConfig(tx, ctx.tenantId);
  const before = await getSceneSettings(tx, ctx.tenantId);
  if (before.revision !== ctx.expectedRevision)
    throw new AppError('REVISION_CONFLICT', '签署场景设置已被修改，请刷新后重试', { expected: before.revision });
  const after: SceneView = { scene: 'transfer', ...input, revision: before.revision + 1 };
  const values = {
    tenantId: ctx.tenantId,
    scene: 'transfer',
    validityDays: input.validityDays,
    remindBeforeExpiry: input.remindBeforeExpiry,
    revision: after.revision,
    updatedAt: ctx.now,
    updatedBy: ctx.userId,
  };
  await tx
    .insert(esignSceneSettings)
    .values(values)
    .onConflictDoUpdate({ target: [esignSceneSettings.tenantId, esignSceneSettings.scene], set: values });
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: 'esign.scene.update',
    objectType: ESIGN_SCENE_AUDIT_TYPE,
    objectId: ctx.tenantId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  return after;
}
