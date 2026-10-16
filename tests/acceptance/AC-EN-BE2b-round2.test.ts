/**
 * BE-2b 第 1 轮审查返工（#361，Codex Sol high）：
 * P2-1 生成邮箱回执被通用任职字段投影裁空；P2-2 办理入职绕过合同“新建”按钮权限；
 * P2-3 合同权限只在首次执行时检查，同键重放绕过当前权限。
 * 权限用授权提供器（非无限制）：按钮 / 对象 / 数据范围 / 可见字段分别可控。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { CONTRACT_OBJECT, MODULE_OBJECTS, buttonResource, contractAction } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { addPending, businessRevision, entryRecords, entryWorld, type EntryWorld } from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00.000Z');
const CREATE_BUTTON = buttonResource(CONTRACT_OBJECT, contractAction('create', 'direct'), 'list');

/** 授权提供器：deny 命中的请求拒绝；数据范围可切到空；可见字段 = 任职记录 / 人员对象的全部合法字段。 */
function provider(deny: (request: Parameters<Authorizer>[0]) => boolean, scope: { empty: boolean } = { empty: false }) {
  const authorize: Authorizer = (request) => !deny(request);
  const fields = new Set<string>([
    ...[MODULE_OBJECTS.employmentRecord, MODULE_OBJECTS.employee, MODULE_OBJECTS.employmentSettings].flatMap((object) =>
      object.fields.map((field) => field.code),
    ),
    'id',
    'revision',
  ]);
  registerScopeProvider(authorize, {
    // 只收窄合同对象的数据范围；任职记录对象的范围不变，请求才能走到合同复核
    scope: async (query) =>
      scope.empty && query.objectCode === CONTRACT_OBJECT
        ? EMPTY_SCOPE
        : { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
    authorize: async (request) => authorize(request),
    fields: async () => fields,
  });
  return authorize;
}

async function contractWorld(label: string) {
  const w = await entryWorld(testDb().db, label);
  const open = tenantApi(w.db, { clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await open.request('POST', `/api/tenant/contracts/master-data/${kind}`, {
      ...as,
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const contract = {
    typeId: await master('types', '劳动合同'),
    companyId: await master('companies', '合成法人公司'),
    termType: 'fixed',
    termMonths: 12,
    endDate: '2027-08-31',
  };
  const contracts = async () => {
    const response = await open.request('GET', '/api/tenant/contracts?view=all', as);
    return ((await response.json()) as { items: unknown[] }).items;
  };
  const complete = (authorize: Authorizer, recordId: string, ifMatch: number, key: string, body: object) =>
    tenantApi(w.db, { authorize, clock }).request(
      'POST',
      `/api/tenant/employment/pending-entries/${recordId}/complete`,
      {
        ...as,
        ifMatch,
        idempotencyKey: key,
        body,
      },
    );
  return { w, contract, contracts, complete, as };
}

describe('BE-2b 返工 P2-1：生成邮箱回执在权限提供器下保留结果字段', () => {
  async function generated(w: EntryWorld, authorize: Authorizer) {
    const rules = await w.session.request('PUT', '/entry-email-rules', {
      ifMatch: 0,
      body: {
        entryEmailRules: [
          { name: '默认规则', priority: 1, orgIds: [w.org.id], prefixField: 'employeeCode', domain: 'example.com' },
        ],
      },
    });
    expect(rules.status, await rules.clone().text()).toBe(200);
    const employee = await w.session.employee('回执合成员工', 'receipt01');
    const added = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-10-10',
        pendingEntry: true,
        loginEmail: 'receipt01-login@example.com',
        fields: { employType: 'internal', departmentId: w.org.id },
      },
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const { id } = (await added.json()) as { id: string };
    return tenantApi(w.db, { authorize, clock }).request(
      'POST',
      `/api/tenant/employment/pending-entries/${id}/generate-email`,
      {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: await businessRevision(w, id),
        body: {},
      },
    );
  }

  it('有权限目录里全部合法字段的操作人：200，回执带 status / email / 规则标识', async () => {
    const w = await entryWorld(testDb().db, 'be2b-r2-receipt');
    const response = await generated(
      w,
      provider(() => false),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'generated',
      email: 'receipt01@example.com',
      ruleName: '默认规则',
      ruleId: expect.any(String),
    });
  });

  it('无规则回执保持 no_rule（对照）', async () => {
    const w = await entryWorld(testDb().db, 'be2b-r2-receipt-fail');
    const employee = await w.session.employee('失败回执合成员工', 'bad code');
    const added = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-10-10',
        pendingEntry: true,
        loginEmail: 'receipt02-login@example.com',
        fields: { employType: 'internal', departmentId: w.org.id },
      },
    });
    const { id } = (await added.json()) as { id: string };
    const none = tenantApi(w.db, { authorize: provider(() => false), clock });
    const response = await none.request('POST', `/api/tenant/employment/pending-entries/${id}/generate-email`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: await businessRevision(w, id),
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ status: 'no_rule' });
  });
});

