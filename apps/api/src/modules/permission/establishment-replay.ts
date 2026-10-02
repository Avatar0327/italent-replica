/** 编制命令可能联动上级/后续周期或复制新对象，重放也必须重验完整写入足迹。 */
import { sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { AppError } from '../../errors.js';
import type { BusinessContext } from '../job/context.js';
import { authorizeInTransaction } from './module-access.js';
import { visible, writeFields, type ModuleScope } from './module-route-access.js';

interface Event {
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  orgId: string | null;
  creatorId: string | null;
}
const CHANGED_FIELDS = [
  'localCapacity',
  'inclusiveCapacity',
  'reservedLocal',
  'reservedInclusive',
  'strictControl',
  'subdivisions',
];
const COPY_FIELDS = ['orgId', 'schemeId', 'periodStart', ...CHANGED_FIELDS];
const MAX_FOOTPRINTS = 20_000;

export async function authorizeEstablishmentReplay(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  scope: ModuleScope,
  commandId: string,
  copyExecution: boolean,
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT a.action,a.before,a.after,o.org_id AS "orgId",
      (SELECT original.actor_user_id FROM audit_events original
       WHERE original.tenant_id=a.tenant_id AND original.object_id=a.object_id
         AND original.action='establishment.capacity.create'
       ORDER BY original.occurred_at,original.id LIMIT 1) AS "creatorId"
    FROM audit_events a LEFT JOIN establishment_objects o
      ON o.tenant_id=a.tenant_id AND o.id::text=a.object_id
    WHERE a.tenant_id=${ctx.tenantId} AND a.command_id=${commandId}
      AND a.object_type='establishment-capacity'
    LIMIT ${MAX_FOOTPRINTS + 1}
  `);
  const events = (Array.isArray(result) ? result : (result as { rows: Event[] }).rows) as Event[];
  if (events.length > MAX_FOOTPRINTS) throw new AppError('PAYLOAD_TOO_LARGE', '编制命令足迹超过校验上限');
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  for (const event of events) {
    visible(scope, event.orgId ?? undefined, '编制在该时点不存在', event.creatorId);
    if (typeof event.after.orgId === 'string') visible(scope, event.after.orgId, '编制在该时点不存在', event.creatorId);
    const create = event.action === 'establishment.capacity.create';
    const fields = create
      ? copyExecution
        ? COPY_FIELDS.filter((key) => event.after[key] !== null)
        : []
      : CHANGED_FIELDS.filter((key) => JSON.stringify(event.before?.[key]) !== JSON.stringify(event.after[key]));
    await writeFields(bound, ctx, MODULE_OBJECTS.establishment.code, create ? 'create' : 'update', {
      ...Object.fromEntries(fields.map((key) => [key, event.after[key]])),
      ...(fields.length ? { effectiveDate: event.after.startDate } : {}),
    });
  }
}
