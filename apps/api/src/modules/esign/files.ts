/** F-481 §4.5：整份已签快照；文件外的姓名（ZIP 条目名）仍遵守 owner 字段读权。 */
import type { Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { recordOperationLog } from '../../audit/record.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import type { TenantContext } from '../../tenant-context.js';
import type { ModuleScope } from '../permission/module-access.js';
import { attachmentName, fileResponse, type Doc } from '../survey360/export-files.js';
import { zipFiles, boundedSize } from '../qualification/chart-files.js';
import { canRead, RECORD_OBJECT, taskNames, taskFiles, loadVisibleSignTask } from './record-access.js';
import { simulatedProvider } from './provider.js';

export async function downloadInputs(
  tx: Tx,
  ctx: ScopeBusinessContext & Pick<TenantContext, 'tenantName'>,
  ids: readonly string[],
  scope: ModuleScope | 'own',
  fields: ReadonlySet<string> | undefined,
) {
  if (!ctx.tenantName) throw new AppError('SERVICE_UNAVAILABLE', '租户名称上下文不可用');
  const tasks = [];
  // 所有 ID 先过范围再过状态，混合列表也不能泄露范围外状态。
  for (const id of ids) tasks.push(await loadVisibleSignTask(tx, ctx, id, scope));
  const unfinished = tasks.filter((t) => t.status !== 'completed').map((t) => t.id);
  if (unfinished.length)
    throw new AppError('CONFLICT', '只能下载已完成的签署文件', { reason: 'ESIGN_NOT_COMPLETED', ids: unfinished });
  const inputs = [];
  for (const task of tasks) {
    const names = await taskNames(tx, ctx, task);
    const files = await taskFiles(tx, ctx.tenantId, task.id);
    const time = (at: Date | null) =>
      at
        ? new Intl.DateTimeFormat('zh-CN', {
            timeZone: ctx.timezone,
            dateStyle: 'medium',
            timeStyle: 'medium',
            hour12: false,
          }).format(at)
        : '--';
    const documents: Doc[] = files.map((f) => ({
      title: f.templateName,
      blocks: [
        { kind: 'title', text: f.templateName },
        { kind: 'text', text: f.content },
        { kind: 'text', text: `员工本人：${names.owner} 于 ${time(task.employeeSignedAt)} 确认（复刻模拟签署）` },
        {
          kind: 'text',
          text: `企业确认：${ctx.tenantName} 由 ${names.initiator} 于 ${time(task.enterpriseSignedAt)} 确认（复刻模拟签署，无电子印章）`,
        },
      ],
    }));
    if (!documents.length) throw new AppError('SERVICE_UNAVAILABLE', '签署文件不可用');
    inputs.push({
      taskId: task.id,
      providerRef: task.providerRef,
      documents,
      owner: scope === 'own' || canRead(fields, 'owner') ? names.owner : task.id.slice(0, 8),
    });
  }
  return inputs;
}

/** 复用 attachmentName 的清理与 Unicode 截断，ZIP 内也不允许路径或控制字符。 */
const safeName = (name: string) => decodeURIComponent(attachmentName(name, 'pdf').split("UTF-8''")[1]!).slice(0, -4);
export async function generateFiles(
  ctx: ScopeBusinessContext,
  inputs: Awaited<ReturnType<typeof downloadInputs>>,
  signal: AbortSignal,
) {
  const files: { name: string; data: Buffer }[] = [];
  const used = new Set<string>();
  let size = 0;
  const single = inputs.length === 1 && inputs[0]!.documents.length === 1;
  for (const input of inputs) {
    const rendered = await simulatedProvider.signedFiles({ ...input, tenantId: ctx.tenantId, signal });
    for (const file of rendered) {
      const base = safeName(single ? file.name : `${input.owner}_${file.name}`);
      let name = `${base}.pdf`;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}.pdf`;
      used.add(name);
      size += file.bytes.length;
      boundedSize(size);
      files.push({ name, data: Buffer.from(file.bytes) });
    }
  }
  const name = single
    ? files[0]!.name.slice(0, -4)
    : `电子签署文件_${tenantLocalDate(ctx.now, ctx.timezone).replaceAll('-', '')}`;
  const extension = single ? 'pdf' : 'zip';
  return fileResponse(
    single ? files[0]!.data : zipFiles(files),
    `application/${extension}`,
    attachmentName(name, extension),
  );
}
export async function logDownload(tx: Tx, ctx: ScopeBusinessContext, count: number) {
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    behavior: 'export',
    objectType: RECORD_OBJECT,
    objectId: 'signed-files',
    successCount: count,
    failureCount: 0,
    summary: '下载电子签署文件',
    occurredAt: ctx.now,
  });
}
