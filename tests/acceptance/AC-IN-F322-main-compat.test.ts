/** F-322 合 main：F-321 用工形式与 F-325 日工资标准同单写入，不改变两者契约。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { createWorld, type CreateWorld } from './AC-IN-BE-R2d4c-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = () => createWorld(database().db, `f322-main-${uniqueSuffix()}`);
async function form(c: CreateWorld, enabled = true) {
  const code = `synthetic_${uniqueSuffix()}`;
  const response = await c.w.session.request('POST', '/employment-forms', {
    ifMatch: 0,
    body: {
      code,
      name: '合成实习用工形式',
      category: 3,
      displayOrder: 0,
      effectiveDate: '2023-11-20',
      expiryDate: '9999-12-31',
      enabled,
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return code;
}
function input(c: CreateWorld, employmentForm: string) {
  return c.hireBody({
    fields: { departmentId: c.w.org.id, employmentForm },
    contract: { typeId: c.typeId, companyId: c.companyId, endDate: '2027-09-30' },
    profile: {
      backupMail: 'synthetic@example.com',
      dailyWageStandard: '123456789012.34',
      lastSchool: '合成学校',
      educationLevel: '合成本科',
      major: '合成专业',
    },
  });
}
const snapshot = (c: CreateWorld) =>
  withTenant(database().db, c.w.session.tenant.id, async (tx) => ({
    employees: rows(await tx.execute(sql`SELECT * FROM employment_employees ORDER BY id`)),
    employment: rows(await tx.execute(sql`SELECT * FROM employment_records ORDER BY id`)),
    profile: rows(await tx.execute(sql`SELECT * FROM personnel_employee_versions ORDER BY employee_id,revision`)),
    education: rows(await tx.execute(sql`SELECT * FROM personnel_education ORDER BY id`)),
    educationVersions: rows(await tx.execute(sql`SELECT * FROM personnel_education_versions ORDER BY id`)),
    contracts: rows(await tx.execute(sql`SELECT * FROM contract_records ORDER BY id`)),
  }));

it('AC-IN-F322-M1：启用的动态用工形式与精确工资、教育资料同单保存；名称读回与幂等保持', async () => {
  const c = await world();
  const code = await form(c);
  const body = input(c, code);
  const key = randomUUID();
  const response = await c.create(body, { key });
  expect(response.status, await response.clone().text()).toBe(201);
  const receipt = (await response.json()) as { employeeId: string; profile: object };
  expect(receipt.profile).toMatchObject({ dailyWageStandard: '123456789012.34', lastSchool: '合成学校' });
  expect(await c.w.session.records(receipt.employeeId)).toMatchObject([
    {
      fields: { employType: 'intern', employmentForm: code, employmentFormName: '合成实习用工形式' },
    },
  ]);
  const before = await snapshot(c);
  expect(before.profile.at(-1)).toMatchObject({ daily_wage_standard: '123456789012.34', last_school: '合成学校' });
  expect(before.education).toMatchObject([
    {
      school: '合成学校',
      is_highest_education: true,
      is_main_major: true,
    },
  ]);
  expect(await (await c.create(body, { key })).json()).toEqual(receipt);
  expect(await snapshot(c)).toEqual(before);
});

it.each(['unknown', 'disabled', 'foreign'] as const)(
  'AC-IN-F322-M1：%s 用工形式明确拒绝，档案工资、教育和任职合同均不残留',
  async (kind) => {
    const c = await world();
    const other = kind === 'foreign' ? await world() : undefined;
    const code = kind === 'unknown' ? `missing_${uniqueSuffix()}` : await form(other ?? c, kind !== 'disabled');
    const before = await snapshot(c);
    const otherBefore = other ? await snapshot(other) : undefined;
    const response = await c.create(input(c, code));
    expect(response.status, await response.clone().text()).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'EMPLOYMENT_FORM_INVALID' } });
    expect(await snapshot(c)).toEqual(before);
    if (other) expect(await snapshot(other)).toEqual(otherBefore);
  },
);
