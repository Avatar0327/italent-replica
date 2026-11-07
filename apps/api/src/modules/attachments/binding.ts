/**
 * F-479 S2 绑定函数（设计 §2.4）：附件与载体（离职业务单）关联的唯一出口。
 * - bindAttachmentRefs：本人草稿 / 驳回单保存时求差——新增走绑定，移除按封存与否分流；
 * - assertRefsUnchanged：HR / 经理 / 审批编辑等“不能改附件”的出口，只比对不写；
 * - sealAttachments：离职提交时把引用封存（sealed_at），封存后永不进入待清理。
 * 三者都只能在命令 execute 内调用（台账未命中、首次执行），与业务写、审计、outbox 同一事务；
 * 守卫（CommandGuard.before）与重放路径不得调用，以免重放改写附件（AC-ATT-24）。
 */
import { attachmentFiles as F, and, eq, inArray, type Tx } from '@italent/db';
import { ATTACHMENT_PURPOSES } from '@italent/domain';
import { AppError } from '../../errors.js';
import { PgBlobStore } from './blob-store.js';
import { record, type FileRow } from './audit.js';

export interface BindingContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly now: Date;
  readonly commandId: string;
}

export const EXIT_CARRIER = 'employment.exit';
export const EXIT_BUSINESS_TYPE = 'employment';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const purposeOf = (carrier: string) => {
  const found = Object.entries(ATTACHMENT_PURPOSES).find(([, config]) => config.carrier === carrier);
  if (!found) throw new AppError('VALIDATION_FAILED', '附件载体不支持');
  return { code: found[0], config: found[1] };
};

/** 错误体只回显请求里的下标，不回显该 ID 的任何元数据（自查 9：不泄露别人文件是否存在）。 */
const invalid = (index: number) => new AppError('ATTACHMENT_INVALID', '附件不可用，请重新上传', { index });

/** 规范化引用列表：UUID 字符串、小写、无重复。 */
function normalize(value: unknown, maxFiles: number): string[] {
  if (!Array.isArray(value)) throw new AppError('VALIDATION_FAILED', 'attachmentRefs 必须是数组');
  if (value.length > maxFiles) throw new AppError('ATTACHMENT_LIMIT', `总文件数不能超过${maxFiles}个`, { maxFiles });
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== 'string' || !UUID.test(item)) throw invalid(index);
    const id = item.toLowerCase();
    if (seen.has(id)) throw invalid(index);
    seen.add(id);
    return id;
  });
}

/** jsonb 列读出来是 unknown：非数组一律按没有附件。 */
export const refsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
const lower = (list: unknown) => refsOf(list).map((id) => id.toLowerCase());

export interface BindInput {
  readonly carrier: string;
  readonly businessId: string;
  /** 当前存的列表（新建时为空）。 */
  readonly previous: readonly string[] | null;
  readonly next: unknown;
  readonly actor: string;
}

async function lockFiles(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (!ids.length) return new Map<string, FileRow>();
  const rows = await tx
    .select()
    .from(F)
    .where(and(eq(F.tenantId, tenantId), inArray(F.id, [...ids])))
    .orderBy(F.id)
    .for('update');
  return new Map(rows.map((row) => [row.id.toLowerCase(), row]));
}

async function move(tx: Tx, ctx: BindingContext, before: FileRow, operation: string, set: Partial<FileRow>) {
  const [after] = await tx
    .update(F)
    .set({ ...set, revision: before.revision + 1, updatedAt: ctx.now })
    .where(and(eq(F.tenantId, ctx.tenantId), eq(F.id, before.id)))
    .returning();
  await record(tx, ctx, operation, before, after!);
}

/** 返回规范化后要写进 exit_requests.attachment_refs 的列表（顺序以它为准）。 */
export async function bindAttachmentRefs(tx: Tx, ctx: BindingContext, input: BindInput): Promise<string[]> {
  const { code: purpose, config } = purposeOf(input.carrier);
  const next = normalize(input.next, config.maxFiles);
  const previous = lower(input.previous);
  const files = await lockFiles(tx, ctx.tenantId, [...new Set([...previous, ...next])]);
  const business = input.businessId.toLowerCase();
  const owned = (row: FileRow | undefined) =>
    row?.status === 'bound' && row.businessType === EXIT_BUSINESS_TYPE && row.businessId?.toLowerCase() === business;
  for (const [index, id] of next.entries()) {
    const row = files.get(id);
    if (previous.includes(id)) {
      if (!owned(row)) throw invalid(index);
      continue;
    }
    const fresh =
      row &&
      row.purpose === purpose &&
      row.ownerUserId.toLowerCase() === input.actor.toLowerCase() &&
      row.status === 'uploaded' &&
      (!row.expiresAt || row.expiresAt > ctx.now);
    if (!fresh) throw invalid(index);
    await move(tx, ctx, row, 'bind', {
      status: 'bound',
      businessType: EXIT_BUSINESS_TYPE,
      businessId: input.businessId,
      expiresAt: null,
    });
  }
  for (const id of previous.filter((old) => !next.includes(old))) {
    const row = files.get(id);
    if (!owned(row)) continue;
    // 从未提交的直接待清理；已封存的保留为 detached（历史审批表单可能引用，§2.3）
    await move(
      tx,
      ctx,
      row!,
      'unbind',
      row!.sealedAt ? { status: 'detached' } : { status: 'pending_cleanup', cleanupAt: ctx.now },
    );
  }
  return next;
}

