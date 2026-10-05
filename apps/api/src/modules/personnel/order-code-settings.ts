import { auditEvents, sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { auditActor } from '../../system-actor.js';
import { assertRevision, rows, type PersonnelContext } from './store.js';

export const orderSettingsInput = z
  .object({
    enabled: z.boolean(),
    items: z
      .array(
        z
          .object({
            field: z.enum(['department', 'post', 'position', 'level', 'grade', 'code']),
            direction: z.enum(['asc', 'desc']),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(6)
      .refine((items) => new Set(items.map((i) => i.field)).size === items.length, '规则项不得重复'),
  })
  .strict();
export type OrderSettings = z.infer<typeof orderSettingsInput> & { revision: number };
// DEC-171：未配置租户没有默认规则；不得把参考租户的配置当作出厂值。
export async function readOrderSettings(tx: Tx, tenantId: string): Promise<OrderSettings> {
  const [config] = rows<{ enabled: boolean; revision: number }>(
    await tx.execute(sql`
    SELECT enabled,revision FROM personnel_order_settings WHERE tenant_id=${tenantId}`),
  );
  if (!config || config.revision === 0) return { revision: 0, enabled: false, items: [] };
  const items = rows<OrderSettings['items'][number]>(
    await tx.execute(sql`
    SELECT field,direction,enabled FROM personnel_order_rules WHERE tenant_id=${tenantId} ORDER BY position`),
  );
  return { ...config, items };
}
/** 只串行本模块配置 / 投影写入；不取业务或审批实例锁，不形成员工→业务→实例的反向等待。 */
export async function lockOrderSettings(tx: Tx, tenantId: string) {
  await tx.execute(
    sql`INSERT INTO personnel_order_settings(tenant_id,enabled) VALUES (${tenantId},false) ON CONFLICT DO NOTHING`,
  );
  await tx.execute(sql`SELECT tenant_id FROM personnel_order_settings WHERE tenant_id=${tenantId} FOR UPDATE`);
  return readOrderSettings(tx, tenantId);
}
export async function saveOrderSettings(tx: Tx, ctx: PersonnelContext, input: z.infer<typeof orderSettingsInput>) {
  const before = await lockOrderSettings(tx, ctx.tenantId);
  assertRevision(ctx.expectedRevision, before.revision);
  const after = { ...input, revision: before.revision + 1 };
  await tx.execute(sql`UPDATE personnel_order_settings SET enabled=${input.enabled},revision=${after.revision}
    WHERE tenant_id=${ctx.tenantId}`);
  await tx.execute(sql`DELETE FROM personnel_order_rules WHERE tenant_id=${ctx.tenantId}`);
  for (const [position, item] of input.items.entries()) {
    await tx.execute(sql`INSERT INTO personnel_order_rules(tenant_id,field,position,direction,enabled)
      VALUES (${ctx.tenantId},${item.field},${position},${item.direction},${item.enabled})`);
  }
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: 'personnel.order.settings',
    objectType: 'personnel-order-settings',
    objectId: ctx.tenantId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  return after;
}
