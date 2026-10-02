import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { assertRevision, auditEmployment } from './context.js';
import { checkPage, rowsOf } from './read-model.js';
import type { EmploymentContext, PageQuery } from './types.js';

export interface CustomFieldDefinition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly objectType: 'employment' | 'contract';
  readonly valueType: 'text' | 'integer' | 'decimal' | 'boolean' | 'date';
  readonly revision: number;
  readonly inherit: boolean;
}

const fieldInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    objectType: z.enum(['employment', 'contract']),
    valueType: z.enum(['text', 'integer', 'decimal', 'boolean', 'date']),
  })
  .strict();
const fieldSelect = sql`
  SELECT f.id,f.code,f.name,f.object_type AS "objectType",f.value_type AS "valueType",f.revision,
    COALESCE(v.inherit,true) AS inherit
  FROM employment_custom_field_objects f
  LEFT JOIN LATERAL (SELECT inherit FROM employment_custom_field_inheritance_versions
    WHERE tenant_id=f.tenant_id AND field_id=f.id ORDER BY version_no DESC LIMIT 1) v ON true
`;

async function lockSettings(tx: Tx, tenantId: string): Promise<number> {
  await tx.execute(sql`INSERT INTO employment_settings(tenant_id) VALUES(${tenantId}) ON CONFLICT DO NOTHING`);
  const [row] = rowsOf<{ revision: number }>(
    await tx.execute(sql`
    SELECT revision FROM employment_settings WHERE tenant_id=${tenantId} FOR UPDATE
  `),
  );
  return row!.revision;
}

export async function readEmploymentSettings(tx: Tx, tenantId: string) {
  const [row] = rowsOf<{ revision: number; allowDirectTransfer: boolean }>(
    await tx.execute(sql`
    SELECT s.revision,COALESCE(v.allow_direct_transfer,true) AS "allowDirectTransfer"
    FROM employment_settings s LEFT JOIN LATERAL (SELECT allow_direct_transfer
      FROM employment_setting_versions WHERE tenant_id=s.tenant_id ORDER BY version_no DESC LIMIT 1) v ON true
    WHERE s.tenant_id=${tenantId} LIMIT 1
  `),
  );
  return row ?? { revision: 0, allowDirectTransfer: true };
}
export const readSettings = readEmploymentSettings;

