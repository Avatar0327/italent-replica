import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { rowsOf } from '../employment/record-store.js';
import type { BusinessContext } from '../job/context.js';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';
import { lockIntegrationPoolTaskForAttachment } from './integration-pool.js';
import { schemeMissing } from './integration-schemes-access.js';
import type { SchemeInput } from './integration-schemes-input.js';

const uuidList = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

async function requireReferences(tx: Tx, ids: readonly string[] | undefined, query: (ids: readonly string[]) => SQL) {
  if (!ids?.length) return;
  const distinct = [...new Set(ids)];
  const rows = rowsOf<unknown>(await tx.execute(query(distinct)));
  if (rows.length !== distinct.length) throw schemeMissing();
}

export async function validateSchemeReferences(tx: Tx, ctx: BusinessContext, scope: ModuleScope, input: SchemeInput) {
  const { tenantId } = ctx;
  const { employmentForm, employmentType, postId, sequenceId, contractCompanyId } = input.conditions;
  const { failureRecipientId, orgIds } = input;
  const holders = input.stages.flatMap(({ tasks }) => tasks.map(({ assignee }) => assignee));
  const idsOf = (type: 'member' | 'position' | 'post' | 'identity') =>
    holders.flatMap((assignee) => (assignee.type === type ? [assignee.id] : []));
  const catalog =
    (table: string, filter = sql`true`) =>
    (ids: readonly string[]) => sql`
    SELECT id FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}
      AND id = ANY(${uuidList(ids)}) AND ${filter}`;

  await requireReferences(tx, orgIds, catalog('org_objects'));
  await requireReferences(
    tx,
    employmentForm,
    (ids) =>
      sql`SELECT code FROM employment_forms WHERE tenant_id = ${tenantId} AND code IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
  );
  await requireReferences(tx, employmentType, catalog('employment_types', sql`deleted_at IS NULL`));
  await requireReferences(tx, [...(postId ?? []), ...idsOf('post')], catalog('job_post_objects'));
  await requireReferences(tx, sequenceId, catalog('job_sequence_objects'));
  await requireReferences(tx, contractCompanyId, catalog('contract_companies'));
  await requireReferences(tx, idsOf('identity'), catalog('permission_profiles'));

  const members = [...idsOf('member'), ...(failureRecipientId ? [failureRecipientId] : [])];
  await requireReferences(
    tx,
    members,
    (ids) => sql`SELECT user_id FROM tenant_memberships
    WHERE tenant_id = ${tenantId} AND user_id = ANY(${uuidList(ids)}) AND status = 'active' FOR SHARE`,
  );

  const today = tenantLocalDate(ctx.now, ctx.timezone);
  await requireReferences(
    tx,
    idsOf('position'),
    (ids) => sql`
    SELECT p.object_id FROM (
      SELECT DISTINCT ON (object_id) object_id, org_id, stop_date FROM job_position_versions
      WHERE tenant_id = ${tenantId} AND object_id = ANY(${uuidList(ids)}) AND start_date <= ${today}
      ORDER BY object_id, start_date DESC, version_no DESC
    ) p WHERE p.stop_date >= ${today} AND ${scopeSql(scope, { org: sql`p.org_id` })}`,
  );

  // 与任务池修改、删除共用同一行锁。固定顺序避免同一批定义反向取得锁。
  const poolIds = new Set(input.stages.flatMap(({ tasks }) => tasks.map(({ poolTaskId }) => poolTaskId)));
  for (const id of [...poolIds].sort()) await lockIntegrationPoolTaskForAttachment(tx, tenantId, id);
}
