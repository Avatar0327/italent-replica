import { randomUUID } from 'node:crypto';
import { AppError } from '@italent/api';
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import type { JobRecord, JobSession } from './AC-JOB-support.js';

export interface JobWriteContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

export interface JobIncumbent {
  readonly employeeId: string;
  readonly assignmentId: string;
  readonly revision: number;
  readonly directManagerId: string | null;
}

export interface ManagerChange extends JobIncumbent {
  readonly expectedRevision: number;
  readonly effectiveDate: string;
}

export interface JobPersonnelGateway {
  listIncumbents(
    tx: Tx,
    query: { tenantId: string; positionId: string; asOf: string },
  ): Promise<readonly JobIncumbent[]>;
  appendManagerVersion(tx: Tx, ctx: JobWriteContext, change: Omit<ManagerChange, 'revision'>): Promise<void>;
}

interface JobWriteService {
  updateJobObject(
    tx: Tx,
    ctx: JobWriteContext,
    kind: string,
    id: string,
    patch: Record<string, unknown>,
    personnel?: JobPersonnelGateway,
  ): Promise<JobRecord>;
}

interface AssignmentVersion extends JobIncumbent {
  readonly id: string;
  readonly tenantId: string;
  readonly positionId: string;
  readonly effectiveDate: string;
  readonly previousVersionId: string | null;
}

export function jobWriteContext(session: JobSession, expectedRevision: number): JobWriteContext {
  return {
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date('2026-10-01T01:00:00.000Z'),
    commandId: randomUUID(),
    expectedRevision,
  };
}

// 动态路径让首次验收失败来自尚不存在的 HTTP 行为，成功建好对象后才装配服务端人员端口。
export async function loadJobWriteService(): Promise<JobWriteService> {
  const servicePath = '../../apps/api/src/modules/job/write-service.js';
  return (await import(servicePath)) as JobWriteService;
}

/** 任职模块尚未落地；测试夹具采用真实租户 RLS 与不可覆盖的版本行验证服务端联动端口。 */
export async function installJobPersonnelFixture(db: Db): Promise<void> {
  await db.execute(sql`CREATE TABLE job_test_assignment_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    position_id uuid NOT NULL,
    revision integer NOT NULL,
    direct_manager_id uuid,
    effective_date date NOT NULL,
    previous_version_id uuid,
    UNIQUE (tenant_id, assignment_id, revision)
  )`);
  await db.execute(sql`SELECT enable_tenant_isolation('job_test_assignment_versions')`);
  await db.execute(sql`GRANT SELECT, INSERT ON job_test_assignment_versions TO app_user`);
}

export async function seedIncumbent(
  db: Db,
  session: JobSession,
  positionId: string,
  directManagerId: string | null = null,
): Promise<JobIncumbent> {
  const assignmentId = randomUUID();
  const employeeId = randomUUID();
  await withTenant(db, session.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO job_test_assignment_versions
      (tenant_id, assignment_id, employee_id, position_id, revision, direct_manager_id, effective_date)
      VALUES (${session.tenant.id}, ${assignmentId}, ${employeeId}, ${positionId}, 1,
        ${directManagerId}, '2026-10-01')`),
  );
  return { assignmentId, employeeId, revision: 1, directManagerId };
}

export function resultRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

export async function assignmentVersions(db: Db, tenantId: string, assignmentId: string): Promise<AssignmentVersion[]> {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<AssignmentVersion>(
      await tx.execute(sql`SELECT id, tenant_id AS "tenantId", assignment_id AS "assignmentId",
        employee_id AS "employeeId", position_id AS "positionId", revision,
        direct_manager_id AS "directManagerId", effective_date AS "effectiveDate",
        previous_version_id AS "previousVersionId"
        FROM job_test_assignment_versions WHERE assignment_id = ${assignmentId} ORDER BY revision`),
    ),
  );
}

export function personnelFixtureGateway(observedTransactions: Tx[] = []): JobPersonnelGateway {
  return {
    async listIncumbents(tx, query) {
      observedTransactions.push(tx);
      return resultRows<JobIncumbent>(
        await tx.execute(sql`SELECT "assignmentId", "employeeId", revision, "directManagerId" FROM (
          SELECT DISTINCT ON (assignment_id) assignment_id AS "assignmentId", employee_id AS "employeeId",
            position_id AS "positionId", revision, direct_manager_id AS "directManagerId"
          FROM job_test_assignment_versions
          WHERE tenant_id = ${query.tenantId} AND effective_date <= ${query.asOf}
          ORDER BY assignment_id, effective_date DESC, revision DESC
        ) current_assignments WHERE "positionId" = ${query.positionId}`),
      );
    },
    async appendManagerVersion(tx, ctx, change) {
      observedTransactions.push(tx);
      const [previous] = resultRows<{ id: string; positionId: string; revision: number }>(
        await tx.execute(sql`SELECT id, position_id AS "positionId", revision FROM job_test_assignment_versions
          WHERE assignment_id = ${change.assignmentId} ORDER BY revision DESC LIMIT 1`),
      );
      if (!previous || previous.revision !== change.expectedRevision) {
        throw new AppError('REVISION_CONFLICT', '任职版本已变化');
      }
      await tx.execute(sql`INSERT INTO job_test_assignment_versions
        (tenant_id, assignment_id, employee_id, position_id, revision, direct_manager_id,
          effective_date, previous_version_id)
        VALUES (${ctx.tenantId}, ${change.assignmentId}, ${change.employeeId}, ${previous.positionId},
          ${previous.revision + 1}, ${change.directManagerId}, ${change.effectiveDate}, ${previous.id})`);
    },
  };
}
