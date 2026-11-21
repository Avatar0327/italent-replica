import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { bootstrapTenantAdmin } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS, ORG_ADJUSTMENT_FORM_FIELDS, type ObjectDefinition } from '@italent/domain';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { newOrg, rename, stop } from '../../../tests/acceptance/AC-OA-items-support.js';
import { approvalWorld } from '../../../tests/acceptance/AC-APV-support.js';
import {
  createProfile,
  grant,
  makeGrantable,
  setObjectPermission,
  type PermissionWorld,
} from '../../../tests/acceptance/AC-PRM-support.js';
import { cmd, tenantApi } from '../../../tests/acceptance/support/tenant-api.js';
import {
  candidate,
  CHANGE,
  CONTENT,
  EFFECTIVE,
  EMPTY,
  FULL,
  NEW,
  NOTE,
  PARTIAL,
  ROOT,
  STOP,
} from './fer2e1-scenarios.js';

const BASE = '/api/tenant/org-adjustment/adjustments';
const NOW = '2026-10-01T17:30:00.000Z';

async function expectResponse(response: Promise<Response>, status: number) {
  const result = await response;
  if (result.status !== status) throw new Error(`FE-R2e1 fixture ${status}: ${result.status} ${await result.text()}`);
  return result;
}

async function capacity(db: Db, tenant: string, org: string) {
  const scheme = randomUUID();
  const object = randomUUID();
  await withTenant(db, tenant, async (tx) => {
    await tx.execute(sql`INSERT INTO establishment_scheme_objects (id, tenant_id) VALUES (${scheme}, ${tenant})`);
    await tx.execute(sql`INSERT INTO establishment_scheme_versions
      (tenant_id, scheme_id, version_no, code, name, cycle, maintenance_mode, enabled, start_date)
      VALUES (${tenant}, ${scheme}, 1, 'ZZ_FER2E1_SCHEME', 'ZZ_FER2E1_方案', 'annual', 'inclusive', true, '2020-01-01')`);
    await tx.execute(sql`INSERT INTO establishment_objects (id, tenant_id, org_id, scheme_id, period_start, period_end)
      VALUES (${object}, ${tenant}, ${org}, ${scheme}, '2026-01-01', '2026-12-31')`);
    await tx.execute(sql`INSERT INTO establishment_versions
      (tenant_id, object_id, version_no, start_date, inclusive_capacity)
      VALUES (${tenant}, ${object}, 1, '2026-01-01', 7)`);
  });
}