describe('BE-2b 返工 P2-2：办理入职带合同要过合同“新建”按钮', () => {
  it('有合同创建权与字段权、没有新建按钮：403，入职不生效，合同不生成', async () => {
    const { w, contract, contracts, complete } = await contractWorld('be2b-r2-button');
    const { employee, recordId } = await addPending(w, '2026-09-01');
    const authorize = provider((request) => request.action === 'object.button' && request.resource === CREATE_BUTTON);
    const response = await complete(authorize, recordId, await businessRevision(w, recordId), randomUUID(), {
      probation: true,
      contract,
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 1 });
    expect(await contracts()).toEqual([]);
  });

  it('有新建按钮时照常生成（对照）', async () => {
    const { w, contract, contracts, complete } = await contractWorld('be2b-r2-button-ok');
    const { recordId } = await addPending(w, '2026-09-01');
    const authorize = provider(() => false);
    const response = await complete(authorize, recordId, await businessRevision(w, recordId), randomUUID(), {
      probation: true,
      contract,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await contracts()).toHaveLength(1);
  });
});

describe('BE-2b 返工 P2-3：同键重放按当前合同权限复核', () => {
  const revokers: [string, (request: Parameters<Authorizer>[0]) => boolean][] = [
    ['合同对象创建权', (request) => request.action === 'object.create' && request.resource === CONTRACT_OBJECT],
    ['合同新建按钮', (request) => request.action === 'object.button' && request.resource === CREATE_BUTTON],
  ];

  it.each(revokers)('首次成功后撤销%s：同键同内容重放 403，不再返回原 200', async (_name, revoke) => {
    const { w, contract, contracts, complete } = await contractWorld(`be2b-r2-replay-${_name.length}`);
    const { recordId } = await addPending(w, '2026-09-01');
    const revision = await businessRevision(w, recordId);
    const key = randomUUID();
    const body = { probation: true, contract };
    const first = await complete(
      provider(() => false),
      recordId,
      revision,
      key,
      body,
    );
    expect(first.status, await first.clone().text()).toBe(200);
    const replay = await complete(provider(revoke), recordId, revision, key, body);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await contracts()).toHaveLength(1);
  });

  it('首次成功后合同数据范围收为空：同键重放被拒', async () => {
    const { w, contract, contracts, complete } = await contractWorld('be2b-r2-replay-scope');
    const { recordId } = await addPending(w, '2026-09-01');
    const revision = await businessRevision(w, recordId);
    const key = randomUUID();
    const body = { probation: true, contract };
    expect(
      (
        await complete(
          provider(() => false),
          recordId,
          revision,
          key,
          body,
        )
      ).status,
    ).toBe(200);
    const replay = await complete(
      provider(() => false, { empty: true }),
      recordId,
      revision,
      key,
      body,
    );
    expect([403, 404], await replay.clone().text()).toContain(replay.status);
    expect(await contracts()).toHaveLength(1);
  });

  it('权限不变时同键重放仍返回原结果，合同只有一张', async () => {
    const { w, contract, contracts, complete } = await contractWorld('be2b-r2-replay-same');
    const { recordId } = await addPending(w, '2026-09-01');
    const revision = await businessRevision(w, recordId);
    const key = randomUUID();
    const authorize = provider(() => false);
    const body = { probation: true, contract };
    expect((await complete(authorize, recordId, revision, key, body)).status).toBe(200);
    expect((await complete(authorize, recordId, revision, key, body)).status).toBe(200);
    expect(await contracts()).toHaveLength(1);
  });
});
