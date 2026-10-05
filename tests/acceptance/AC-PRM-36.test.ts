/**
 * AC-PRM-36：任职记录可见口径（DEC-177，`11` §20 / Q-M0-67）。
 * 一条任职记录可见 ⇔ 记录所在部门在范围内，或该员工当前任职部门在范围内；“当前”按授权日，不随 asOf 回溯。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  isEmploymentRecordVisible,
  visibleEmploymentRecords,
} from '../../apps/api/src/modules/employment/visibility.js';
import { employmentRecordVisibleTo } from '../../apps/api/src/modules/employment/context.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';
import { loginEmailOf } from './AC-EMP-support.js';

const database = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00.000Z');
type Created = { id: string; revision: number; employeeRevision: number; status?: string };
type Identity = { user: string; tenant: string };

async function tenantFixture(label: string) {
  const db = database().db;
  const seed = await seedPermissionWorld(db);
  const api = tenantApi(db, { authorize: undefined, clock });
  await installApprovalFallbacks(db, seed.tenant.id, seed.admin.id);
  const setup = tenantApi(db, { clock });
  async function send(path: string, body: unknown, revision = 0, status = 201) {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...seed.asAdmin, ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as Created;
  }
  const org = (name: string) =>
    send('org/organizations', { name, establishedOn: '2025-01-01', parents: { admin: { parentId: seed.tenant.id } } });
  const inside = await org(`${label}范围内部门`);
  const outside = await org(`${label}范围外部门`);
  const outside2 = await org(`${label}范围外部门二`);
  /** 依次办理入职与调动；返回每一步的业务。 */
  type Step = { date: string; departmentId: string; mode?: 'direct' | 'application' };
  type Exit = { date: string; kind: 'leave' | 'retirement' };
  async function employee(steps: (Step | Exit)[]) {
    const person = await send('employment/employees', { code: `V_${randomUUID()}`, name: '可见口径合成员工' });
    const created: Created[] = [];
    let revision = person.revision;
    for (const [index, step] of steps.entries()) {
      // 离职 / 退休按最后工作日办理，部门沿用上一条（DEC-192 的“最后一条任职部门”）。
      const body =
        'kind' in step
          ? { kind: step.kind, mode: 'direct', lastWorkDate: step.date, fields: {} }
          : {
              kind: index === 0 ? 'hire' : 'transfer',
              mode: step.mode ?? 'direct',
              effectiveDate: step.date,
              fields: { departmentId: step.departmentId, place: `地点${index}` },
              ...(index === 0 ? { loginEmail: loginEmailOf(person.id) } : {}),
            };
      const business = await send(`employment/employees/${person.id}/businesses`, body, revision);
      revision = business.employeeRevision;
      created.push(business);
    }
    return { id: person.id, businesses: created };
  }
  const profile = await createProfile(seed, `visibility-${randomUUID().slice(0, 8)}`);
  for (const definition of [MODULE_OBJECTS.employee, MODULE_OBJECTS.employmentRecord]) {
    const response = await setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(seed, [profile.id]);
  const user = await addMember(seed, 'visibility-reader');
  expect((await grant(seed, user.id, profile.id)).status).toBe(201);
  const scope = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...seed.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const reader: Identity = { user: user.id, tenant: seed.tenant.id };
  return { db, seed, api, setup, inside, outside, outside2, employee, reader };
}

