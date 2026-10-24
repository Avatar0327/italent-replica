/** F-321：租户用工形式字典、任职与兼职引用、名称披露和劳务筛选。只用合成人员。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { employmentSession, withLoginEmail } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
interface Form {
  id: string;
  code: string;
  name: string;
  category: number | null;
  displayOrder: number;
  effectiveDate: string;
  expiryDate: string;
  enabled: boolean;
  revision: number;
}
async function world(label: string) {
  const db = database().db;
  const s = await employmentSession(db, `f321-${label}`);
  await withTenant(db, s.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      {
        tenantId: s.tenant.id,
        actorUserId: null,
        now: new Date(),
        commandId: randomUUID(),
      },
      { modules: ['employment-forms'] },
    ),
  );
  const list = async () => {
    const r = await s.request('GET', '/employment-forms');
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { items: Form[] }).items;
  };
  const org = await s.org('合成字典部门', { establishedOn: '2020-01-01' });
  const hire = async (code: string | null) => {
    const e = await s.employee();
    return s.business(
      e.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: org.id, employType: 'internal', employmentForm: code },
      },
      e.revision,
    );
  };
  return { db, s, list, org, hire };
}

it('AC-EMP-F321-01：本租户 11 项预置，四类与空类别、排序和日期按取证；重复安装不重复', async () => {
  const w = await world('preset');
  const items = await w.list();
  expect(items).toHaveLength(11);
  const expected = [
    ['第三方员工', 2, 0, '2025-01-01'],
    ['正式员工', 1, 0, '2023-11-20'],
    ['临时工', 2, 0, '2024-08-09'],
    ['实习生', 3, 0, '2023-11-20'],
    ['外包人员', 4, 0, '2023-11-20'],
    ['小时工', 4, 0, '2002-01-01'],
    ['顾问', 1, 0, '2024-09-28'],
    ['兼职人员', 2, 0, '2025-06-29'],
    ['全日制用工方式', null, 1, '2018-01-01'],
    ['非全日制用工方式', null, 2, '2018-01-01'],
    ['劳务派遣', 2, 3, '2022-02-07'],
  ];
  for (const [name, category, displayOrder, effectiveDate] of expected) {
    expect(items.find((i) => i.name === name)).toMatchObject({
      name,
      category,
      displayOrder,
      effectiveDate,
      expiryDate: '9999-12-31',
      enabled: true,
    });
  }
  expect(new Set(items.map((i) => i.code)).size).toBe(11);
  await withTenant(w.db, w.s.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      {
        tenantId: w.s.tenant.id,
        actorUserId: null,
        now: new Date(),
        commandId: randomUUID(),
      },
      { modules: ['employment-forms'] },
    ),
  );
  expect(await w.list()).toEqual(items);
});

it('AC-EMP-F321-02：任职合法编码保存并返回名称；未知值明确 422，失败不产生任职记录', async () => {
  const w = await world('write');
  const form = (await w.list()).find((i) => i.name === '正式员工')!;
  const hired = await w.hire(form.code);
  expect((await w.s.record(hired.id)).fields).toMatchObject({
    employmentForm: form.code,
    employmentFormName: form.name,
  });
  const e = await w.s.employee();
  const rejected = await w.s.request('POST', `/employees/${e.id}/businesses`, {
    ifMatch: e.revision,
    body: withLoginEmail(e.id, {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: w.org.id, employmentForm: '未知用工形式' },
    }),
  });
  expect(rejected.status, await rejected.clone().text()).toBe(422);
  expect(await w.s.records(e.id)).toEqual([]);
});

it('AC-EMP-F321-03：停用项不能新选、历史名称仍可读；配置写带 revision 与命令幂等', async () => {
  const w = await world('disabled');
  const form = (await w.list()).find((i) => i.name === '兼职人员')!;
  const hired = await w.hire(form.code);
  const key = randomUUID();
  const options = { ifMatch: form.revision, idempotencyKey: key, body: { enabled: false } };
  const disabled = await w.s.request('PUT', `/employment-forms/${form.id}`, options);
  expect(disabled.status, await disabled.clone().text()).toBe(200);
  const replay = await w.s.request('PUT', `/employment-forms/${form.id}`, options);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(await disabled.json());
  const stale = await w.s.request('PUT', `/employment-forms/${form.id}`, {
    ifMatch: form.revision,
    body: { enabled: true },
  });
  expect(stale.status).toBe(409);
  const result = await w.s.request('PATCH', `/records/${hired.id}`, {
    ifMatch: hired.revision,
    body: { fields: { employmentForm: form.code } },
  });
  expect(result.status, await result.clone().text()).toBe(422);
  expect((await w.s.record(hired.id)).fields).toMatchObject({ employmentFormName: '兼职人员' });
});

it('AC-EMP-F321-04：兼职新增与编辑复用字典校验，详情读回名称', async () => {
  const w = await world('part-time');
  const hired = await w.hire(null);
  const form = (await w.list()).find((i) => i.name === '兼职人员')!;
  const create = (code: string) =>
    w.s.request('POST', `/employees/${hired.employeeId}/part-times`, {
      ifMatch: hired.employeeRevision,
      body: {
        partTimeType: 'part_time',
        startDate: '2026-09-10',
        fields: { departmentId: w.org.id, employmentForm: code },
      },
    });
  expect((await create('不存在')).status).toBe(422);
  const response = await create(form.code);
  expect(response.status, await response.clone().text()).toBe(201);
  const record = (await response.json()) as { id: string; revision: number };
  const detail = await w.s.request('GET', `/part-times/${record.id}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ fields: { employmentForm: form.code, employmentFormName: form.name } });
  const invalid = await w.s.request('PATCH', `/part-times/${record.id}`, {
    ifMatch: record.revision,
    body: { fields: { employmentForm: '未知' } },
  });
  expect(invalid.status).toBe(422);
});

it('AC-EMP-F321-05：劳务视图只纳入当前在职内部员工且类别=劳务；空类别与外部项排除', async () => {
  const w = await world('labor');
  const forms = await w.list();
  const labor = await w.hire(forms.find((i) => i.name === '兼职人员')!.code);
  await w.hire(forms.find((i) => i.name === '全日制用工方式')!.code);
  await w.hire(forms.find((i) => i.name === '外包人员')!.code);
  await w.hire(null);
  const response = await w.s.request('GET', '/employees?view=labor');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(((await response.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([labor.employeeId]);
});

it('AC-EMP-F321-06：自建项仅本租户可选；跨租户不可读写、不能引用；类别仅四种或空', async () => {
  const a = await world('tenant-a');
  const b = await world('tenant-b');
  const code = `synthetic-${randomUUID()}`;
  const input = {
    code,
    name: '合成测试用工',
    category: 2,
    displayOrder: 5,
    effectiveDate: '2020-01-01',
    expiryDate: '9999-12-31',
    enabled: true,
  };
  const created = await a.s.request('POST', '/employment-forms', { ifMatch: 0, body: input });
  expect(created.status, await created.clone().text()).toBe(201);
  const form = (await created.json()) as Form;
  expect((await b.list()).some((i) => i.code === code)).toBe(false);
  const foreign = await b.s.request('PUT', `/employment-forms/${form.id}`, { ifMatch: 1, body: { name: '不得改名' } });
  expect(foreign.status).toBe(404);
  const e = await b.s.employee();
  const write = await b.s.request('POST', `/employees/${e.id}/businesses`, {
    ifMatch: e.revision,
    body: withLoginEmail(e.id, {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: b.org.id, employmentForm: code },
    }),
  });
  expect(write.status).toBe(422);
  expect(
    (
      await a.s.request('POST', '/employment-forms', {
        ifMatch: 0,
        body: { ...input, code: randomUUID(), category: 5 },
      })
    ).status,
  ).toBe(400);
  const rows = await withTenant(b.db, b.s.tenant.id, (tx) =>
    tx.execute(sql`
    SELECT id FROM employment_forms WHERE tenant_id=${a.s.tenant.id}`),
  );
  expect(Array.isArray(rows) ? rows : rows.rows).toEqual([]);
});

it('AC-EMP-F321-07：字段不可见时不披露派生名称；撤权后的配置命令重放拒绝', async () => {
  const w = await world('permissions');
  const form = (await w.list())[0]!;
  const hired = await w.hire(form.code);
  const api = tenantApi(w.db, {
    authorize: (r) => r.action !== 'field.view' || !r.resource?.endsWith('#employmentForm'),
  });
  const detail = await api.request('GET', `/api/tenant/employment/records/${hired.id}`, {
    user: w.s.user.id,
    tenant: w.s.tenant.id,
  });
  expect(detail.status).toBe(200);
  expect(JSON.stringify(await detail.json())).not.toContain('employmentFormName');
  const key = randomUUID();
  expect(
    (
      await w.s.request('PUT', `/employment-forms/${form.id}`, {
        ifMatch: form.revision,
        idempotencyKey: key,
        body: { enabled: false },
      })
    ).status,
  ).toBe(200);
  const denied = tenantApi(w.db, { authorize: (r) => r.action !== 'tenant.employment.configuration.write' });
  const replay = await denied.request('PUT', `/api/tenant/employment/employment-forms/${form.id}`, {
    user: w.s.user.id,
    tenant: w.s.tenant.id,
    ifMatch: form.revision,
    idempotencyKey: key,
    body: { enabled: false },
  });
  expect(replay.status).toBe(403);
});

it('AC-EMP-F321-08：原自由文本入口直接拒绝未知值 422（不依赖字典读取新接口）', async () => {
  const w = await world('old-path');
  const e = await w.s.employee();
  const response = await w.s.request('POST', `/employees/${e.id}/businesses`, {
    ifMatch: e.revision,
    body: withLoginEmail(e.id, {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: w.org.id, employmentForm: '不存在的合成用工形式' },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(422);
});
