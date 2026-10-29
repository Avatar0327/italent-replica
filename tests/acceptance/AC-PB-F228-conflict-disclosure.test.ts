/** F-228 / AC-PB-03：真实授权器下互斥错误与逐人回执按当前查看权披露。 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assessmentWorld, type AssessmentWorld } from './AC-PB-BE15b1-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const BASE = '/api/tenant/employment';
const assessment = MODULE_OBJECTS.probationAssessment;
const reason = 'PROBATION_PROCESS_IN_REVIEW';
type Conflict = { code: string; message: string; details: { reason: string; process: string; assessmentId?: string } };
type Receipt = { total: number; failed: number; succeeded: number; items: { error: Conflict }[] };

async function operator(w: AssessmentWorld, actor?: string) {
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const asAdmin = { user: w.hr.id, tenant: w.tenant.id };
  const seed = { db: w.db, tenant: w.tenant, admin: w.hr, adminRecord, api, asAdmin };
  const user = actor ?? (await w.member('合成经办人'));
  const profile = await createProfile(seed, `f228-${randomUUID()}`);
  const employment = MODULE_OBJECTS.employmentRecord;
  expect(
    (
      await setObjectPermission(
        seed,
        profile,
        {
          dataOperations: { create: true, update: true, delete: false },
          fields: employment.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
          buttons: employment.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        employment.code,
      )
    ).status,
  ).toBe(200);
  async function fields(visible: readonly string[], create = false) {
    const response = await setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create, update: false, delete: false },
        fields: assessment.fields.map((f) => ({
          fieldCode: f.code,
          view: visible.includes(f.code),
          edit: create && !f.system && visible.includes(f.code),
        })),
        buttons: create ? [{ buttonCode: 'Assessment.Create', level: 'detail' }] : [],
      },
      assessment.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await fields([]);
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, user, profile.id)).status).toBe(201);
  expect(
    (
      await api.request('PUT', `/api/tenant/permission/scopes/${user}/TenantBase`, {
        ...asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: w.department, includeDescendants: false }] },
      })
    ).status,
  ).toBe(200);
  const call = (method: string, path: string, body?: unknown, key?: string, ifMatch?: number) =>
    api.request(method, `${BASE}${path}`, {
      user,
      tenant: w.tenant.id,
      ...(body ? { body } : {}),
      ...(key ? { idempotencyKey: key } : {}),
      ...(ifMatch === undefined ? {} : { ifMatch }),
    });
  async function scopeByCreator() {
    const response = await api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${assessment.code}/entity/${assessment.code}`,
      {
        ...asAdmin,
        ifMatch: 0,
        body: { rules: [{ dimension: 'using_user' }] },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  return { user, call, fields, scopeByCreator };
}

async function items(w: AssessmentWorld, people: readonly { employeeId: string }[]) {
  return Promise.all(
    people.map(async ({ employeeId }) => ({ employeeId, revision: await w.employeeRevision(employeeId) })),
  );
}
function hidden(error: Conflict, id: string, name: string, date: string) {
  expect(error).toMatchObject({ code: 'CONFLICT', details: { reason } });
  expect(error.message).toContain('未完成');
  expect(error.details).not.toHaveProperty('assessmentId');
  for (const value of [id, name, date]) expect(JSON.stringify(error)).not.toContain(value);
}
function visible(error: Conflict, id: string, name: string, date: string) {
  expect(error).toMatchObject({ code: 'CONFLICT', details: { reason, assessmentId: id } });
  expect(error.message).toContain(name);
  expect(error.message).toContain(date);
}

// 每个场景使用独立租户，真实权限与业务请求；测试造数复用现有合成夹具。
describe('AC-PB-03 F-228 考核互斥披露', () => {
  it('无考核查看权仍拦截直接转正、转正申请、调整与通用转正入口，响应不含明细且业务不变', async () => {
    const w = await assessmentWorld(testDb().db, 'f228-hidden');
    const op = await operator(w);
    const person = await w.probationer('合成试用员工');
    const id = await w.launch('regularization', person);
    const before = await w.get(id);
    const revision = await w.employeeRevision(person.employeeId);
    const detail = await op.call('GET', `/probation-assessments/${id}`);
    expect(detail.status).toBe(200);
    const disclosed = await detail.json();
    expect(disclosed).not.toHaveProperty('assessmentName');
    expect(disclosed).not.toHaveProperty('assessmentDate');
    for (const mode of ['direct', 'application']) {
      const response = await op.call('POST', '/regularizations', {
        mode,
        probationResult: 'normal',
        effectiveDate: '2026-12-01',
        items: await items(w, [person]),
      });
      expect(response.status).toBe(200);
      const receipt = (await response.json()) as Receipt;
      expect(receipt).toMatchObject({ total: 1, failed: 1, succeeded: 0 });
      hidden(receipt.items[0]!.error, id, before.assessmentName, before.assessmentDate);
    }
    for (const [method, path, body] of [
      [
        'PUT',
        `/employees/${person.employeeId}/probation`,
        {
          hasProbation: true,
          startDate: '2026-09-01',
          months: 3,
          expectedEndDate: '2026-11-30',
        },
      ],
      [
        'POST',
        `/employees/${person.employeeId}/businesses`,
        {
          kind: 'regularization',
          mode: 'direct',
          effectiveDate: '2026-12-01',
          fields: {},
          probationResult: 'normal',
        },
      ],
    ] as const) {
      const response = await op.call(method, path, body, undefined, revision);
      expect(response.status, await response.clone().text()).toBe(409);
      hidden(((await response.json()) as { error: Conflict }).error, id, before.assessmentName, before.assessmentDate);
    }
    expect(await w.get(id)).toEqual(before);
    expect(await w.employeeRevision(person.employeeId)).toBe(revision);
  });

  it('批量转正逐人复用考核详情范围；有权保留名称日期 ID，无权隐藏，撤销字段查看权后同键重放也隐藏', async () => {
    const w = await assessmentWorld(testDb().db, 'f228-batch');
    const op = await operator(w);
    await op.fields(assessment.fields.map((f) => f.code));
    await op.scopeByCreator();
    const own = await w.probationer('合成范围内员工', { createdBy: op.user });
    const other = await w.probationer('合成范围外员工');
    const ownId = await w.launch('probation', own);
    const otherId = await w.launch('regularization', other);
    const before = await Promise.all([w.get(ownId), w.get(otherId)]);
    expect((await op.call('GET', `/probation-assessments/${ownId}`)).status).toBe(200);
    expect((await op.call('GET', `/probation-assessments/${otherId}`)).status).toBe(404);
    const body = {
      mode: 'direct',
      effectiveDate: '2026-12-01',
      probationResult: 'normal',
      items: await items(w, [own, other]),
    };
    const key = randomUUID();
    const response = await op.call('POST', '/regularizations', body, key);
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = (await response.json()) as Receipt;
    expect(receipt).toMatchObject({ total: 2, succeeded: 0, failed: 2 });
    visible(receipt.items[0]!.error, ownId, before[0]!.assessmentName, before[0]!.assessmentDate);
    hidden(receipt.items[1]!.error, otherId, before[1]!.assessmentName, before[1]!.assessmentDate);
    await op.fields([]);
    const replay = await op.call('POST', '/regularizations', body, key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    const replayed = (await replay.json()) as Receipt;
    hidden(replayed.items[0]!.error, ownId, before[0]!.assessmentName, before[0]!.assessmentDate);
    hidden(replayed.items[1]!.error, otherId, before[1]!.assessmentName, before[1]!.assessmentDate);
    expect(await Promise.all([w.get(ownId), w.get(otherId)])).toEqual(before);
  });

  it('批量发起考核逐人披露；明细查看权不完整时整组收紧，同键重放也收紧', async () => {
    const w = await assessmentWorld(testDb().db, 'f228-launch');
    const op = await operator(w);
    await op.fields(
      assessment.fields.map((f) => f.code),
      true,
    );
    const people = [await w.probationer('合成考核甲'), await w.probationer('合成考核乙')];
    const ids = [await w.launch('probation', people[0]!), await w.launch('regularization', people[1]!)];
    const before = await Promise.all(ids.map(w.get));
    const body = {
      assessmentType: 'probation',
      assessmentName: '合成新考核',
      assessmentDate: '2026-10-02',
      items: await items(w, people),
    };
    const key = randomUUID();
    const first = await op.call('POST', '/probation-assessments', body, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const receipt = (await first.json()) as Receipt;
    expect(receipt).toMatchObject({ total: 2, succeeded: 0, failed: 2 });
    receipt.items.forEach((item, i) =>
      visible(item.error, ids[i]!, before[i]!.assessmentName, before[i]!.assessmentDate),
    );
    await op.fields(
      assessment.fields.map((f) => f.code).filter((f) => f !== 'id'),
      true,
    );
    for (const requestKey of [key, randomUUID()]) {
      const response = await op.call('POST', '/probation-assessments', body, requestKey);
      expect(response.status, await response.clone().text()).toBe(200);
      const projected = (await response.json()) as Receipt;
      projected.items.forEach((item, i) =>
        hidden(item.error, ids[i]!, before[i]!.assessmentName, before[i]!.assessmentDate),
      );
    }
    expect(await Promise.all(ids.map(w.get))).toEqual(before);
  });
  it('考核对象范围外的当前审批人沿用审批实例可见性，提示保留已可查看的明细', async () => {
    const w = await assessmentWorld(testDb().db, 'f228-participant');
    const person = await w.probationer('合成自评人');
    const op = await operator(w, person.userId);
    await op.fields(assessment.fields.map((f) => f.code));
    await op.scopeByCreator();
    const id = await w.launch('probation', person);
    const row = await w.get(id);
    expect((await op.call('GET', `/probation-assessments/${id}`)).status).toBe(404);
    const response = await op.call('POST', '/regularizations', {
      mode: 'direct',
      probationResult: 'normal',
      effectiveDate: '2026-12-01',
      items: await items(w, [person]),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    visible(((await response.json()) as Receipt).items[0]!.error, id, row.assessmentName, row.assessmentDate);
    expect(await w.get(id)).toEqual(row);
  });
});
