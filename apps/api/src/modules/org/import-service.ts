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
) {
  assertBatch(rows);
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
    const result = reason
      ? conflict(row, reason)
      : await importRow(tx, ctx, row, targetId, snapshot.mappings.has(row.sourceCode));
    await saveReceipt(tx, ctx, rowIndex, result, result.orgId ?? targetId ?? row.parentId);
    results.push(result);
    if (result.orgId && result.status !== 'conflict') {
      // 保留旧编码占用，新增成功行的编码和映射也立即禁止在本批次重用。
      snapshot.codes.set(result.code, result.orgId);
      seenCodes.add(result.code);
      snapshot.mappings.set(row.sourceCode, result.orgId);
    }
  }
  const anchors = rows.map((row, rowIndex) => ({
    orgId: results[rowIndex]?.orgId ?? snapshot.mappings.get(row.sourceCode) ?? row.orgId ?? row.parentId,
  }));
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
): Promise<OrgImportReceipt> {
  try {
    // 一行失败须撤销该行的版本、层级、审计和映射，随后仍可在同一命令事务内继续其它行。
    return await tx.transaction(async (savepoint) => {
      const input = { name: row.name, code: row.code, parents: { admin: { parentId: row.parentId } } };
      const organization = targetId
        ? await updateOrganization(savepoint, { ...ctx, expectedRevision: row.expectedRevision! }, targetId, {
            ...input,
            effectiveDate: row.startDate ?? tenantLocalDate(ctx.now, ctx.timezone),
          })
        : await createOrganization(
            savepoint,
            { ...ctx, expectedRevision: 0 },
            // DEC-130：新建行的 startDate 即原站首版生效日，也就是设立日期；不填时设立日期缺省为租户当天。
            {
              ...input,
              ...(row.startDate === undefined ? {} : { establishedOn: row.startDate }),
            },
          );
      if (!mapped) {
        await savepoint.insert(orgImportMappings).values({
          tenantId: ctx.tenantId,
          sourceCode: row.sourceCode,
          orgId: organization.id,
        });
      }
      return {
        sourceCode: row.sourceCode,
        code: organization.code,
        status: targetId ? 'updated' : 'created',
        orgId: organization.id,
      };
    });
  } catch (error) {
    const reason = businessConflict(error);
    if (!reason) throw error;
    return conflict(row, reason);
  }
}

function businessConflict(error: unknown): string | undefined {
  if (
    error instanceof AppError &&
    ['VALIDATION_FAILED', 'CONFLICT', 'REVISION_CONFLICT', 'NOT_FOUND', 'FORBIDDEN'].includes(error.code)
  ) {
    return error.code;
  }
  switch (pgErrorCode(error)) {
    case '23505':
      return 'CODE_OR_MAPPING_CONFLICT';
    case '23503':
      return 'INVALID_REFERENCE';
    case '23514':
      return 'VALIDATION_FAILED';
    default:
      return undefined;
  }
}

function conflict(row: OrgImportRow, reason: string): OrgImportReceipt {
  return { sourceCode: row.sourceCode, code: row.code, status: 'conflict', reason };
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
