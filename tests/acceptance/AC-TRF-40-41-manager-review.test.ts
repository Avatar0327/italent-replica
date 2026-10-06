import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/employment/transfers';
const formId = 'TenantBase.TransferMultiFormView';
describe('AC-TRF-40/41 astra 第二轮回归', () => {
  let w: Awaited<ReturnType<typeof approvalWorld>>;
  let api: ReturnType<typeof tenantApi>;
  let actor: { user: string; tenant: string };
  let managerId: string;
  let source: string;
  let target: string;
  let outside: string;
  let employeeId: string;
  let post: string;
  let foreignPost: string;
  let level: string;
  let sequence: string;
  beforeAll(async () => {
    w = await approvalWorld(database().db, 'manager-review');
    w.setNow('2026-10-01T01:00:00Z');
    api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
    source = await w.org('负责组织 A');
    target = await w.org('负责组织 B');
    outside = await w.org('范围外组织');
    const manager = await w.person('无 HR 的纯经理', source);
    managerId = manager.employeeId;
    actor = w.as(manager.userId);
    await w.setOrgRoles(source, { head: managerId });
    await w.setOrgRoles(target, { head: managerId });
    employeeId = (await w.person('被调动员工', source)).employeeId;
    await w.publishedProcess({ nodes: [{ key: 'owner', approver: 'owner' }] });
    const createJob = async (kind: string, body: object) =>
      (
        await w.json<{ id: string }>(
          await w.request(w.hr.id, 'POST', `/api/tenant/job/${kind}`, {
            ifMatch: 0,
            body: { name: `合成${kind}`, startDate: '2025-01-01', ...body },
          }),
          201,
        )
      ).id;
    level = await createJob('levels', { level: 2 });
    sequence = await createJob('sequences', {});
    post = await createJob('posts', { minLevelId: level, maxLevelId: level, sequenceId: sequence });
    foreignPost = await createJob('posts', {});
    await createJob('positions', { orgId: target, postId: post, sequenceId: sequence });
    await createJob('positions', { orgId: outside, postId: foreignPost });
    // 显式宽范围用于证明负责组织检查不能被 Switch 31 / 通用范围代替。
    const admin = await permissionAdmin(w);
    const scope = await admin.api.request('PUT', `/api/tenant/permission/scopes/${actor.user}/TenantBase`, {
      ...admin.asAdmin,
      ifMatch: 0,
      body: {
        kind: 'org_range',
        orgRanges: [source, target, outside].map((orgId) => ({ orgId, includeDescendants: true })),
      },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
  });
  const input = (fields: object = {}) => ({
    initiator: 'manager',
    transferTypeCode: 'in_department',
    formId,
    effectiveDate: '2026-11-01',
    mode: 'application',
    fields,
  });
  const refs = (field: string, extra: Record<string, string> = {}) =>
    api.request(
      'GET',
      `${BASE}/manager/references/${field}?${new URLSearchParams({
        employeeId,
        formId,
        effectiveDate: '2026-11-01',
        departmentId: target,
        ...extra,
      })}`,
      actor,
    );

  it('默认纯经理的常规字段可编辑；通过受控候选实际选择新部门和职务并送审', async () => {
    const preview = await api.request('POST', `${BASE}/employees/${employeeId}/preview`, { ...actor, body: input() });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const value = (await preview.json()) as { form: { fieldModes: Record<string, string> }; employeeRevision: number };
    for (const field of ['departmentId', 'postId', 'levelId', 'sequenceId'])
      expect(value.form.fieldModes[`preset:${field}`], field).toBe('editable');
    const departments = await w.json<{ items: { id: string }[] }>(await refs('departmentId'));
    expect(departments.items.map((item) => item.id)).toContain(target);
    expect(departments.items.map((item) => item.id)).not.toContain(outside);
    const posts = await w.json<{ items: { id: string; name: string }[] }>(await refs('postId'));
    expect(posts.items).toEqual([{ id: post, name: '合成posts' }]);
    for (const [field, id] of [
      ['levelId', level],
      ['sequenceId', sequence],
    ]) {
      const choices = await w.json<{ items: { id: string }[] }>(await refs(field!, { postId: post }));
      expect(choices.items.map((item) => item.id)).toContain(id);
    }
    const saved = await api.request('POST', `${BASE}/employees/${employeeId}`, {
      ...actor,
      ifMatch: value.employeeRevision,
      body: {
        ...input({ departmentId: target, postId: posts.items[0]!.id, levelId: level, sequenceId: sequence }),
        submit: true,
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({ status: 'in_review', fields: { departmentId: target, postId: post } });
    expect((await api.request('GET', '/api/tenant/job/posts', actor)).status).toBe(403);
  });

  it('参照不越负责组织、不越租户、不回显隐藏字段；伪造候选提交被拒', async () => {
    expect((await refs('postId', { departmentId: outside })).status).toBe(403);
    expect((await refs('levelId', { postId: foreignPost })).status).toBe(403);
    expect((await refs('postId', { employeeId: randomUUID() })).status).toBe(404);
    expect((await refs('remarks')).status).toBe(403);
    const foreign = await approvalWorld(database().db, 'reference-other-tenant');
    const foreignEmployee = await foreign.person('其他租户员工', await foreign.org('其他租户组织'));
    expect((await refs('postId', { employeeId: foreignEmployee.employeeId })).status).toBe(404);
    const legacyDepartments = await w.json<{ items: { id: string }[] }>(
      await api.request('GET', `${BASE}/departments?formId=${formId}&effectiveDate=2026-11-01`, actor),
    );
    expect(legacyDepartments.items.map((item) => item.id)).not.toContain(outside);
    const forgedPost = await api.request('POST', `${BASE}/employees/${employeeId}`, {
      ...actor,
      ifMatch: (
        await w.json<{ revision: number }>(
          await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
        )
      ).revision,
      body: input({ departmentId: target, postId: foreignPost }),
    });
    expect(forgedPost.status, await forgedPost.clone().text()).toBe(403);
    const denied = await api.request('POST', `${BASE}/employees/${employeeId}`, {
      ...actor,
      ifMatch: (
        await w.json<{ revision: number }>(
          await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
        )
      ).revision,
      body: input({ departmentId: outside, postId: foreignPost }),
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
  });

  it('撤销 A 负责关系后，原命令 ID / revision / 内容重放提交必须 403，保留 B 身份与 A 通用范围', async () => {
    const person = await w.person('幂等重放员工', source);
    const revision = (
      await w.json<{ revision: number }>(
        await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${person.employeeId}`),
      )
    ).revision;
    const saved = await api.request('POST', `${BASE}/employees/${person.employeeId}`, {
      ...actor,
      ifMatch: revision,
      body: { ...input(), formId: 'TenantBase.JobLevelTransferMultiFormView', transferTypeCode: 'job_level' },
    });
    const business = await w.json<{ id: string; revision: number }>(saved, 201);
    const options = { ...actor, ifMatch: business.revision, idempotencyKey: randomUUID(), body: {} };
    const path = `/api/tenant/employment/businesses/${business.id}/submit`;
    expect((await api.request('POST', path, options)).status).toBe(200);
    expect((await api.request('POST', path, options)).status).toBe(200);
    await w.setOrgRoles(source, { head: null });
    expect((await api.request('GET', `${BASE}/manager`, actor)).status).toBe(200);
    const replay = await api.request('POST', path, options);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect((await api.request('POST', path, { ...options, idempotencyKey: randomUUID() })).status).toBe(403);
  });
});
