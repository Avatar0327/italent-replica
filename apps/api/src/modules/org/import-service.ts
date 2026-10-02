import {
  and,
  auditEvents,
  eq,
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
export async function importOrganizations(tx: Tx, ctx: OrgWriteContext, rows: readonly OrgImportRow[]) {
  assertBatch(rows);
  await ensureOrgSetup(tx, ctx);
  const snapshot = await importSnapshot(tx, ctx);
  assertRequiredRevisions(rows, snapshot);
  const seenSources = new Set<string>();
  const seenCodes = new Set<string>();
  const results: OrgImportReceipt[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const targetId = snapshot.mappings.get(row.sourceCode) ?? row.orgId;
    const reason = preflightConflict(row, targetId, snapshot, seenSources, seenCodes);
    seenSources.add(row.sourceCode);
    seenCodes.add(row.code);
    const result = reason
      ? conflict(row, reason)
      : await importRow(tx, ctx, row, targetId, snapshot.mappings.has(row.sourceCode));
    await saveReceipt(tx, ctx, rowIndex, result);
    results.push(result);
    if (result.orgId && result.status !== 'conflict') {
      // 保留旧编码占用，新增成功行的编码和映射也立即禁止在本批次重用。
      snapshot.codes.set(result.code, result.orgId);
      seenCodes.add(result.code);
      snapshot.mappings.set(row.sourceCode, result.orgId);
    }
  }
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
            {
              ...input,
              ...(row.startDate === undefined ? {} : { startDate: row.startDate }),
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

async function saveReceipt(tx: Tx, ctx: OrgWriteContext, rowIndex: number, result: OrgImportReceipt) {
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
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    objectType: 'org_import_result',
    objectId: `${ctx.commandId}:${rowIndex}`,
    action: 'org.import.row',
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    before: null,
    after: { rowIndex, ...result },
  });
}
