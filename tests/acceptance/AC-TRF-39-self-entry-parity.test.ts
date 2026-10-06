import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin, type Person } from './AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/employment';
let w: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let admin: Awaited<ReturnType<typeof permissionAdmin>>;
let source: string;
let target: string;
let outsider: Person;
let manager: Person;
let postId: string;
let newPostId: string;
const date = '2026-10-19';

async function actor(name: string, role = 'Transfer.Self') {
  const person = await w.person(name, source, { postId, directManagerId: manager.employeeId });
  const profile = await createProfile(admin, `entry-${randomUUID()}`);
  const def = MODULE_OBJECTS.employmentRecord;
  await w.json(
    await setObjectPermission(
      admin,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: def.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
        buttons: def.buttons
          .filter((button) => !button.code.startsWith('Transfer.') || button.code === role)
          .map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      def.code,
    ),
  );
  await makeGrantable(admin, [profile.id]);
  await w.json(await grant(admin, person.userId, profile.id), 201);
  await w.json(
    await admin.api.request('PUT', `/api/tenant/permission/scopes/${person.userId}/TenantBase`, {
      ...admin.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [source, target].map((orgId) => ({ orgId, includeDescendants: false })) },
    }),
  );
  return person;
}
const revision = async (person: Person) =>
  (
    await w.json<{ employee: { revision: number } }>(
      await api.request('GET', '/api/tenant/self-service/profile', w.as(person.userId)),
    )
  ).employee.revision;
function body(fields: Record<string, unknown> = {}, submit = true) {
  return {
    initiator: 'employee',
    transferTypeCode: 'in_department',
    formId: 'TenantBase.TransferMultiFormView',
    effectiveDate: date,
    mode: 'application',
    submit,
    fields: { departmentId: target, ...fields },
  };
}
async function legacy(person: Person, fields: Record<string, unknown> = {}, preview = false, submit = true) {
  return api.request('POST', `${BASE}/transfers/employees/${person.employeeId}${preview ? '/preview' : ''}`, {
    ...w.as(person.userId),
    ifMatch: await revision(person),
    body: body(fields, submit),
  });
}
async function leave(person: Person) {
  const current = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}`),
  );
  await w.json(
    await w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/businesses`, {
      ifMatch: current.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
    }),
    201,
  );
}

beforeAll(async () => {
  w = await approvalWorld(database().db, 'self-entry-parity');
  api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
  admin = await permissionAdmin(w);
  source = await w.org('合成原部门');
  target = await w.org('合成新部门');
  outsider = await w.person('合成范围外经理', source);
  manager = await w.person('合成合法经理', target, { isDepartmentHead: true });
  await w.setOrgRoles(target, { head: manager.employeeId });
  const post = async (code: string) =>
    (
      await w.json<{ id: string }>(
        await w.request(w.hr.id, 'POST', '/api/tenant/job/posts', {
          ifMatch: 0,
          body: { code, name: code, startDate: '2020-01-01' },
        }),
        201,
      )
    ).id;
  postId = await post('original-post');
  newPostId = await post('changed-post');
  await w.publishedProcess({ nodes: [{ key: 'review', approver: 'owner' }] });
});