/** 只读比对：不带（undefined）或与当前相同放行；不同 → 400，且不触碰任何附件行。 */
export function assertRefsUnchanged(previous: unknown, next: unknown): void {
  if (next === undefined) return;
  const current = lower(previous);
  // null 与空数组等价：审批表单对没有附件的单回传 null
  const given = next === null ? [] : next;
  const same =
    Array.isArray(given) &&
    given.length === current.length &&
    given.every((id, index) => typeof id === 'string' && id.toLowerCase() === current[index]);
  if (!same) throw new AppError('ATTACHMENT_REFS_READONLY', '该入口不能修改附件，请由申请人本人在草稿中修改');
}

/** 提交封存：复核每个引用仍绑定在本单且字节在，再写 sealed_at；没有附件时是空操作。 */
export async function sealAttachments(
  tx: Tx,
  ctx: BindingContext,
  business: { readonly id: string; readonly attachmentRefs: unknown },
): Promise<void> {
  const refs = lower(business.attachmentRefs);
  if (!refs.length) return;
  const files = await lockFiles(tx, ctx.tenantId, refs);
  const pending: FileRow[] = [];
  for (const id of refs) {
    const row = files.get(id);
    const live =
      row?.status === 'bound' &&
      row.businessType === EXIT_BUSINESS_TYPE &&
      row.businessId?.toLowerCase() === business.id.toLowerCase() &&
      (await PgBlobStore.read(tx, ctx.tenantId, id)) !== null;
    if (!live)
      throw new AppError('ATTACHMENT_MISSING', '附件已失效，请重新上传后再提交', { reason: 'ATTACHMENT_MISSING' });
    if (!row!.sealedAt) pending.push(row!);
  }
  for (const row of pending) await move(tx, ctx, row, 'seal', { sealedAt: ctx.now });
}

/**
 * 改期生成后继离职单时的附件继承（F-479 R1）：后继单是新的业务单，引用必须归属后继单（读取侧的归属校验不放宽）。
 * 做法是为后继单各建一条已封存的新附件行并复制同一份字节，前单的行与字节原样保留，所以前单照常可读；
 * 只继承前单仍 bound 在前单名下且字节在的引用，其余（已 detached 等）不带过去。返回后继单的新引用列表（顺序同前单）。
 */
export async function inheritAttachments(
  tx: Tx,
  ctx: BindingContext,
  input: { readonly fromBusinessId: string; readonly toBusinessId: string; readonly refs: unknown },
): Promise<string[]> {
  const refs = lower(input.refs);
  if (!refs.length) return [];
  const files = await lockFiles(tx, ctx.tenantId, refs);
  const inherited: string[] = [];
  for (const id of refs) {
    const row = files.get(id);
    const live =
      row?.status === 'bound' &&
      row.businessType === EXIT_BUSINESS_TYPE &&
      row.businessId?.toLowerCase() === input.fromBusinessId.toLowerCase();
    const bytes = live ? await PgBlobStore.read(tx, ctx.tenantId, id) : null;
    if (!row || !bytes) continue;
    const [copy] = await tx
      .insert(F)
      .values({
        tenantId: ctx.tenantId,
        purpose: row.purpose,
        ownerUserId: row.ownerUserId,
        ownerEmployeeId: row.ownerEmployeeId,
        status: 'bound',
        businessType: EXIT_BUSINESS_TYPE,
        businessId: input.toBusinessId,
        sealedAt: row.sealedAt ?? ctx.now,
        filename: row.filename,
        declaredType: row.declaredType,
        contentType: row.contentType,
        byteSize: row.byteSize,
        sha256: row.sha256,
        uploadedAt: row.uploadedAt,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    await PgBlobStore.put(tx, ctx.tenantId, copy!.id, bytes);
    await record(tx, ctx, 'inherit', null, copy!);
    inherited.push(copy!.id);
  }
  return inherited;
}
