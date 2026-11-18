/**
 * F-479 §10.5 子集附件读取展开：把附件字段的文件 ID 展开为 { id, filename, contentType, byteSize }。
 * 只展开“绑定在本记录、状态 bound”的文件；其余（别的记录的、已清理的、历史值）输出 null，不回显任何别的元数据。
 * 展开发生在字段裁剪之前：字段无查看权时整键由 trimSubset / trim 去掉，元数据一并不出现。
 */
import { attachmentFiles as F, and, eq, inArray, type Tx } from '@italent/db';
import { subsetAttachmentFields, SUBSETS, type SubsetKind } from '@italent/domain';

export const SUBSET_PURPOSE = 'personnel.subset_attachment';
/** 绑定时写进 attachment_files.business_type 的载体类型；business_id 是子集记录 ID。 */
export const SUBSET_BUSINESS_TYPE = 'personnel.subset';

type Row = Record<string, unknown>;
export const subsetKindOfObject = (objectCode: string): SubsetKind | undefined =>
  (Object.keys(SUBSETS) as SubsetKind[]).find((kind) => SUBSETS[kind].objectCode === objectCode);

export async function expandSubsetAttachments<T extends Row>(
  tx: Tx,
  tenantId: string,
  kind: SubsetKind,
  items: readonly T[],
): Promise<T[]> {
  const fields = subsetAttachmentFields(kind);
  const ids = new Set<string>();
  for (const item of items)
    for (const field of fields) if (typeof item[field] === 'string') ids.add(item[field] as string);
  if (!ids.size) return [...items];
  const files = await tx
    .select()
    .from(F)
    .where(
      and(
        eq(F.tenantId, tenantId),
        eq(F.status, 'bound'),
        eq(F.businessType, SUBSET_BUSINESS_TYPE),
        inArray(F.id, [...ids]),
      ),
    );
  const byId = new Map(files.map((row) => [row.id.toLowerCase(), row]));
  return items.map((item) => {
    const expanded: Row = { ...item };
    for (const field of fields) {
      const value = item[field];
      if (typeof value !== 'string') continue;
      const file = byId.get(value.toLowerCase());
      const mine = file?.businessId?.toLowerCase() === String(item.id).toLowerCase();
      expanded[field] =
        file && mine
          ? { id: file.id, filename: file.filename, contentType: file.contentType, byteSize: file.byteSize }
          : null;
    }
    return expanded as T;
  });
}