export async function updateSettings(tx: Tx, ctx: EmploymentContext, input: { allowDirectTransfer: boolean }) {
  if (typeof input.allowDirectTransfer !== 'boolean') throw new AppError('VALIDATION_FAILED', '调动开关必须为布尔值');
  assertRevision(ctx.expectedRevision, await lockSettings(tx, ctx.tenantId));
  const before = await readEmploymentSettings(tx, ctx.tenantId);
  const [previous] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id FROM employment_setting_versions WHERE tenant_id=${ctx.tenantId} ORDER BY version_no DESC LIMIT 1
  `),
  );
  const revision = before.revision + 1;
  await tx.execute(sql`
    INSERT INTO employment_setting_versions(tenant_id,version_no,previous_version_id,allow_direct_transfer,created_at)
    VALUES(${ctx.tenantId},${revision},${previous?.id ?? null},${input.allowDirectTransfer},${ctx.now.toISOString()})
  `);
  await tx.execute(sql`UPDATE employment_settings SET revision=${revision} WHERE tenant_id=${ctx.tenantId}`);
  const after = { revision, allowDirectTransfer: input.allowDirectTransfer };
  await auditEmployment(tx, ctx, 'employment.settings.update', 'employment_settings', ctx.tenantId, before, after);
  return after;
}

export async function createCustomField(tx: Tx, ctx: EmploymentContext, input: z.input<typeof fieldInput>) {
  const parsed = fieldInput.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '自定义字段定义不合法');
  assertRevision(ctx.expectedRevision, 0);
  await lockSettings(tx, ctx.tenantId);
  const [count] = rowsOf<{ count: number }>(
    await tx.execute(sql`
    SELECT count(*)::int AS count FROM employment_custom_field_objects
    WHERE tenant_id=${ctx.tenantId} AND object_type=${parsed.data.objectType}
  `),
  );
  // 有界读取的吞吐预算；不改变每个字段的继承规则。
  if (count!.count >= 200) throw new AppError('SERVICE_UNAVAILABLE', '自定义字段数量超出当前处理预算');
  const id = randomUUID();
  const code = `ext_${ctx.tenantId.replaceAll('-', '')}_${id.replaceAll('-', '')}`;
  const after: CustomFieldDefinition = { id, code, ...parsed.data, revision: 1, inherit: true };
  await tx.execute(sql`
    INSERT INTO employment_custom_field_objects(id,tenant_id,code,name,object_type,value_type,created_at)
    VALUES(${id},${ctx.tenantId},${code},${after.name},${after.objectType},${after.valueType},${ctx.now.toISOString()})
  `);
  await tx.execute(sql`
    INSERT INTO employment_custom_field_inheritance_versions(tenant_id,field_id,version_no,inherit,created_at)
    VALUES(${ctx.tenantId},${id},1,true,${ctx.now.toISOString()})
  `);
  await auditEmployment(tx, ctx, 'employment.custom_field.create', 'employment_custom_field', id, null, after);
  return after;
}

export async function setCustomFieldInheritance(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  input: { inherit: boolean },
) {
  if (!z.string().uuid().safeParse(id).success || typeof input.inherit !== 'boolean') {
    throw new AppError('VALIDATION_FAILED', '继承设置只能引用自定义字段');
  }
  await lockSettings(tx, ctx.tenantId);
  const [head] = rowsOf<{ revision: number }>(
    await tx.execute(sql`
    SELECT revision FROM employment_custom_field_objects WHERE tenant_id=${ctx.tenantId} AND id=${id} FOR UPDATE
  `),
  );
  if (!head) throw new AppError('NOT_FOUND', '自定义字段不存在');
  assertRevision(ctx.expectedRevision, head.revision);
  const [before] = rowsOf<CustomFieldDefinition>(
    await tx.execute(sql`
    ${fieldSelect} WHERE f.tenant_id=${ctx.tenantId} AND f.id=${id} LIMIT 1
  `),
  );
  const [previous] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id FROM employment_custom_field_inheritance_versions
    WHERE tenant_id=${ctx.tenantId} AND field_id=${id} ORDER BY version_no DESC LIMIT 1
  `),
  );
  const revision = head.revision + 1;
  await tx.execute(sql`
    INSERT INTO employment_custom_field_inheritance_versions
      (tenant_id,field_id,version_no,previous_version_id,inherit,created_at)
    VALUES(${ctx.tenantId},${id},${revision},${previous?.id ?? null},${input.inherit},${ctx.now.toISOString()})
  `);
  await tx.execute(sql`
    UPDATE employment_custom_field_objects SET revision=${revision} WHERE tenant_id=${ctx.tenantId} AND id=${id}
  `);
  const after = { ...before!, revision, inherit: input.inherit };
  await auditEmployment(tx, ctx, 'employment.custom_field.inheritance', 'employment_custom_field', id, before, after);
  return after;
}

export async function listCustomFields(
  tx: Tx,
  tenantId: string,
  page: PageQuery,
  objectType?: 'employment' | 'contract',
) {
  checkPage(page);
  return rowsOf<CustomFieldDefinition>(
    await tx.execute(sql`
    ${fieldSelect} WHERE f.tenant_id=${tenantId} ${objectType ? sql`AND f.object_type=${objectType}` : sql``}
    ORDER BY f.id LIMIT ${page.limit} OFFSET ${page.offset}
  `),
  );
}

export async function getCustomFieldsForInheritance(tx: Tx, tenantId: string): Promise<CustomFieldDefinition[]> {
  const rows = rowsOf<CustomFieldDefinition>(
    await tx.execute(sql`
    ${fieldSelect} WHERE f.tenant_id=${tenantId} AND f.object_type='employment' ORDER BY f.id LIMIT 201
  `),
  );
  if (rows.length > 200) throw new AppError('SERVICE_UNAVAILABLE', '自定义字段数量超出当前处理预算');
  return rows;
}
