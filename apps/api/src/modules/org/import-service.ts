import { planImportEmployment } from './import-employment.js';
import type { OrgUpdateOptions } from './write-service.js';
import { requiresEmploymentChoice } from './employment-linkage.js';
import {
  and,
  eq,
  inArray,
  orgCodeReservations,
  orgImportMappings,
  orgImportResults,
  orgObjects,
  pgErrorCode,
  type OrgImportStatus,
  type OrgObject,
  type Tx,
} from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { ensureOrgSetup } from './codes.js';
import { loadOrgSnapshot } from './read-model.js';
import { createOrganization, type OrgWriteContext, updateOrganization } from './write-service.js';
import { recordAudit, recordImportLog } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';

export interface OrgImportRow {
  readonly sourceCode: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: string;
  readonly orgId?: string;
  readonly expectedRevision?: number;
  readonly startDate?: string;
  readonly addEmployment?: boolean;
}

export interface OrgImportReceipt {
  readonly sourceCode: string;
  readonly code: string;
  readonly status: OrgImportStatus;
  readonly orgId?: string;
  readonly reason?: string;
}

interface ImportSnapshot {
  readonly objects: Map<string, OrgObject>;
  readonly codes: Map<string, string>;
  readonly mappings: Map<string, string>;
  readonly heldCodes: Set<string>;
}

/** DEC-060：按导入开始时的编码占用判冲突，不能由前一行改码为后一行腾出覆盖机会。 */
export async function importOrganizations(
  tx: Tx,
  ctx: OrgWriteContext,
  rows: readonly OrgImportRow[],
  authorizeRow?: (row: OrgImportRow, targetId: string | undefined, rowIndex: number) => Promise<void>,
  options: OrgUpdateOptions = {},
) {
  assertBatch(rows);
  const initial = await importSnapshot(tx, ctx);
  const employmentBatch = await planImportEmployment(
    tx,
    { ...ctx, scope: options.employmentScope },
    rows,
    initial.mappings,
  );
  await ensureOrgSetup(tx, ctx);
  const snapshot = await importSnapshot(tx, ctx);
  assertRequiredRevisions(rows, snapshot);
  const seenSources = new Set<string>();
  const seenCodes = new Set<string>();
  const results: OrgImportReceipt[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const targetId = snapshot.mappings.get(row.sourceCode) ?? row.orgId;
    await authorizeRow?.(row, targetId, rowIndex);
    const reason = preflightConflict(row, targetId, snapshot, seenSources, seenCodes);
    seenSources.add(row.sourceCode);
    seenCodes.add(row.code);
    if (reason) throw rowError(new AppError('CONFLICT', '导入行冲突，整批未保存', { reason }), row, rowIndex);
    let result: OrgImportReceipt;
    try {
      result = await importRow(tx, ctx, row, targetId, snapshot.mappings.has(row.sourceCode), {
        ...options,
        employmentBatch,
      });
    } catch (error) {
      throw rowError(error, row, rowIndex);
    }
    await saveReceipt(tx, ctx, rowIndex, result, result.orgId ?? targetId ?? row.parentId);
    results.push(result);
    if (result.orgId && result.status !== 'conflict') {
      // 保留旧编码占用，新增成功行的编码和映射也立即禁止在本批次重用。
      snapshot.codes.set(result.code, result.orgId);
      seenCodes.add(result.code);
      snapshot.mappings.set(row.sourceCode, result.orgId);
    }
  }
  // 逐行归属（第三轮 P1-2）与真实业务对象编号（第四轮 N2：按对象判断创建人；冲突行没有对象，回退为执行人）
  const anchors = rows.map((row, rowIndex) => {
    const objectId = results[rowIndex]?.orgId ?? snapshot.mappings.get(row.sourceCode) ?? row.orgId ?? null;
    return { objectId, orgId: objectId ?? row.parentId };
  });
  await recordImportLog(tx, { ...ctx, actorUserId: auditActor(ctx.userId) }, 'organization', results, anchors);
  return { results };
}

async function importSnapshot(tx: Tx, ctx: OrgWriteContext): Promise<ImportSnapshot> {
  const tenantId = ctx.tenantId;
  const objects = await tx.select().from(orgObjects).where(eq(orgObjects.tenantId, tenantId));
  const versions = await loadOrgSnapshot(tx, tenantId, tenantLocalDate(ctx.now, ctx.timezone));
  const mappings = await tx.select().from(orgImportMappings).where(eq(orgImportMappings.tenantId, tenantId));
  const held = await tx
    .select()
    .from(orgCodeReservations)
    .where(and(eq(orgCodeReservations.tenantId, tenantId), eq(orgCodeReservations.state, 'held')));
  return {
    objects: new Map(objects.map((row) => [row.id, row])),
    codes: new Map(versions.map((row) => [row.code, row.id])),
    mappings: new Map(mappings.map((row) => [row.sourceCode, row.orgId])),
    heldCodes: new Set(held.filter((row) => row.expiresAt > ctx.now).map((row) => row.code)),
  };
}

function assertBatch(rows: readonly OrgImportRow[]): void {
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('VALIDATION_FAILED', '导入至少需要一行');
  if (rows.length > 100) throw new AppError('PAYLOAD_TOO_LARGE', '单次组织导入最多 100 行');
  for (const row of rows) {
    if (
      !row ||
      typeof row.sourceCode !== 'string' ||
      !row.sourceCode.trim() ||
      typeof row.code !== 'string' ||
      !row.code.trim()
    ) {
      throw new AppError('VALIDATION_FAILED', '每行必须提供原站编码和机构编码');
    }
  }
}