async function profile(world: PermissionWorld, user: string, mode: 'writer' | 'reader' | 'no-scope') {
  const p = await createProfile(world, `ZZ_FER2E1_${mode}`);
  const write = mode === 'writer';
  async function permit(object: ObjectDefinition) {
    const view = (code: string) => mode !== 'reader' || !['content', 'adjustmentRange', 'orgItems.code'].includes(code);
    await expectResponse(
      setObjectPermission(
        world,
        p,
        {
          dataOperations: { create: write, update: write, delete: false },
          fields: object.fields.map(({ code, system }) => ({
            fieldCode: code,
            view: view(code),
            edit: write && !system,
          })),
          buttons: write ? object.buttons.map(({ code, level }) => ({ buttonCode: code, level })) : [],
        },
        object.code,
      ),
      200,
    );
  }
  await permit(MODULE_OBJECTS.organization);
  await permit(MODULE_OBJECTS.orgAdjustment);
  if (write) await permit(MODULE_OBJECTS.orgAdjustmentDetail);
  if (mode !== 'no-scope') {
    await expectResponse(
      world.api.request('PUT', `/api/tenant/permission/profiles/${p.id}/data-scopes/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'app', targetCode: '', seeAll: true },
      }),
      200,
    );
  }
  await makeGrantable(world, [p.id]);
  await expectResponse(grant(world, user, p.id), 201);
}

async function seedPermissions(w: Awaited<ReturnType<typeof approvalWorld>>, reader: string, outside: string) {
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const identity = w.as(w.hr.id);
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
  const permissions = { db: w.db, tenant: w.tenant, admin: w.hr, adminRecord, api, asAdmin: identity };
  await profile(permissions, w.hr.id, 'writer');
  await profile(permissions, reader, 'reader');
  await profile(permissions, outside, 'no-scope');

  return { api, identity };
}

async function seedPartialResult(db: Db, tenant: string, id: string) {
  // 读侧样本模拟部分执行失败后的持久化结果。
  await withTenant(db, tenant, (tx) =>
    tx.execute(sql`
    UPDATE org_adjustments SET approval_status = 2, execution_status = 2,
      success_count = 2, failure_count = 1, execution_note = ${NOTE} WHERE id = ${id}
  `),
  );
}

async function seed(db: Db) {
  const w = await approvalWorld(db, 'ZZ_FER2E1');
  w.setNow(NOW);
  const root = await w.org(ROOT);
  const deactivated = await w.org(STOP, root);
  const changed = await w.org('ZZ_FER2E1_旧名', root);
  await capacity(db, w.tenant.id, root);
  const candidates: string[] = [];
  for (let i = 1; i <= 21; i++) candidates.push(await w.org(candidate(i)));
  const approver = await w.person('ZZ_FER2E1_审批人', root);
  await w.setOrgRoles(root, { hrbp: approver.employeeId });
  await w.publishedProcess({
    approvalType: 'org_adjustment',
    code: 'ZZ_FER2E1_PROCESS',
    name: 'ZZ_FER2E1_审批',
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'OrganizationProcess' }] },
    nodes: [
      {
        key: 'n1',
        approver: { type: 'object_field', value: 'approval_subject_org_hrbp' },
        formFields: [...ORG_ADJUSTMENT_FORM_FIELDS],
      },
    ],
  });
  const reader = await w.member('ZZ_FER2E1_只读');
  const outside = await w.member('ZZ_FER2E1_无范围');
  const { api, identity } = await seedPermissions(w, reader, outside);

  const draft = async (subject: string, org: string) =>
    (
      await expectResponse(
        api.request('POST', BASE, {
          ...identity,
          ifMatch: 0,
          body: {
            subject,
            approvalSubjectOrgId: org,
            adjustmentRange: [org],
            effectiveDate: EFFECTIVE,
            content: CONTENT,
          },
        }),
        201,
      )
    ).json() as Promise<{ id: string; revision: number }>;
  const populated = await draft(FULL, root);
  let revision = populated.revision;
  for (const body of [
    newOrg(root, { name: NEW, code: 'ZZ_FER2E1_NEW' }),
    rename(changed, { name: CHANGE }),
    stop(deactivated),
  ]) {
    const result = await expectResponse(
      api.request('POST', `${BASE}/${populated.id}/org-items`, {
        ...identity,
        ifMatch: revision,
        body,
      }),
      201,
    );
    revision = ((await result.json()) as { revision: number }).revision;
  }
  await expectResponse(
    api.request('POST', `${BASE}/${populated.id}/submit`, { ...identity, ifMatch: revision, body: {} }),
    200,
  );
  const empty = await draft(EMPTY, candidates[0]!);
  const partial = await draft(PARTIAL, candidates[1]!);
  await seedPartialResult(db, w.tenant.id, partial.id);
  return {
    api,
    tenant: w.tenant.id,
    writer: w.hr.id,
    reader,
    outside,
    approver: approver.userId,
    root,
    populated: populated.id,
    empty: empty.id,
  };
}

export async function startAdjustmentBackend() {
  const handle = await createTestDb();
  try {
    const { api, ...data } = await seed(handle.db);
    const valid = [data.writer, data.reader, data.outside, data.approver];
    const server = createServer(async (req, res) => {
      const user = String(req.headers['x-fer2e1-user'] ?? '');
      if (!valid.includes(user) || req.headers['x-tenant-id'] !== data.tenant || !req.url?.startsWith('/api/tenant/')) {
        res.writeHead(403).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const headers = Object.fromEntries(
          ['if-match', 'idempotency-key'].flatMap((key) =>
            typeof req.headers[key] === 'string' ? [[key, req.headers[key]]] : [],
          ),
        );
        const response = await api.request(req.method!, req.url, {
          user,
          tenant: data.tenant,
          headers,
          idempotencyKey: null,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      manifest: { ...data, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