describe('AC-TRF-39 第三轮：新旧员工入口的 DEC-209 一致性', () => {
  it.each(['manager', 'uppercase-manager', 'post', 'level', 'sequence'])(
    '旧入口创建拒绝 %s，不能保存并送审；新入口也拒绝',
    async (field) => {
      const self = await actor(`合成拒绝-${field}`);
      const fields =
        field === 'manager'
          ? { directManagerId: outsider.employeeId }
          : field === 'uppercase-manager'
            ? { directManagerId: outsider.employeeId.toUpperCase() }
            : field === 'post'
              ? { postId: newPostId }
              : field === 'level'
                ? { levelId: null }
                : { sequenceId: null };
      const rev = await revision(self);
      expect(
        (
          await api.request('POST', '/api/tenant/self-service/transfer', {
            ...w.as(self.userId),
            ifMatch: rev,
            body: { effectiveDate: date, fields: { departmentId: target, ...fields } },
          })
        ).status,
      ).toBe(403);
      const response = await legacy(self, fields);
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await revision(self)).toBe(rev);
    },
  );

  it('旧预览也拒绝范围外经理和职务写入', async () => {
    const self = await actor('合成预览');
    for (const fields of [{ directManagerId: outsider.employeeId.toUpperCase() }, { postId: newPostId }])
      expect((await legacy(self, fields, true)).status).toBe(403);
  });

  it.each(['legacy', 'self-service'])('合法经理、可信原值及自动带出继续可用：%s', async (entry) => {
    const self = await actor(`合成正常-${entry}`);
    await w.setOrgRoles(target, { head: manager.employeeId });
    const explicit = { directManagerId: manager.employeeId.toUpperCase() };
    const preview = await w.json<{ fields: object }>(await legacy(self, {}, true));
    expect(preview.fields).toMatchObject({ directManagerId: manager.employeeId });
    if (entry === 'legacy') {
      expect(await w.json(await legacy(self, explicit), 201)).toMatchObject({ status: 'in_review' });
    } else {
      expect(
        await w.json(
          await api.request('POST', '/api/tenant/self-service/transfer', {
            ...w.as(self.userId),
            ifMatch: await revision(self),
            body: { effectiveDate: date, fields: { departmentId: target, ...explicit } },
          }),
          201,
        ),
      ).toMatchObject({ status: 'in_review', fields: { postId } });
    }
  });

  it('员工草稿不能经任职 PATCH 修改职务或范围外经理', async () => {
    const self = await actor('合成草稿');
    const draft = await w.json<{ id: string; revision: number }>(await legacy(self, {}, false, false), 201);
    for (const fields of [{ postId: newPostId }, { directManagerId: outsider.employeeId }]) {
      expect(
        (
          await api.request('PATCH', `${BASE}/businesses/${draft.id}`, {
            ...w.as(self.userId),
            ifMatch: draft.revision,
            body: { fields },
          })
        ).status,
      ).toBe(403);
    }
  });

  it('HR/经理入口仍可正常填写经理与职务', async () => {
    for (const initiator of ['hr', 'manager']) {
      const actorPerson = await actor(`合成${initiator}`, initiator === 'hr' ? 'Transfer.Hr' : 'Transfer.Manager');
      const subject = await w.person(`合成被调动${initiator}`, source, { directManagerId: actorPerson.employeeId });
      if (initiator === 'manager') {
        // R1-T14：经理需负责源/目标组织，职务候选须由负责组织内职位关联。
        await w.setOrgRoles(source, { head: actorPerson.employeeId });
        await w.setOrgRoles(target, { head: actorPerson.employeeId });
        await w.json(
          await w.request(w.hr.id, 'POST', '/api/tenant/job/positions', {
            ifMatch: 0,
            body: {
              code: 'manager-target-position',
              name: '合成经理可选职位',
              startDate: '2020-01-01',
              orgId: target,
              postId: newPostId,
            },
          }),
          201,
        );
      }
      const response = await api.request('POST', `${BASE}/transfers/employees/${subject.employeeId}`, {
        ...w.as(actorPerson.userId),
        ifMatch: await revision(subject),
        body: { ...body({ postId: newPostId, directManagerId: outsider.employeeId }), initiator },
      });
      expect(await w.json(response, 201)).toMatchObject({ status: 'in_review', fields: { postId: newPostId } });
    }
  });

  it('创建重放、草稿后续提交都重新校验手选经理；失败不推进业务状态', async () => {
    const self = await actor('合成重放');
    const candidate = await w.person('合成失效经理', target);
    const request = {
      ...w.as(self.userId),
      ifMatch: await revision(self),
      idempotencyKey: randomUUID(),
      body: body({ directManagerId: candidate.employeeId }, false),
    };
    const path = `${BASE}/transfers/employees/${self.employeeId}`;
    const saved = await w.json<{ id: string; revision: number }>(await api.request('POST', path, request), 201);
    await leave(candidate);
    expect((await api.request('POST', path, request)).status).toBe(403);
    expect(
      (
        await api.request('POST', `${BASE}/businesses/${saved.id}/submit`, {
          ...w.as(self.userId),
          ifMatch: saved.revision,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect((await w.business(saved.id)).status).toBe('draft');
  });

  it('历史员工违规草稿不能经后续提交绕过；提交命令重放也重验候选', async () => {
    const self = await actor('合成历史草稿');
    // 升级前的员工草稿：通过可信夹具补充来源元数据，不关闭生产校验来造数据。
    const old = await w.application(self.employeeId, { departmentId: source, postId: newPostId });
    await withTenant(database().db, w.tenant.id, (tx) =>
      tx.execute(sql`
      INSERT INTO transfer_requests(tenant_id,business_id,employee_id,initiator,transfer_type_code,process_code)
      VALUES(${w.tenant.id},${old.id}::uuid,${self.employeeId}::uuid,'employee','in_department','TransferProcessNew')
    `),
    );
    expect(
      (
        await api.request('POST', `${BASE}/businesses/${old.id}/submit`, {
          ...w.as(self.userId),
          ifMatch: old.revision,
          body: {},
        })
      ).status,
    ).toBe(403);
    const candidate = await w.person('合成提交重放经理', target);
    const draft = await w.json<{ id: string; revision: number }>(
      await legacy(self, { directManagerId: candidate.employeeId }, false, false),
      201,
    );
    const path = `${BASE}/businesses/${draft.id}/submit`;
    const options = { ...w.as(self.userId), ifMatch: draft.revision, idempotencyKey: randomUUID(), body: {} };
    await w.json(await api.request('POST', path, options));
    await leave(candidate);
    expect((await api.request('POST', path, options)).status).toBe(403);
  });

  it('PATCH 命令重放仍按当前候选校验，不返回此前修改结果', async () => {
    const self = await actor('合成修改重放');
    const candidate = await w.person('合成修改后离职经理', target);
    const draft = await w.json<{ id: string; revision: number }>(await legacy(self, {}, false, false), 201);
    const path = `${BASE}/businesses/${draft.id}`;
    const options = {
      ...w.as(self.userId),
      ifMatch: draft.revision,
      idempotencyKey: randomUUID(),
      body: { fields: { directManagerId: candidate.employeeId.toUpperCase() } },
    };
    await w.json(await api.request('PATCH', path, options));
    const before = await w.business(draft.id);
    await leave(candidate);
    expect((await api.request('PATCH', path, options)).status).toBe(403);
    expect((await w.business(draft.id)).revision).toBe(before.revision);
  });
});