function assertRequiredRevisions(rows: readonly OrgImportRow[], snapshot: ImportSnapshot): void {
  for (const row of rows) {
    if (!snapshot.mappings.has(row.sourceCode) && row.orgId === undefined) continue;
    if (row.expectedRevision === undefined) {
      throw new AppError('REVISION_REQUIRED', '更新已映射组织的导入行必须携带 expectedRevision');
    }
    if (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1) {
      throw new AppError('VALIDATION_FAILED', '导入更新行的 expectedRevision 必须是正整数');
    }
  }
}

function preflightConflict(
  row: OrgImportRow,
  targetId: string | undefined,
  snapshot: ImportSnapshot,
  seenSources: Set<string>,
  seenCodes: Set<string>,
): string | undefined {
  const mappedId = snapshot.mappings.get(row.sourceCode);
  if (seenSources.has(row.sourceCode)) return 'DUPLICATE_SOURCE_CODE';
  if (seenCodes.has(row.code)) return 'DUPLICATE_CODE';
  if (mappedId && row.orgId && row.orgId !== mappedId) return 'SOURCE_MAPPING_CONFLICT';
  if (targetId && !snapshot.objects.has(targetId)) return 'ORGANIZATION_NOT_FOUND';
  const codeOwner = snapshot.codes.get(row.code);
  if ((codeOwner && codeOwner !== targetId) || snapshot.heldCodes.has(row.code)) return 'CODE_CONFLICT';
  return undefined;
}

async function importRow(
  tx: Tx,
  ctx: OrgWriteContext,
  row: OrgImportRow,
  targetId: string | undefined,
  mapped: boolean,
  options: OrgUpdateOptions,
): Promise<OrgImportReceipt> {
  const input = { name: row.name, code: row.code, parents: { admin: { parentId: row.parentId } } };
  const effectiveDate = row.startDate ?? tenantLocalDate(ctx.now, ctx.timezone);
  const [current] = targetId ? await loadOrgSnapshot(tx, ctx.tenantId, effectiveDate, undefined, { id: targetId }) : [];
  // DEC-207（更正）：改名/行政上级须显式选择；非触发行忽略控制项。校验及写入复用单条变更。
  const choice =
    current && requiresEmploymentChoice(current, { ...input, effectiveDate })
      ? { addEmployment: row.addEmployment }
      : {};
  const organization = targetId
    ? await updateOrganization(
        tx,
        { ...ctx, expectedRevision: row.expectedRevision! },
        targetId,
        {
          ...input,
          ...choice,
          effectiveDate,
        },
        options,
      )
    : await createOrganization(
        tx,
        { ...ctx, expectedRevision: 0 },
        {
          ...input,
          // DEC-130：新建行的 startDate 是设立日期，不填缺省为租户当天。
          ...(row.startDate === undefined ? {} : { establishedOn: row.startDate }),
        },
      );
  if (!mapped)
    await tx.insert(orgImportMappings).values({
      tenantId: ctx.tenantId,
      sourceCode: row.sourceCode,
      orgId: organization.id,
    });
  return {
    sourceCode: row.sourceCode,
    code: organization.code,
    status: targetId ? 'updated' : 'created',
    orgId: organization.id,
  };
}

/** 不吞掉行内错误：命令事务撤销整批写入，行号从 0 起，保留原业务码与字段错误。 */
function rowError(error: unknown, row: OrgImportRow, rowIndex: number): unknown {
  const details = { rowIndex, sourceCode: row.sourceCode };
  if (error instanceof AppError)
    return new AppError(error.code, error.message, {
      ...(typeof error.details === 'object' && error.details !== null ? error.details : {}),
      ...details,
      // 审计任务沿用统一导入错误契约（row 从 1 起）；API 同时保留原来的 0 起 rowIndex。
      errors: [{ row: rowIndex + 1, code: error.code, details: error.details }],
    });
  const code = pgErrorCode(error);
  if (code === '23505') return new AppError('CONFLICT', '导入编码或映射冲突', details);
  if (code === '23503' || code === '23514') return new AppError('VALIDATION_FAILED', '导入行数据不合法', details);
  return error;
}

/** 逐行回执的归属：导入的组织；冲突行还没有组织时取上级组织（与导入时按上级授权一致，PR #75 第三轮 P1-2）。 */
async function saveReceipt(tx: Tx, ctx: OrgWriteContext, rowIndex: number, result: OrgImportReceipt, orgId: string) {
  await tx.insert(orgImportResults).values({
    tenantId: ctx.tenantId,
    commandId: ctx.commandId,
    rowIndex,
    sourceCode: result.sourceCode,
    code: result.code,
    status: result.status,
    orgId: result.orgId ?? null,
    reason: result.reason ?? null,
  });
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    objectType: 'org_import_result',
    objectId: `${ctx.commandId}:${rowIndex}`,
    action: 'org.import.row',
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    before: null,
    after: { rowIndex, ...result },
    scope: { orgId },
  });
}

export async function authorizeOrgImportRows(
  tx: Tx,
  ctx: OrgWriteContext,
  rows: readonly OrgImportRow[],
  authorize: (row: OrgImportRow, targetId: string | undefined) => Promise<void>,
) {
  const mappings = await tx
    .select()
    .from(orgImportMappings)
    .where(
      and(
        eq(orgImportMappings.tenantId, ctx.tenantId),
        inArray(
          orgImportMappings.sourceCode,
          rows.map((row) => row.sourceCode),
        ),
      ),
    )
    .limit(100);
  const targets = new Map(mappings.map((row) => [row.sourceCode, row.orgId]));
  for (const row of rows) await authorize(row, targets.get(row.sourceCode) ?? row.orgId);
}
