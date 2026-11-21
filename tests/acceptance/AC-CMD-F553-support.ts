import { randomUUID } from 'node:crypto';
import { and, eq, offers, sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { runWithAuditRequest } from '../../apps/api/src/audit/request-context.js';
import { lockPendingEntry } from '../../apps/api/src/modules/employment/employee-status.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { ensureOfferSignSource } from '../../apps/api/src/modules/esign/offer-source.js';
import { runSourceSignCommand } from '../../apps/api/src/modules/esign/source-initiation.js';
import { provisionEmployeeUser } from '../../apps/api/src/modules/permission/user-provisioning.js';
import { employmentSession, loginEmailOf } from './AC-EMP-support.js';
import { START, type Scene } from './AC-ESIGN-F505-s2-support.js';
import { controlledApi } from './AC-LNK-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const SOURCE_OBJECT = { offer: 'TenantBase.Offer', entry: 'TenantBase.EmploymentRecord' } as const;
export const RESULT_ROUTE = 'GET /api/tenant/commands/:commandId/result';
export const resultPath = (key: string) => `/api/tenant/commands/${key}/result`;
export const startPath = (scene: Scene, id: string) =>
  scene === 'offer'
    ? `/api/tenant/offers/${id}/esign-tasks`
    : `/api/tenant/employment/pending-entries/${id}/esign-tasks`;

export async function resultWorld(db: Db, scene: Scene, templateBody = 'ZZ_F553_正文 {员工姓名}') {
  const session = await employmentSession(db, `ZZ_F553_${scene}`);
  session.setNow(START.toISOString());
  const { tenant, user } = session;
  const { id: tenantId, timezone, name: tenantName } = tenant;
  const userId = user.id;
  const department = await session.org('ZZ_F553_录用部门', { establishedOn: '2026-01-01' });
  const person = await session.employee('ZZ_F553_人员姓名', `ZZ_F553_${uniqueSuffix()}`);
  const entry = await withTenant(db, tenantId, async (tx) => {
    const context = {
      tenantId,
      userId,
      timezone,
      now: START,
      commandId: uniqueSuffix(),
      expectedRevision: person.revision,
    };
    await provisionEmployeeUser(tx, context, {
      employeeId: person.id,
      loginEmail: loginEmailOf(person.id),
      displayName: person.name,
      accountRequired: true,
    });
    return createEmploymentBusiness(
      tx,
      context,
      person.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-11-01', fields: { departmentId: department.id } },
      { systemInput: true, entry: { pendingEntry: true } },
    );
  });
  const as = { user: userId, tenant: tenantId };
  const initial = { tenantId, userId, timezone, tenantName, now: START };
  const api = tenantApi(db, { clock: () => START });
  const key = uniqueSuffix();
  const makeOffer = async () => {
    const id = randomUUID();
    await withTenant(db, tenantId, async (tx) => {
      await tx.insert(offers).values({
        id,
        tenantId,
        entry: 'offer',
        name: 'ZZ_F553_候选人',
        personalEmail: `f553-${uniqueSuffix()}@example.com`,
        status: 'accepted',
        acceptTime: sql`${START.toISOString()}::timestamptz`,
        createdBy: userId,
        departmentId: department.id,
        linkedEmployeeId: person.id,
      });
      await ensureOfferSignSource(tx, { ...initial, commandId: uniqueSuffix() }, id);
    });
    return id;
  };
  const sourceId = scene === 'offer' ? await makeOffer() : entry.id;
  const expectedRevision = scene === 'offer' ? 1 : entry.revision;
  const context = { ...initial, expectedRevision, commandId: '' };
  const path = startPath(scene, sourceId);
  const template = await json<{ id: string }>(
    await api.request('POST', '/api/tenant/esign/templates', {
      ...as,
      body: { code: uniqueSuffix(), name: 'ZZ_F553_模板名', body: templateBody },
    }),
    201,
  );
  // S4/S5 尚无发起路由。用真实 S2 命令服务写台账，由请求上下文按设计 §8 的路径产生 commandType。
  const outcome = await runWithAuditRequest({ method: 'POST', path, clock: () => START }, () =>
    runSourceSignCommand(db, { authorize: allowAll, clock: () => START }, context, {
      commandId: key,
      scene,
      sourceId,
      templateIds: [template.id],
      authorizeSource: async () => {},
      lockSource: async (tx) => {
        if (scene === 'entry') {
          const { business } = await lockPendingEntry(tx, context, sourceId);
          return { employeeId: person.id, ownerDepartmentId: department.id, revision: business.revision };
        }
        const [source] = await tx
          .select({ revision: offers.revision })
          .from(offers)
          .where(and(eq(offers.tenantId, tenantId), eq(offers.id, sourceId)))
          .for('update');
        expect(source).toBeDefined();
        return { employeeId: person.id, ownerDepartmentId: department.id, revision: source!.revision };
      },
    }),
  );
  expect(outcome.status).toBe(201);
  const receipt = outcome.body as { sourceId: string; taskId: string };
  const query = resultPath(key);
  const call = (grants: Parameters<typeof controlledApi>[3] = {}) =>
    controlledApi(db, tenantId, userId, grants, START.toISOString())('GET', query);
  return {
    api,
    as,
    asContext: context,
    call,
    db,
    department,
    entry,
    key,
    makeOffer,
    path,
    person,
    query,
    receipt,
    session,
    sourceId,
    templateId: template.id,
    tenantId,
    userId,
  };
}

export async function expectHidden(response: Response, statuses: readonly number[]) {
  expect(statuses).toContain(response.status);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
  expect(body).not.toMatch(/ZZ_F553_|sourceId|taskId|httpStatus|completedAt|businessId|succeeded/);
}
