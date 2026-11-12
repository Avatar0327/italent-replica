import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import type { JobGraphInput, JobGraphRecord } from '@italent/domain';
import { seedTenantWithMember, tenantApi } from './tenant-api.js';

export const GRAPH = '/api/tenant/job/graph';
export const GRAPH_CODE = 'TenantBase.JobPostAndJobLevelGraph';
export const GRAPH_NOW = new Date('2026-11-12T02:30:00Z');
export const graphFields = {
  JobGrade: ['id', 'name', 'enabled', 'startDate', 'stopDate', 'grade'],
  JobLevelType: ['id', 'name', 'enabled', 'startDate', 'stopDate'],
  JobLevel: ['id', 'name', 'enabled', 'startDate', 'stopDate', 'levelTypeId', 'minGradeId', 'maxGradeId'],
  JobSequence: ['id', 'name', 'enabled', 'startDate', 'stopDate', 'parentId'],
  JobPost: [
    'id',
    'name',
    'enabled',
    'startDate',
    'stopDate',
    'sequenceId',
    'minLevelId',
    'maxLevelId',
    'displayOrder',
    'code',
  ],
};
export const record = (id: string, fields: Partial<JobGraphRecord> = {}): JobGraphRecord => ({
  id,
  name: id,
  enabled: true,
  startDate: '2026-01-01',
  stopDate: '9999-12-31',
  ...fields,
});
export function graphInput(): JobGraphInput {
  return {
    grades: [record('g1', { grade: 1 }), record('g2', { grade: 2 }), record('g3', { grade: 3 })],
    levelTypes: [record('t')],
    levels: [record('l', { levelTypeId: 't', minGradeId: 'g1', maxGradeId: 'g2' })],
    sequences: [record('s'), record('child', { parentId: 's' })],
    posts: [record('p', { sequenceId: 'child', minLevelId: 'l', code: 'P', displayOrder: 1 })],
  };
}
const tables = {
  grades: 'grade',
  levelTypes: 'level_type',
  levels: 'level',
  sequences: 'sequence',
  posts: 'post',
} as const;
export async function seedGraph(db: Db, tenantId: string, input = graphInput()) {
  const ids = new Map(
    Object.values(input)
      .flat()
      .map((row) => [row.id, randomUUID()]),
  );
  await withTenant(db, tenantId, async (tx) => {
    for (const [kind, stem] of Object.entries(tables)) {
      for (const row of input[kind as keyof JobGraphInput]) {
        const id = ids.get(row.id)!;
        await tx.execute(sql`INSERT INTO ${sql.identifier(`job_${stem}_objects`)} (id, tenant_id)
          VALUES (${id}, ${tenantId})`);
        const values: Record<string, unknown> = {
          ...row,
          id: randomUUID(),
          objectId: id,
          tenantId,
          versionNo: 1,
          code: row.code ?? row.id,
        };
        for (const key of Object.keys(values)) {
          if (key.endsWith('Id') && typeof values[key] === 'string' && ids.has(values[key] as string))
            values[key] = ids.get(values[key] as string);
        }
        const columns = Object.keys(values).map((key) =>
          sql.identifier(key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)),
        );
        await tx.execute(sql`INSERT INTO ${sql.identifier(`job_${stem}_versions`)}
          (${sql.join(columns, sql`,`)}) VALUES (${sql.join(
            Object.values(values).map((v) => sql`${v}`),
            sql`,`,
          )})`);
      }
    }
  });
  return ids;
}
export async function graphWorld(db: Db, input = graphInput()) {
  const { tenant, user } = await seedTenantWithMember(db, 'jobgraph', 'America/Chicago');
  await seedGraph(db, tenant.id, input);
  const api = tenantApi(db, { clock: () => GRAPH_NOW });
  const as = { tenant: tenant.id, user: user.id };
  return {
    tenant,
    user,
    api,
    as,
    rebuild: (ifMatch = 0, idempotencyKey = randomUUID()) =>
      api.request('POST', `${GRAPH}/rebuild`, { ...as, ifMatch, idempotencyKey, body: {} }),
  };
}
