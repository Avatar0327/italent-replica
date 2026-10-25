/** F-322 / DEC-685：实习建档、资料、教育反写、任职和合同同一命令事务。 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT, SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { createWorld, NOW, type CreateWorld } from './AC-IN-BE-R2d4c-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = () => createWorld(database().db, `f322-${uniqueSuffix()}`);
const educationObject = SUBSETS.education.objectCode;
const profile = () => ({
  backupMail: 'personal@example.com',
  mobilePhone: 'SYNTHETIC-PHONE',
  gender: 'female',
  birthday: '2003-02-04',
  engName: 'Synthetic Intern',
  idType: 'id_card',
  idNumber: `SYN-${uniqueSuffix()}`,
  dailyWageStandard: '123456789012.34',
  educationLevel: '合成本科',
  lastSchool: '合成大学',
  major: '合成专业',
  graduateDate: '2026-06-30',
});
const contract = (c: CreateWorld) => ({
  typeId: c.typeId,
  companyId: c.companyId,
  termType: 'fixed',
  endDate: '2027-09-30',
});
function request(c: CreateWorld, authorize?: Authorizer) {
  const api = tenantApi(database().db, { clock: () => NOW, ...(authorize ? { authorize } : {}) });
  return (method: string, path: string, body?: object, ifMatch = 0, key = randomUUID()) =>
    api.request(method, `/api/tenant/${path}`, {
      user: c.w.session.user.id,
      tenant: c.w.session.tenant.id,
      body,
      ifMatch,
      idempotencyKey: key,
    });
}
async function read(c: CreateWorld, id: string) {
  const res = await request(c)('GET', `personnel/employees/${id}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
async function stored(c: CreateWorld) {
  return withTenant(database().db, c.w.session.tenant.id, async (tx) => ({
    versions: rows(await tx.execute(sql`SELECT * FROM personnel_employee_versions ORDER BY employee_id,revision`)),
    education: rows(await tx.execute(sql`SELECT * FROM personnel_education ORDER BY id`)),
    educationVersions: rows(
      await tx.execute(sql`SELECT * FROM personnel_education_versions ORDER BY record_id,revision`),
    ),
    audits: rows(
      await tx.execute(sql`SELECT * FROM audit_events
      WHERE object_type IN (${PERSONNEL_OBJECT},${educationObject}) ORDER BY id`),
    ),
  }));
}
async function create(c: CreateWorld, values: object, extra: object = {}) {
  const res = await c.create(c.hireBody({ contract: contract(c), profile: values, ...extra }));
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { employeeId: string; profile: Record<string, unknown> };
}

describe('AC-IN-F322 全字段一体写入', () => {
  it('全字段精确读回、教育一条、最高学历和主专业反写、逐字段审计；同键不重复建档', async () => {
    const c = await world();
    const values = profile();
    const body = c.hireBody({ contract: contract(c), profile: values });
    const key = randomUUID();
    const res = await c.create(body, { key });
    expect(res.status, await res.clone().text()).toBe(201);
    const receipt = (await res.json()) as { employeeId: string; profile: object };
    expect(receipt.profile).toMatchObject(values);
    expect(await read(c, receipt.employeeId)).toMatchObject(values);
    const before = await stored(c);
    expect(before.education).toMatchObject([
      {
        employee_id: receipt.employeeId,
        school: values.lastSchool,
        major: values.major,
        education_level: values.educationLevel,
        is_highest_education: true,
        is_main_major: true,
        end_date: '2026-06-30',
      },
    ]);
    const after = Object.assign({}, ...before.audits.map((a) => a.after));
    expect(after).toMatchObject(values);
    expect(before.audits.every((a) => a.command_id === key)).toBe(true);
    expect(await (await c.create(body, { key })).json()).toEqual(receipt);
    expect(await stored(c)).toEqual(before);
    expect((await c.create({ ...body, profile: { ...values, backupMail: null } }, { key })).status).toBe(409);
  });

  it('未来入职也写入资料与教育；未提供教育三项时不建子集', async () => {
    const c = await world();
    const first = await create(c, profile(), {
      effectiveDate: '2026-10-20',
      contract: { endDate: '2027-10-19', companyId: c.companyId },
    });
    expect(await read(c, first.employeeId)).toMatchObject({ dailyWageStandard: '123456789012.34' });
    await create(c, { dailyWageStandard: '0', backupMail: null });
    expect((await stored(c)).education).toHaveLength(1);
  });

  it('教育只给一项仍建一条；三项显式 null 依现有可空语义保存', async () => {
    const c = await world();
    const first = await create(c, { lastSchool: '合成学校' });
    expect(await read(c, first.employeeId)).toMatchObject({
      lastSchool: '合成学校',
      major: null,
      educationLevel: null,
    });
    await create(c, { educationLevel: null, lastSchool: null, major: null });
    expect((await stored(c)).education).toHaveLength(2);
  });

  it('重聘提供即覆盖、null 清空、未提供保留；新教育另加一条，旧记录和历史保留并取消旧标记', async () => {
    const c = await world();
    const initial = profile();
    const first = await create(c, initial, { effectiveDate: '2026-09-01' });
    await c.w.leave(first.employeeId, '2026-09-20');
    const old = (await stored(c)).education[0]!;
    const revision = await c.w.revision(first.employeeId);
    const res = await c.create(
      c.rehireBody(first.employeeId, {
        contract: contract(c),
        profile: {
          backupMail: null,
          dailyWageStandard: '250.5',
          educationLevel: '合成硕士',
          lastSchool: '新合成大学',
          major: '新专业',
        },
      }),
      { ifMatch: revision },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await read(c, first.employeeId)).toMatchObject({
      backupMail: null,
      dailyWageStandard: '250.50',
      mobilePhone: initial.mobilePhone,
      idNumber: initial.idNumber,
      educationLevel: '合成硕士',
      lastSchool: '新合成大学',
      major: '新专业',
      graduateDate: null,
    });
    const state = await stored(c);
    expect(state.education).toHaveLength(2);
    expect(state.education.find((r) => r.id === old.id)).toMatchObject({
      school: initial.lastSchool,
      is_highest_education: false,
      is_main_major: false,
      deleted: false,
    });
    expect(state.education.filter((r) => r.is_highest_education && r.is_main_major)).toHaveLength(1);
    expect(
      state.educationVersions.some((r) => r.record_id === old.id && r.is_highest_education && r.is_main_major),
    ).toBe(true);
  });

  it('证件同源：新档案离职后可按所填证件匹配；重聘改证件后旧键不再匹配、新键匹配同一人', async () => {
    const c = await world();
    const values = profile();
    const first = await create(c, values, { effectiveDate: '2026-08-01' });
    await c.w.leave(first.employeeId, '2026-08-20');
    const keys = { idType: values.idType, idNumber: values.idNumber };
    expect(await (await c.w.match(keys)).json()).toMatchObject({
      matched: true,
      candidate: { employeeId: first.employeeId },
    });
    const changed = { ...keys, idNumber: `SYN-NEW-${uniqueSuffix()}` };
    const res = await c.create(
      c.rehireBody(first.employeeId, {
        effectiveDate: '2026-09-01',
        contract: contract(c),
        profile: changed,
      }),
      { ifMatch: await c.w.revision(first.employeeId) },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    await c.w.leave(first.employeeId, '2026-09-20');
    expect(await (await c.w.match(keys)).json()).toEqual({ matched: false });
    expect(await (await c.w.match(changed)).json()).toMatchObject({
      matched: true,
      candidate: { employeeId: first.employeeId },
    });
    // 同一证件两名离职人员沿用原查重歧义判定，不擅自新增唯一性规则。
    const other = await create(c, changed, { effectiveDate: '2026-09-01' });
    await c.w.leave(other.employeeId, '2026-09-20');
    expect((await c.w.match(changed)).status).toBe(409);
  });

  it.each([false, true])('合同落地失败整体回滚（重聘=%s），档案、教育旧标记和审计均不残留', async (rehire) => {
    const c = await world();
    const first = rehire ? await create(c, profile(), { effectiveDate: '2026-09-01' }) : undefined;
    if (first) await c.w.leave(first.employeeId, '2026-09-20');
    const before = await stored(c);
    const patch = { contract: { ...contract(c), typeId: randomUUID() }, profile: profile() };
    const body = first ? c.rehireBody(first.employeeId, patch) : c.hireBody(patch);
    const result = await c.create(body, { ifMatch: first ? await c.w.revision(first.employeeId) : 0 });
    expect(result.status, await result.clone().text()).toBe(400);
    expect(await result.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await stored(c)).toEqual(before);
    if (!first) expect(await c.employeesByCode(body.code as string)).toEqual([]);
  });

  it.each(['-1', '1.234', 12.34, '1e2'])('日工资复用 F-325 校验：%s 返回 422 且无写入', async (value) => {
    const c = await world();
    const before = await stored(c);
    const res = await c.create(c.hireBody({ contract: contract(c), profile: { dailyWageStandard: value } }));
    expect(res.status, await res.clone().text()).toBe(422);
    expect(await stored(c)).toEqual(before);
  });

  it('跨租户重聘 ID 和部门均拒绝，两侧档案与教育不变', async () => {
    const c = await world();
    const other = await world();
    const left = await other.leftIntern('合成跨租户人员');
    const before = await stored(c);
    const foreign = await stored(other);
    const res = await c.create(c.rehireBody(left.employee.id, { contract: contract(c), profile: profile() }), {
      ifMatch: await other.w.revision(left.employee.id),
    });
    expect(res.status).toBe(404);
    const dept = await c.create(
      c.hireBody({ contract: contract(c), profile: profile(), fields: { departmentId: other.w.org.id } }),
    );
    expect(dept.status).toBeGreaterThanOrEqual(400);
    expect(await stored(c)).toEqual(before);
    expect(await stored(other)).toEqual(foreign);
  });
});

describe('AC-IN-F322 权限、范围及回执', () => {
  it.each(['backupMail', 'mobilePhone', 'gender', 'birthday', 'engName', 'idType', 'idNumber', 'dailyWageStandard'])(
    '档案字段 %s 无编辑权整单 403（含显式 null）',
    async (field) => {
      const c = await world();
      const authorize: Authorizer = (q) => !(q.resource === PERSONNEL_OBJECT && q.fields?.includes(field));
      const before = await stored(c);
      for (const value of [profile()[field as keyof ReturnType<typeof profile>], null]) {
        const res = await c.createAs(authorize, c.hireBody({ contract: contract(c), profile: { [field]: value } }));
        expect(res.status, await res.clone().text()).toBe(403);
      }
      expect(await stored(c)).toEqual(before);
    },
  );

  it.each(['object', 'school', 'isHighestEducation', 'isMainMajor', 'button'])(
    '教育子集 %s 无权时整单 403',
    async (gate) => {
      const c = await world();
      const authorize: Authorizer = (q) => {
        if (gate === 'button') return q.resource !== `${educationObject}#create@list`;
        return !(q.resource === educationObject && (gate === 'object' || q.fields?.includes(gate)));
      };
      const before = await stored(c);
      const res = await c.createAs(authorize, c.hireBody({ contract: contract(c), profile: profile() }));
      expect(res.status, await res.clone().text()).toBe(403);
      expect(await stored(c)).toEqual(before);
    },
  );

  it('教育反写沿用子集权限，不要求不可编辑的档案系统字段；无教育输入不要求教育权', async () => {
    const c = await world();
    const noSystem: Authorizer = (q) =>
      !(
        q.resource === PERSONNEL_OBJECT && q.fields?.some((f) => ['educationLevel', 'lastSchool', 'major'].includes(f))
      );
    expect((await c.createAs(noSystem, c.hireBody({ contract: contract(c), profile: profile() }))).status).toBe(201);
    const noEducation: Authorizer = (q) => q.resource !== educationObject;
    expect(
      (await c.createAs(noEducation, c.hireBody({ contract: contract(c), profile: { backupMail: null } }))).status,
    ).toBe(201);
  });

  it('重放按当前档案字段权裁剪；撤销写权后同键拒绝且不新增版本', async () => {
    const c = await world();
    let edit = true;
    let visible = new Set(['backupMail', 'dailyWageStandard']);
    const authorize: Authorizer = (q) => edit || !(q.resource === PERSONNEL_OBJECT && q.action === 'object.update');
    registerScopeProvider(authorize, {
      scope: async () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true }),
      authorize: async (q) => authorize(q),
      fields: async (_tenant, _user, object) => (object === PERSONNEL_OBJECT ? visible : new Set()),
    });
    const call = request(c, authorize);
    const key = randomUUID();
    const body = c.hireBody({ contract: contract(c), profile: profile() });
    const first = await call('POST', 'employment/interns', body, 0, key);
    expect(first.status, await first.clone().text()).toBe(201);
    const receipt = (await first.json()) as { profile: object };
    expect(receipt.profile).toEqual({ backupMail: 'personal@example.com', dailyWageStandard: '123456789012.34' });
    visible = new Set(['backupMail']);
    const before = await stored(c);
    expect(await (await call('POST', 'employment/interns', body, 0, key)).json()).toMatchObject({
      profile: { backupMail: 'personal@example.com' },
    });
    const replay = await call('POST', 'employment/interns', body, 0, key);
    expect(await replay.text()).not.toContain('123456789012.34');
    edit = false;
    expect((await call('POST', 'employment/interns', body, 0, key)).status).toBe(403);
    expect(await stored(c)).toEqual(before);
  });

  it.each(['scope', 'object'])('仅教育输入：档案 %s 不可查看时省略资料回执，不能提交后返回拒绝', async (denial) => {
    const c = await world();
    const authorize: Authorizer = (q) =>
      !(denial === 'object' && q.resource === PERSONNEL_OBJECT && q.action === 'object.view');
    registerScopeProvider(authorize, {
      scope: async ({ objectCode }) => ({
        ...EMPTY_SCOPE,
        all: denial !== 'scope' || objectCode !== PERSONNEL_OBJECT,
        hasDataPermission: denial !== 'scope' || objectCode !== PERSONNEL_OBJECT,
      }),
      authorize: async (q) => authorize(q),
      fields: async () => new Set(['educationLevel', 'lastSchool', 'major']),
    });
    const res = await c.createAs(authorize, c.hireBody({ contract: contract(c), profile: { lastSchool: '合成学校' } }));
    expect(res.status, await res.clone().text()).toBe(201);
    const receipt = (await res.json()) as { employeeId: string; profile?: object };
    expect(receipt).not.toHaveProperty('profile');
    expect(await read(c, receipt.employeeId)).toMatchObject({ lastSchool: '合成学校' });
    expect((await stored(c)).education).toHaveLength(1);
  });

  it.each([PERSONNEL_OBJECT, educationObject])('独立对象 %s 空数据范围拒绝，不以任职看全部绕过', async (object) => {
    const c = await world();
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async ({ objectCode: current }) => ({
        ...EMPTY_SCOPE,
        all: current !== object,
        hasDataPermission: current !== object,
      }),
      authorize: async () => true,
      fields: async () => new Set(),
    });
    const before = await stored(c);
    const res = await c.createAs(authorize, c.hireBody({ contract: contract(c), profile: profile() }));
    expect(res.status, await res.clone().text()).toBe(404);
    expect(await stored(c)).toEqual(before);
  });
});
