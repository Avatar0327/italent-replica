/** DEC-914：社保引用名称只在裁剪后的读取出口附加，真实 HTTP 覆盖审批及原值接口。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { controlledApi, D } from './AC-LNK-support.js';
import { asOwner, seedInsuranceWorld } from './support/insurance-tables.js';
import { uniqueSuffix } from './support/unique.js';

import { referenceNames } from '../../apps/api/src/modules/approval/reference-names.js';
import { insuranceReadWorld, originUrl } from './support/insurance-read.js';

const database = useTestDb();
const AT = '2026-10-01T01:00:00Z';
const PROFILE = MODULE_OBJECTS.socialSecurityProfile;
const FORM = [
  'departmentId',
  'effectiveDate',
  'adjustedInsuranceRegionCode',
  'adjustedInsurancePlanId',
  'adjustedInsuranceCompanyId',
];
const ORIGIN = {
  region: 'insuranceOrigin.regionCode',
  plan: 'insuranceOrigin.planId',
  company: 'insuranceOrigin.companyId',
} as const;

async function scene(label: string, adjust: 'all' | 'region-plan' | 'none' = 'all') {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({
    nodes: [
      {
        key: 'review',
        approver: { type: 'department', value: 'latest_record_department_head' },
        formFields: FORM,
        editableFields: ['departmentId'],
        editMode: 'separate',
      },
    ],
  });
  const tenantId = w.tenant.id;
  const own = async <T>(run: (tx: Parameters<Parameters<typeof asOwner>[2]>[0]) => Promise<T>) =>
    asOwner(w.db, tenantId, run);
  const company = async (code: string) => {
    const id = randomUUID();
    await own((tx) =>
      tx.execute(sql`INSERT INTO contract_companies (id, tenant_id, code, name, enabled)
        VALUES (${id}, ${tenantId}, ${`${code}-${uniqueSuffix()}`}, ${`公司${code}`}, true)`),
    );
    return id;
  };
  const plan = async (code: string, region: string) => {
    const id = randomUUID();
    await own(async (tx) => {
      await tx.execute(sql`INSERT INTO social_insurance_plans (tenant_id, id, code)
        VALUES (${tenantId}, ${id}, ${`${code}-${uniqueSuffix()}`})`);
      await tx.execute(sql`INSERT INTO social_insurance_plan_versions
        (tenant_id, plan_id, name, region_code, effective_month, enabled)
        VALUES (${tenantId}, ${id}, ${`方案${code}`}, ${region}, '2026-01-01', true)`);
    });
    return id;
  };
  const [oldPlan, newPlan, oldCompany, newCompany] = [
    await plan('OLD', '440100'),
    await plan('NEW', '110105'),
    await company('OLD'),
    await company('NEW'),
  ];
  // 员工已有的社保档案（原值）：由更早的一条业务写入
  const earlier = randomUUID();
  await own(async (tx) => {
    await tx.execute(sql`INSERT INTO employment_business_objects (id, tenant_id, employee_id)
      VALUES (${earlier}, ${tenantId}, ${s.subject.employeeId})`);
    await tx.execute(sql`INSERT INTO social_insurance_archive_versions
      (tenant_id, employee_id, version_no, effective_date, planned_effective_date, operation_seq,
       region_code, plan_id, company_id, source, source_business_id, command_id)
      VALUES (${tenantId}, ${s.subject.employeeId}, 1, '2026-09-01', '2026-09-01', 1, '440100', ${oldPlan},
        ${oldCompany}, 'transfer', ${earlier}, ${`cmd-${uniqueSuffix()}`})`);
  });
  const linkage =
    adjust === 'none'
      ? {}
      : {
          adjustedInsuranceRegionCode: '110105',
          adjustedInsurancePlanId: newPlan,
          ...(adjust === 'all' ? { adjustedInsuranceCompanyId: newCompany } : {}),
        };
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
  );
  const draft = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/transfers/employees/${s.subject.employeeId}`, {
      ifMatch: employee.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'application',
        effectiveDate: D,
        fields: { departmentId: s.to },
        linkage,
      },
    }),
    201,
  );
  const instance = await w.submit(draft);
  const view = async (grants: Parameters<typeof controlledApi>[3] = {}) => {
    const request = controlledApi(w.db, tenantId, s.outHead.userId, grants, AT);
    const response = await request('GET', `/api/tenant/approval/instances/${instance.id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return { request, body: (await response.json()) as InstanceView };
  };
  return { w, s, instance, view, own, ids: { oldPlan, newPlan, oldCompany, newCompany } };
}

const EXPECTED = {
  adjustedInsurancePlanIdName: '方案NEW',
  adjustedInsuranceCompanyIdName: '公司NEW',
  'insuranceOrigin.planIdName': '方案OLD',
  'insuranceOrigin.companyIdName': '公司OLD',
};
const noCandidates = (request: { action: string; resource?: string }) =>
  request.action === 'object.view' &&
  [MODULE_OBJECTS.socialInsurancePlan.code, MODULE_OBJECTS.contractCompany.code].includes(request.resource ?? '');

function absent(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    expect(Object.hasOwn(values, key), key).toBe(false);
    expect(Object.hasOwn(values, `${key}Name`), `${key}Name`).toBe(false);
  }
}

describe('AC-F474-8c3n / DEC-914 审批名称披露', () => {
  it('无方案和公司查看权仍显示四个名称；审批编辑的只读值共用详情', async () => {
    const { view, ids } = await scene('names-visible');
    const { request, body } = await view({ deny: noCandidates });
    expect((await request('GET', '/api/tenant/insurance/plans?regionCode=110105')).status).toBe(403);
    expect((await request('GET', '/api/tenant/insurance/companies')).status).toBe(403);
    expect(body.actions).toContain('edit');
    expect(body.form.values).toMatchObject({
      adjustedInsurancePlanId: ids.newPlan,
      adjustedInsuranceCompanyId: ids.newCompany,
      [ORIGIN.plan]: ids.oldPlan,
      [ORIGIN.company]: ids.oldCompany,
      ...EXPECTED,
    });
  });

  it('撤档案对象、分别撤原值字段、分别撤调整字段：ID 与名称同步缺席，其余值保留', async () => {
    const { view } = await scene('names-permissions');
    expect((await view()).body.form.values).toMatchObject(EXPECTED);
    const denied = await view({ deny: (r) => r.action === 'object.view' && r.resource === PROFILE.code });
    absent(denied.body.form.values, Object.values(ORIGIN));
    expect(denied.body.form.values).toMatchObject({
      adjustedInsurancePlanIdName: '方案NEW',
      adjustedInsuranceCompanyIdName: '公司NEW',
    });
    for (const [field, key, other] of [
      ['insurancePlanId', ORIGIN.plan, ORIGIN.company],
      ['insuranceCompanyId', ORIGIN.company, ORIGIN.plan],
    ]) {
      const fields = PROFILE.fields.map((f) => f.code).filter((f) => f !== field);
      const { body } = await view({ fields: { [PROFILE.code]: fields } });
      absent(body.form.values, [key!]);
      expect(body.form.values[`${other}Name`]).toBe(EXPECTED[`${other}Name` as keyof typeof EXPECTED]);
    }
    for (const key of ['adjustedInsurancePlanId', 'adjustedInsuranceCompanyId']) {
      const employment = MODULE_OBJECTS.employmentRecord;
      const fields = employment.fields.map((f) => f.code).filter((f) => f !== key);
      const { body } = await view({ fields: { [employment.code]: fields } });
      absent(body.form.values, [key]);
      expect(body.actions).not.toContain('approve');
    }
  });

  it('停用与后续改名按调动月取名；日期不可见仍取正确版本；改名不使在途审批 409，已办仍带名称', async () => {
    const { view, own, ids, w } = await scene('names-month');
    const before = await view({ deny: noCandidates });
    await own(async (tx) => {
      await tx.execute(sql`UPDATE social_insurance_plan_versions SET stop_month='2026-11-01', enabled=false
        WHERE tenant_id=${w.tenant.id} AND plan_id IN (${ids.oldPlan}, ${ids.newPlan})`);
      for (const id of [ids.oldPlan, ids.newPlan])
        await tx.execute(sql`INSERT INTO social_insurance_plan_versions
          (tenant_id,plan_id,name,region_code,effective_month) VALUES
          (${w.tenant.id},${id},'后月改名','110105','2026-11-01')`);
      await tx.execute(sql`UPDATE contract_companies SET enabled=false
        WHERE tenant_id=${w.tenant.id} AND id IN (${ids.oldCompany},${ids.newCompany})`);
    });
    expect((await view()).body.form.values).toMatchObject(EXPECTED);
    const employment = MODULE_OBJECTS.employmentRecord;
    const hiddenDate = await view({
      fields: {
        [employment.code]: employment.fields.map((f) => f.code).filter((f) => f !== 'effectiveDate'),
      },
    });
    expect(hiddenDate.body.form.values).not.toHaveProperty('effectiveDate');
    expect(hiddenDate.body.form.values).toMatchObject(EXPECTED);
    const task = before.body.tasks.find((t) => t.status === 'pending')!;
    const approved = await before.request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: before.body.revision,
      body: {},
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const handled = (await view({ deny: noCandidates })).body;
    expect(handled).toMatchObject({ contentView: { mode: 'frozen' } });
    expect(handled.form.values).toMatchObject(EXPECTED);
    const revoked = await view({ deny: (r) => r.action === 'object.view' && r.resource === PROFILE.code });
    absent(revoked.body.form.values, Object.values(ORIGIN));
  });

  it('生效月已过停用月时取最近版本；没填写的公司不生成名称', async () => {
    const { view, own, w, ids } = await scene('names-fallback', 'region-plan');
    await own((tx) =>
      tx.execute(sql`UPDATE social_insurance_plan_versions SET stop_month='2026-09-01'
      WHERE tenant_id=${w.tenant.id} AND plan_id=${ids.oldPlan}`),
    );
    const { body } = await view();
    expect(body.form.values).toMatchObject({ 'insuranceOrigin.planIdName': '方案OLD' });
    absent(body.form.values, ['adjustedInsuranceCompanyId', ORIGIN.company]);
  });

  it('引用名称单一出口：跨租户、不存在为 null；空 ID 不附名；已有冻结标签不覆盖', async () => {
    const { w, view } = await scene('names-foreign');
    const foreign = await seedInsuranceWorld(w.db, 'names-other');
    const { body } = await view();
    // 外键阻止业务载荷保存越租户 ID；直接对同一披露出口送入历史 / 缺失引用，验证防御性读取。
    const values = {
      adjustedInsurancePlanId: foreign.planId,
      adjustedInsuranceCompanyId: foreign.companyId,
      [ORIGIN.plan]: randomUUID(),
      [ORIGIN.company]: randomUUID(),
    };
    const named = await withTenant(w.db, w.tenant.id, (tx) =>
      referenceNames(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.hr.id,
          timezone: 'Asia/Shanghai',
          now: new Date(AT),
        },
        'transfer',
        { ...body, form: { values } },
      ),
    );
    expect(named.form.values).toEqual({
      ...values,
      ...Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, null])),
    });
    const frozen = await withTenant(w.db, w.tenant.id, (tx) =>
      referenceNames(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.hr.id,
          timezone: 'Asia/Shanghai',
          now: new Date(AT),
        },
        'transfer',
        {
          form: {
            values: {
              adjustedInsurancePlanId: foreign.planId,
              adjustedInsurancePlanIdName: '办理时标签',
              adjustedInsuranceCompanyId: null,
            },
          },
        },
      ),
    );
    expect(frozen.form.values).toEqual({
      adjustedInsurancePlanId: foreign.planId,
      adjustedInsurancePlanIdName: '办理时标签',
      adjustedInsuranceCompanyId: null,
    });
  });
});

describe('AC-F474-8c3n / DEC-914 原值接口名称', () => {
  it('无候选权限：按请求生效月取版本，停用 / 未生效回退最近版本；空档案名称为 null', async () => {
    const r = await insuranceReadWorld(database().db, 'names-origin');
    const { employee } = await r.w.hired();
    const planId = await r.plan('旧月', '110105', '2026-01-01', { stop: '2026-11-01', enabled: false });
    const companyId = await r.company('停用', false);
    await asOwner(database().db, r.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO social_insurance_plan_versions
      (tenant_id,plan_id,name,region_code,effective_month) VALUES
      (${r.tenantId},${planId},'后月方案','110105','2026-11-01')`),
    );
    await r.archive({
      employeeId: employee.id,
      versionNo: 1,
      businessId: await r.extraBusiness(employee.id),
      effectiveDate: '2026-09-01',
      seq: 1,
      planId,
      companyId,
    });
    const caller = await r.caller({ plan: false, company: false });
    for (const [date, name] of [
      ['2026-10-31', '方案旧月'],
      ['2026-11-01', '后月方案'],
    ]) {
      const res = await caller.get(originUrl(employee.id, date!));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        regionCode: null,
        planId,
        companyId,
        planName: name,
        companyName: '公司停用',
      });
    }
    await asOwner(database().db, r.tenantId, (tx) =>
      tx.execute(sql`UPDATE social_insurance_plan_versions
      SET stop_month='2026-10-01' WHERE tenant_id=${r.tenantId} AND plan_id=${planId} AND effective_month='2026-01-01'`),
    );
    const gap = await caller.get(originUrl(employee.id, '2026-10-01'));
    expect(await gap.json()).toMatchObject({ planName: '后月方案', companyName: '公司停用' });
    const empty = await caller.get(originUrl(employee.id, '2026-08-31'));
    expect(await empty.json()).toEqual({
      regionCode: null,
      planId: null,
      companyId: null,
      planName: null,
      companyName: null,
    });
  });
});
