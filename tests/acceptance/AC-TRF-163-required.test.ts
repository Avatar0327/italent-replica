import { randomUUID } from 'node:crypto';
import { employmentBusinessObjects, employmentPayloadVersions, eq, sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';

const database = useTestDb();
const base = '/api/tenant/employment';
const formId = 'TenantBase.TransferMultiFormView';

async function fixture(db: Db, label: string) {
  const world = await approvalWorld(db, label);
  const original = await world.org('合成原部门');
  const target = await world.org('合成目标部门');
  const person = await world.person('合成调动员工', original);
  const manager = await world.person('合成经理', target);
  await world.setOrgRoles(target, { head: manager.employeeId });
  const post = await world.json<{ id: string }>(
    await world.request(world.hr.id, 'POST', '/api/tenant/job/posts', {
      ifMatch: 0,
      body: { name: '合成职务', code: randomUUID(), startDate: '2020-01-01' },
    }),
    201,
  );
  const position = await world.json<{ id: string }>(
    await world.request(world.hr.id, 'POST', '/api/tenant/job/positions', {
      ifMatch: 0,
      body: { name: '合成目标职位', code: randomUUID(), orgId: target, postId: post.id, startDate: '2020-01-01' },
    }),
    201,
  );
  const fields = {
    departmentId: target,
    positionId: position.id,
    directManagerId: manager.employeeId,
    dottedManagerId: manager.employeeId,
  };
  const currentRevision = async () =>
    (
      await world.json<{ revision: number }>(
        await world.request(world.hr.id, 'GET', `${base}/employees/${person.employeeId}`),
      )
    ).revision;
  const create = async (extra: Record<string, unknown>) =>
    world.request(world.hr.id, 'POST', `${base}/transfers/employees/${person.employeeId}`, {
      ifMatch: await currentRevision(),
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        formId,
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields,
        ...extra,
      },
    });
  const businessCount = async () => {
    const result = await db.execute(sql`SELECT count(*)::int AS count FROM employment_business_objects
      WHERE tenant_id=${world.tenant.id} AND employee_id=${person.employeeId}`);
    return (Array.isArray(result) ? result : (result as { rows: { count: number }[] }).rows)[0]!.count;
  };
  return { ...world, person, manager, original, post, target, fields, create, businessCount, currentRevision };
}

async function missing(response: Response, fields: readonly string[]) {
  expect(response.status, await response.clone().text()).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      code: 'VALIDATION_FAILED',
      details: { reason: 'TRANSFER_REQUIRED_FIELDS', missingFields: fields },
    },
  });
}

