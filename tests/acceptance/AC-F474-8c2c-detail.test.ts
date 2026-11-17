/**
 * F-474-8c-2c 审批详情（AC-INS-08，设计 §3.4 / §4.3，DEC-057 / 058 / 896④）：
 * 详情只列本单变化的社保项：新值 +“原: 旧值”；没变就整组不显示；原值的可见性只看社保档案对象的查看权
 * （对象查看 + 该字段查看，不查员工范围）；调整字段属于任职记录对象，仍受盲审约束。真实 HTTP + 真实授权判定。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { controlledApi, D } from './AC-LNK-support.js';
import { asOwner } from './support/insurance-tables.js';
import { uniqueSuffix } from './support/unique.js';

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

async function scene(label: string, adjust: 'all' | 'region-plan' | 'none') {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({
    nodes: [
      {
        key: 'review',
        approver: { type: 'department', value: 'latest_record_department_head' },
        formFields: FORM,
        editableFields: [],
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
  return { w, s, instance, view, ids: { oldPlan, newPlan, oldCompany, newCompany } };
}

const noProfile = (request: { action: string; resource?: string }) =>
  request.action === 'object.view' && request.resource === PROFILE.code;

describe('AC-INS-08 审批详情只列变化项：新值 +“原: 旧值”', () => {
  it('只改地区和方案：这两项带原值，公司整项不显示', async () => {
    const { view, ids } = await scene('ins-detail-changed', 'region-plan');
    const { body } = await view();
    const values = body.form.values;
    expect(values).toMatchObject({
      adjustedInsuranceRegionCode: '110105',
      adjustedInsurancePlanId: ids.newPlan,
      [ORIGIN.region]: '440100',
      [ORIGIN.plan]: ids.oldPlan,
    });
    expect(Object.keys(values)).not.toContain('adjustedInsuranceCompanyId');
    expect(Object.keys(values)).not.toContain(ORIGIN.company);
  });

  it('三项都改：三项都带原值', async () => {
    const { view, ids } = await scene('ins-detail-all', 'all');
    const { body } = await view();
    expect(body.form.values).toMatchObject({
      adjustedInsuranceCompanyId: ids.newCompany,
      [ORIGIN.company]: ids.oldCompany,
    });
  });

  it('没有任何社保调整：整组都不显示', async () => {
    const { view } = await scene('ins-detail-none', 'none');
    const { body } = await view();
    const keys = Object.keys(body.form.values);
    expect(keys.filter((key) => key.startsWith('adjustedInsurance') || key.startsWith('insuranceOrigin'))).toEqual([]);
  });
});

describe('AC-INS-08 原值披露只看社保档案查看权（DEC-896④）', () => {
  it('没有社保档案对象查看权：看得到新值，看不到原值', async () => {
    const { view, ids } = await scene('ins-detail-no-profile', 'region-plan');
    const { body } = await view({ deny: noProfile });
    expect(body.form.values).toMatchObject({
      adjustedInsuranceRegionCode: '110105',
      adjustedInsurancePlanId: ids.newPlan,
    });
    expect(Object.keys(body.form.values).filter((key) => key.startsWith('insuranceOrigin'))).toEqual([]);
  });

  it('只授地区字段的查看权：只披露地区原值，方案原值不披露', async () => {
    const { view } = await scene('ins-detail-field', 'region-plan');
    const { body } = await view({ fields: { [PROFILE.code]: ['insuranceRegionCode'] } });
    expect(body.form.values).toMatchObject({ [ORIGIN.region]: '440100' });
    expect(Object.keys(body.form.values)).not.toContain(ORIGIN.plan);
  });

  it('不查员工数据范围：范围为空但对象 / 字段有查看权，原值照常披露', async () => {
    const { view } = await scene('ins-detail-scope', 'region-plan');
    const { body } = await view({
      scopes: {
        [PROFILE.code]: { all: false, orgIds: [], personIds: [], terms: [], hasDataPermission: false } as never,
      },
    });
    expect(body.form.values).toMatchObject({ [ORIGIN.region]: '440100' });
  });

  it('看不到原值不影响审批：原值不是“变化字段”，审批人照常能同意', async () => {
    const { view, instance } = await scene('ins-detail-approve', 'region-plan');
    const { request, body } = await view({ deny: noProfile });
    expect(body.actions).toContain('approve');
    const task = body.tasks.find((t) => t.status === 'pending')!;
    const approve = await request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approve.status, await approve.clone().text()).toBe(200);
  });

  it('调整字段是任职记录对象字段：看不到方案调整字段的审批人被盲审拦下（403）', async () => {
    const { view, instance } = await scene('ins-detail-blind', 'region-plan');
    const employment = MODULE_OBJECTS.employmentRecord;
    const visible = employment.fields.map((f) => f.code).filter((code) => code !== 'adjustedInsurancePlanId');
    const { request, body } = await view({ fields: { [employment.code]: visible } });
    expect(Object.keys(body.form.values)).not.toContain('adjustedInsurancePlanId');
    expect(body.actions).not.toContain('approve');
    const task = body.tasks.find((t) => t.status === 'pending')!;
    const approve = await request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(approve.status).toBe(403);
    expect(await approve.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
  });
});