describe('AC-PRM-36 DEC-177 任职记录可见口径：记录部门 ∪ 员工当前部门', () => {
  let a: Awaited<ReturnType<typeof tenantFixture>>;
  let b: Awaited<ReturnType<typeof tenantFixture>>;
  let stayer: Awaited<ReturnType<typeof a.employee>>;
  let leaver: Awaited<ReturnType<typeof a.employee>>;
  let stranger: Awaited<ReturnType<typeof a.employee>>;
  let leftInside: Awaited<ReturnType<typeof a.employee>>;
  let retiredInside: Awaited<ReturnType<typeof a.employee>>;
  let leftOutside: Awaited<ReturnType<typeof a.employee>>;
  let pending: Created;

  beforeAll(async () => {
    a = await tenantFixture('甲');
    b = await tenantFixture('乙');
    // 当前在范围内：范围外历史（1 月）、范围内当前（9 月）、范围外未来（11 月）。
    stayer = await a.employee([
      { date: '2026-01-01', departmentId: a.outside.id },
      { date: '2026-09-01', departmentId: a.inside.id },
      { date: '2026-11-01', departmentId: a.outside2.id },
    ]);
    // 范围外部门的审批中申请（12 月）。
    const application = await a.setup.request('POST', `/api/tenant/employment/employees/${stayer.id}/businesses`, {
      ...a.seed.asAdmin,
      ifMatch: stayer.businesses.at(-1)!.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: '2026-12-01',
        fields: { departmentId: a.outside.id },
      },
    });
    expect(application.status, await application.clone().text()).toBe(201);
    const draft = (await application.json()) as Created;
    const submitted = await a.setup.request('POST', `/api/tenant/employment/businesses/${draft.id}/submit`, {
      ...a.seed.asAdmin,
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    pending = (await submitted.json()) as Created;
    // 已调出：范围内历史（1 月），9 月起调到范围外，11 月再调到另一范围外部门。
    leaver = await a.employee([
      { date: '2026-01-01', departmentId: a.inside.id },
      { date: '2026-09-01', departmentId: a.outside.id },
      { date: '2026-11-01', departmentId: a.outside2.id },
    ]);
    stranger = await a.employee([{ date: '2026-01-01', departmentId: a.outside.id }]);
    // DEC-192：离职 / 退休员工以最后一条任职部门为“当前部门”。
    leftInside = await a.employee([
      { date: '2026-01-01', departmentId: a.outside.id },
      { date: '2026-06-01', departmentId: a.inside.id },
      { date: '2026-08-31', kind: 'leave' },
    ]);
    retiredInside = await a.employee([
      { date: '2026-01-01', departmentId: a.outside.id },
      { date: '2026-06-01', departmentId: a.inside.id },
      { date: '2026-08-31', kind: 'retirement' },
    ]);
    leftOutside = await a.employee([
      { date: '2026-01-01', departmentId: a.inside.id },
      { date: '2026-06-01', departmentId: a.outside.id },
      { date: '2026-08-31', kind: 'leave' },
    ]);
  });

  const get = (path: string, as: Identity = a.reader) => a.api.request('GET', `/api/tenant/employment${path}`, as);
  async function recordIds(employeeId: string, query = '') {
    const response = await get(`/employees/${employeeId}/records${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
  }

  it('当前在范围内的员工：范围外的历史、未来与审批中记录都可见', async () => {
    const [history, current, future] = stayer.businesses.map((business) => business.id);
    expect(pending.status).toBe('in_review');
    expect(await recordIds(stayer.id)).toEqual([history, current, future]);
    for (const id of [history, current, future]) {
      expect((await get(`/records/${id}`)).status).toBe(200);
      expect((await get(`/businesses/${id}`)).status).toBe(200);
    }
    const inReview = await get(`/businesses/${pending.id}`);
    expect(inReview.status).toBe(200);
    expect(await inReview.json()).toMatchObject({ status: 'in_review', fields: { departmentId: a.outside.id } });
    // 链上一条（范围外历史）随之可见，不再被裁成 null。
    const detail = await get(`/records/${current}`);
    expect(await detail.json()).toMatchObject({
      previousRecordId: history,
      before: { fields: { departmentId: a.outside.id } },
    });
  });

  it('已调出范围的员工：只见其在范围内期间的记录；asOf 回溯也不恢复调出后的记录', async () => {
    const [inScope, movedOut, later] = leaver.businesses.map((business) => business.id);
    expect(await recordIds(leaver.id)).toEqual([inScope]);
    expect(await recordIds(leaver.id, '?asOf=2026-08-01')).toEqual([inScope]);
    expect((await get(`/records/${inScope}`)).status).toBe(200);
    expect((await get(`/businesses/${inScope}`)).status).toBe(200);
    for (const id of [movedOut, later]) {
      expect((await get(`/records/${id}`)).status).toBe(404);
      expect((await get(`/records/${id}?asOf=2026-08-01`)).status).toBe(404);
      expect((await get(`/businesses/${id}`)).status).toBe(404);
    }
  });

  it('记录部门与员工当前部门都在范围外时不可见', async () => {
    const [record] = stranger.businesses.map((business) => business.id);
    expect((await get(`/employees/${stranger.id}/records`)).status).toBe(404);
    expect((await get(`/records/${record}`)).status).toBe(404);
    expect((await get(`/businesses/${record}`)).status).toBe(404);
  });

  it('跨租户隔离：他租户的同一判定一律不可见，范围里混入他租户组织也不放行', async () => {
    const [history, current] = stayer.businesses.map((business) => business.id);
    for (const path of [`/employees/${stayer.id}/records`, `/records/${current}`, `/businesses/${history}`]) {
      expect((await a.api.request('GET', `/api/tenant/employment${path}`, b.reader)).status).toBe(404);
    }
    // 单一判定函数自身也按租户约束：员工不属于本租户时，即使范围 orgIds 被构造成包含其部门也不可见。
    const forged = {
      orgIds: [a.inside.id, a.outside.id],
      personIds: [],
      all: false,
      hasDataPermission: true,
      terms: [
        {
          dimension: 'management' as const,
          orgIds: [a.inside.id, a.outside.id],
          personIds: [],
          personQuery: { kind: 'organization' as const, tenantId: b.seed.tenant.id, asOf: '2026-10-01' },
        },
      ],
    };
    const visibleInB = await withTenant(b.db, b.seed.tenant.id, (tx) =>
      isEmploymentRecordVisible(tx, b.seed.tenant.id, forged, { employeeId: stayer.id, departmentId: a.inside.id }),
    );
    expect(visibleInB).toBe(false);
    const visibleInA = await withTenant(a.db, a.seed.tenant.id, (tx) =>
      isEmploymentRecordVisible(tx, a.seed.tenant.id, forged, { employeeId: stayer.id, departmentId: a.inside.id }),
    );
    expect(visibleInA).toBe(true);
  });
  it('DEC-192：离职 / 退休员工最后一条任职部门在范围内时整链可见，在范围外时只见范围内期间', async () => {
    for (const person of [leftInside, retiredInside]) {
      const ids = person.businesses.map((business) => business.id);
      expect(await recordIds(person.id)).toEqual(ids);
      for (const id of ids) expect((await get(`/records/${id}`)).status).toBe(200);
    }
    const [inScope, movedOut, left] = leftOutside.businesses.map((business) => business.id);
    expect(await recordIds(leftOutside.id)).toEqual([inScope]);
    for (const id of [movedOut, left]) expect((await get(`/records/${id}`)).status).toBe(404);
  });

  it('P2-1：看全部范围与可信系统调用同样校验员工属于本租户；不存在的员工不可见', async () => {
    const all = { orgIds: [], personIds: [], all: true, hasDataPermission: true, terms: [] };
    const [history] = stayer.businesses.map((business) => business.id);
    const foreign = { employeeId: stayer.id, departmentId: a.inside.id };
    const missing = { employeeId: randomUUID(), departmentId: a.inside.id };
    const own = (await b.employee([{ date: '2026-01-01', departmentId: b.inside.id }])).id;
    const local = { employeeId: own, departmentId: b.inside.id };
    const tenantB = b.seed.tenant.id;
    await withTenant(b.db, tenantB, async (tx) => {
      for (const scope of [all, undefined]) {
        expect(await isEmploymentRecordVisible(tx, tenantB, scope, foreign)).toBe(false);
        expect(await isEmploymentRecordVisible(tx, tenantB, scope, missing)).toBe(false);
        expect(await isEmploymentRecordVisible(tx, tenantB, scope, local)).toBe(true);
        expect(await visibleEmploymentRecords(tx, tenantB, scope, [foreign, local, missing])).toEqual([
          false,
          true,
          false,
        ]);
        const ctx = { tenantId: tenantB, userId: b.reader.user, scope } as unknown as EmploymentContext;
        expect(await employmentRecordVisibleTo(tx, ctx, stayer.id, a.inside.id, history)).toBe(false);
        expect(await employmentRecordVisibleTo(tx, ctx, own, b.inside.id)).toBe(true);
      }
    });
  });

  it('P3-1：“使用用户”范围下本人创建的前驱照常显示，他人创建的前驱仍裁成 null', async () => {
    const c = await tenantFixture('丙');
    const objectCode = MODULE_OBJECTS.employmentRecord.code;
    const policy = await c.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${objectCode}/entity/${objectCode}`,
      { ...c.seed.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    const person = await c.employee([{ date: '2026-01-01', departmentId: c.inside.id }]);
    const create = async (date: string, revision: number) => {
      const response = await c.setup.request('POST', `/api/tenant/employment/employees/${person.id}/businesses`, {
        ...c.reader,
        ifMatch: revision,
        body: { kind: 'transfer', mode: 'direct', effectiveDate: date, fields: { departmentId: c.inside.id } },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as Created;
    };
    const first = await create('2026-03-01', person.businesses[0]!.employeeRevision);
    const second = await create('2026-06-01', first.employeeRevision);
    const read = async (id: string) =>
      (await (await c.api.request('GET', `/api/tenant/employment/records/${id}`, c.reader)).json()) as {
        previousRecordId: string | null;
        before: unknown;
      };
    expect(await read(second.id)).toMatchObject({ previousRecordId: first.id, before: { fields: expect.any(Object) } });
    expect(await read(first.id)).toMatchObject({ previousRecordId: null, before: null });
  });
});