describe('DEC-163 / AC-TRF：仅新部门必填，其它场景不带出字段可存空', () => {
  it.each(['direct', 'application'])('%s 只填经理拒绝；有部门且其它未填允许保存空值', async (mode) => {
    const w = await fixture(database().db, `trf163-${mode}`);
    const before = await w.businessCount();
    const revision = await w.currentRevision();
    await missing(await w.create({ mode, fields: { directManagerId: w.manager.employeeId } }), ['departmentId']);
    expect(await w.businessCount()).toBe(before);
    expect(await w.currentRevision()).toBe(revision);
    const saved = await w.create({ mode, fields: { departmentId: w.target } });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({
      fields: {
        departmentId: w.target,
        positionId: null,
        directManagerId: w.manager.employeeId,
        dottedManagerId: null,
      },
    });
    // 明确清空经理时不触发负责人带出。
    const cleared = await w.create({ mode, fields: { departmentId: w.target, directManagerId: null } });
    expect(cleared.status, await cleared.clone().text()).toBe(201);
    expect(await cleared.json()).toMatchObject({
      fields: { departmentId: w.target, positionId: null, directManagerId: null, dottedManagerId: null },
    });
  });

  it('部门负责人自动带出的非空经理不记为留空字段', async () => {
    const db = database().db;
    const w = await fixture(db, 'trf-auto-nonempty');
    const saved = await w.json<{ id: string }>(await w.create({ fields: { departmentId: w.target } }), 201);
    const result = await db.execute(sql`SELECT payload FROM employment_outbox
      WHERE tenant_id=${w.tenant.id} AND business_id=${saved.id}::uuid AND event_type='employment.record.create'`);
    const rows = Array.isArray(result)
      ? result
      : (result as { rows: { payload: { meta: { clearedFieldCodes: string[] } } }[] }).rows;
    expect(rows[0]!.payload.meta.clearedFieldCodes).not.toContain('preset:directManagerId');
    expect(rows[0]!.payload.meta.clearedFieldCodes).toContain('preset:positionId');
  });

  it('职务职位调整只填职位，原部门带出，其余场景字段存空', async () => {
    const w = await fixture(database().db, 'trf163-jobpost');
    const position = await w.json<{ id: string }>(
      await w.request(w.hr.id, 'POST', '/api/tenant/job/positions', {
        ifMatch: 0,
        body: {
          name: '合成部门内职位',
          code: randomUUID(),
          postId: w.post.id,
          orgId: w.original,
          startDate: '2020-01-01',
        },
      }),
      201,
    );
    const saved = await w.create({
      transferTypeCode: 'job_post',
      formId: 'TenantBase.JobPostTransferMultiFormView',
      fields: { positionId: position.id },
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({
      fields: {
        departmentId: w.original,
        positionId: position.id,
        postId: null,
        levelId: null,
        gradeId: null,
        sequenceId: null,
      },
    });
  });

  it.each([
    ['job_level', 'TenantBase.JobLevelTransferMultiFormView'],
    ['job_post', 'TenantBase.JobPostTransferMultiFormView'],
  ])('DEC-165 %s 带出部门后清空仍拒绝，PATCH 同样拒绝', async (transferTypeCode, formId) => {
    const w = await fixture(database().db, `trf165-${transferTypeCode}`);
    const before = await w.businessCount();
    await missing(await w.create({ transferTypeCode, formId, fields: { departmentId: null } }), ['departmentId']);
    expect(await w.businessCount()).toBe(before);
    const draft = await w.json<{ id: string; revision: number }>(
      await w.create({ transferTypeCode, formId, mode: 'application', fields: {} }),
      201,
    );
    await missing(
      await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
        ifMatch: draft.revision,
        body: { fields: { departmentId: null } },
      }),
      ['departmentId'],
    );
  });

  it('AC-TRF-01/23 DEC-205 员工复用 HR 表单，HR 入口仍拒绝 Personal 表单', async () => {
    const w = await fixture(database().db, 'trf-personal-binding');
    const response = await w.request(w.person.userId, 'POST', `${base}/transfers/employees/${w.person.employeeId}`, {
      ifMatch: await w.currentRevision(),
      body: {
        initiator: 'employee',
        mode: 'application',
        formId,
        transferTypeCode: 'cross_department',
        effectiveDate: '2026-10-01',
        fields: w.fields,
      },
    });
    expect(response.status).toBe(201);
    const reversed = await w.create({ formId: 'TenantBase.PersonalCrossDepartmentTransferMultiFormView' });
    expect(reversed.status).toBe(400);
  });

  it('部门 null/空串被拒；readonly/hidden/absent 沿用冻结继承策略', async () => {
    const w = await fixture(database().db, 'trf163-modes');
    const before = await w.businessCount();
    await missing(await w.create({ fields: { ...w.fields, departmentId: null } }), ['departmentId']);
    const blank = await w.create({ fields: { ...w.fields, departmentId: '' } });
    expect(blank.status).toBe(400);
    expect(await w.businessCount()).toBe(before);
    const configured = await w.request(w.hr.id, 'PUT', `${base}/transfers/forms/${formId}`, {
      ifMatch: 0,
      body: {
        name: '合成只读场景配置',
        group: 'transfer',
        fieldModes: {
          'preset:departmentId': 'readonly',
          'preset:positionId': 'hidden',
          'preset:directManagerId': 'absent',
          'preset:dottedManagerId': 'readonly',
        },
      },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const saved = await w.create({ fields: {}, mode: 'application' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const draft = (await saved.json()) as { id: string; revision: number };
    const changedConfig = await w.request(w.hr.id, 'PUT', `${base}/transfers/forms/${formId}`, {
      ifMatch: 1,
      body: { name: '后改可编辑配置', group: 'transfer', fieldModes: {} },
    });
    expect(changedConfig.status).toBe(200);
    const patch = await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { fields: { place: '配置改变后仅修改工作地' } },
    });
    // 已存单按冻结字段模式校验，后来放开编辑不能把旧单的隐藏字段变成必填。
    expect(patch.status, await patch.clone().text()).toBe(200);
  });

  it('隐藏部门仍继承非空原部门时，预览不泄漏值，也不误报必填项不可用', async () => {
    const w = await fixture(database().db, 'trf-required-hidden-preview');
    const configured = await w.request(w.hr.id, 'PUT', `${base}/transfers/forms/${formId}`, {
      ifMatch: 0,
      body: { name: '合成隐藏部门', group: 'transfer', fieldModes: { 'preset:departmentId': 'hidden' } },
    });
    expect(configured.status).toBe(200);
    const response = await w.request(w.hr.id, 'POST', `${base}/transfers/employees/${w.person.employeeId}/preview`, {
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        formId,
        mode: 'application',
        effectiveDate: '2026-10-01',
        fields: {},
      },
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as { fields: object; requiredFieldsUnavailable: boolean };
    expect(preview.fields).not.toHaveProperty('departmentId');
    expect(preview.requiredFieldsUnavailable).toBe(false);
  });

  it('PATCH 保留部门，允许清空非必填场景字段；清空部门拒绝', async () => {
    const w = await fixture(database().db, 'trf163-patch');
    const created = await w.create({ mode: 'application' });
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { id: string; revision: number };
    const patched = await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { fields: { place: '合成新工作地' } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const after = (await patched.json()) as { revision: number; fields: object };
    expect(after.fields).toMatchObject(w.fields);
    const cleared = await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
      ifMatch: after.revision,
      body: { fields: { dottedManagerId: null } },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const blank = (await cleared.json()) as { revision: number };
    await missing(
      await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
        ifMatch: blank.revision,
        body: { fields: { departmentId: null } },
      }),
      ['departmentId'],
    );
    expect(await w.business(draft.id)).toMatchObject({
      revision: blank.revision,
      fields: { ...w.fields, dottedManagerId: null },
    });
  });

  it('旧草稿提交重新校验缺失字段，不能绕过升级后的保存规则', async () => {
    const { db } = database();
    const w = await fixture(db, 'trf163-old-draft');
    await w.publishedProcess({ nodes: [{ key: 'review', approver: 'owner' }] });
    const created = await w.create({ mode: 'application' });
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { id: string; revision: number };
    // 可信升级夹具：追加一份升级前允许保存的缺字段载荷，原有版本保持不可变。
    const [payload] = await db
      .select()
      .from(employmentPayloadVersions)
      .where(eq(employmentPayloadVersions.businessId, draft.id));
    await db.insert(employmentPayloadVersions).values({
      ...payload!,
      id: randomUUID(),
      versionNo: 2,
      previousVersionId: payload!.id,
      formSnapshot: payload!.formSnapshot,
      explicitFieldCodes: [],
      departmentId: null,
      positionId: null,
      directManagerId: null,
      dottedManagerId: null,
    });
    await db
      .update(employmentBusinessObjects)
      .set({ revision: draft.revision + 1 })
      .where(eq(employmentBusinessObjects.id, draft.id));
    await missing(
      await w.request(w.hr.id, 'POST', `${base}/businesses/${draft.id}/submit`, {
        ifMatch: draft.revision + 1,
      }),
      ['departmentId'],
    );
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft', revision: draft.revision + 1 });
  });

  it('PATCH 改职务允许自动带出新序列，也允许明确清空序列', async () => {
    const w = await fixture(database().db, 'trf163-derived-sequence');
    const job = async (kind: string, fields: object = {}) =>
      w.json<{ id: string }>(
        await w.request(w.hr.id, 'POST', `/api/tenant/job/${kind}`, {
          ifMatch: 0,
          body: { name: `合成${kind}`, code: randomUUID(), startDate: '2020-01-01', ...fields },
        }),
        201,
      );
    const firstSequence = await job('sequences');
    const nextSequence = await job('sequences');
    const post = await job('posts', { sequenceId: nextSequence.id });
    const position = await job('positions', { orgId: w.target, postId: post.id });
    const configured = await w.request(
      w.hr.id,
      'PUT',
      `${base}/transfers/forms/TenantBase.JobPostTransferMultiFormView`,
      {
        ifMatch: 0,
        body: {
          name: '合成序列调整表单',
          group: 'transfer',
          fieldModes: { 'preset:levelId': 'hidden', 'preset:gradeId': 'hidden' },
        },
      },
    );
    expect(configured.status).toBe(200);
    const draft = await w.json<{ id: string; revision: number }>(
      await w.create({
        mode: 'application',
        transferTypeCode: 'job_post',
        formId: 'TenantBase.JobPostTransferMultiFormView',
        fields: { ...w.fields, postId: w.post.id, sequenceId: firstSequence.id },
      }),
      201,
    );
    const derived = await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { fields: { postId: post.id, positionId: position.id } },
    });
    expect(derived.status, await derived.clone().text()).toBe(200);
    const changed = (await derived.json()) as { revision: number };
    expect(await w.business(draft.id)).toMatchObject({ fields: { sequenceId: nextSequence.id } });
    const cleared = await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
      ifMatch: changed.revision,
      body: { fields: { sequenceId: null } },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ fields: { sequenceId: null } });
  });

  it.each([true, false])('自动带出开关 %s：不带出字段省略仍存空，不通过生效时继承回填', async (autoPopulate) => {
    const w = await fixture(database().db, `trf163-autopop-${autoPopulate}`);
    const prior = await w.request(w.hr.id, 'POST', `${base}/employees/${w.person.employeeId}/businesses`, {
      ifMatch: await w.currentRevision(),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-01', formId: 'standard', fields: w.fields },
    });
    expect(prior.status).toBe(201);
    const configured = await w.request(w.hr.id, 'PUT', `${base}/transfers/settings`, {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: true, autoPopulate },
    });
    expect(configured.status).toBe(200);
    const saved = await w.create({ fields: { departmentId: w.target, directManagerId: null } });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({
      fields: { departmentId: w.target, positionId: null, directManagerId: null, dottedManagerId: null },
      record: { fields: { positionId: null, dottedManagerId: null } },
    });
  });

  it('预览允许未填字段；legacy standard 通用任职入口不新增场景必填要求', async () => {
    const w = await fixture(database().db, 'trf163-preview');
    const preview = await w.request(w.hr.id, 'POST', `${base}/transfers/employees/${w.person.employeeId}/preview`, {
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        formId,
        effectiveDate: '2026-10-01',
        fields: {},
      },
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const legacy = await w.request(w.hr.id, 'POST', `${base}/employees/${w.person.employeeId}/businesses`, {
      ifMatch: await w.currentRevision(),
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        formId: 'standard',
        fields: { place: '合成工作地' },
      },
    });
    expect(legacy.status, await legacy.clone().text()).toBe(201);
  });
});
