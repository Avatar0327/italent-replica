import { randomUUID } from 'node:crypto';
import { employmentBusinessObjects, employmentPayloadVersions, eq, sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';

const database = useTestDb();
const base = '/api/tenant/employment';
const formId = 'TenantBase.TransferMultiFormView';
const excluded = ['departmentId', 'positionId', 'directManagerId', 'dottedManagerId'];

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
  return { ...world, person, manager, target, fields, create, businessCount, currentRevision };
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

describe('DEC-162 / AC-TRF：场景不带出的可编辑字段保存必填，预览不受限', () => {
  it.each(['direct', 'application'])('%s 只填经理拒绝且整单不写入；完整值保存保留所填部门/职位', async (mode) => {
    const w = await fixture(database().db, `trf162-${mode}`);
    const before = await w.businessCount();
    const revision = await w.currentRevision();
    await missing(await w.create({ mode, fields: { directManagerId: w.manager.employeeId } }), [
      'departmentId',
      'positionId',
      'dottedManagerId',
    ]);
    expect(await w.businessCount()).toBe(before);
    expect(await w.currentRevision()).toBe(revision);
    // 目标部门负责人会自动派生，但不能冒充 HR 显式填写来满足 DEC-162。
    const { directManagerId: _manager, ...withoutManager } = w.fields;
    await missing(await w.create({ mode, fields: withoutManager }), ['directManagerId']);
    expect(await w.businessCount()).toBe(before);
    const saved = await w.create({ mode });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({ fields: w.fields });
  });

  it('职务职位调整只填职位不能把其余场景字段写空', async () => {
    const w = await fixture(database().db, 'trf162-jobpost');
    const before = await w.businessCount();
    await missing(
      await w.create({
        transferTypeCode: 'job_post',
        formId: 'TenantBase.JobPostTransferMultiFormView',
        fields: { positionId: w.fields.positionId, departmentId: w.target },
      }),
      ['postId', 'levelId', 'gradeId', 'sequenceId'],
    );
    expect(await w.businessCount()).toBe(before);
  });

  it('null 和空串不算填写；readonly/hidden/absent 场景字段不要求显式提交', async () => {
    const w = await fixture(database().db, 'trf162-modes');
    const before = await w.businessCount();
    await missing(await w.create({ fields: { ...w.fields, dottedManagerId: null } }), ['dottedManagerId']);
    const blank = await w.create({ fields: { ...w.fields, dottedManagerId: '' } });
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
    const saved = await w.create({ fields: {} });
    expect(saved.status, await saved.clone().text()).toBe(201);
  });

  it('PATCH 合并草稿原有显式字段，清空必填字段被拒且保持 revision', async () => {
    const w = await fixture(database().db, 'trf162-patch');
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
    await missing(
      await w.request(w.hr.id, 'PATCH', `${base}/businesses/${draft.id}`, {
        ifMatch: after.revision,
        body: { fields: { dottedManagerId: null } },
      }),
      ['dottedManagerId'],
    );
    expect(await w.business(draft.id)).toMatchObject({ revision: after.revision, fields: w.fields });
  });

  it('旧草稿提交重新校验缺失字段，不能绕过升级后的保存规则', async () => {
    const { db } = database();
    const w = await fixture(db, 'trf162-old-draft');
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
      excluded,
    );
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft', revision: draft.revision + 1 });
  });

  it('预览允许未填字段；legacy standard 通用任职入口不新增场景必填要求', async () => {
    const w = await fixture(database().db, 'trf162-preview');
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
