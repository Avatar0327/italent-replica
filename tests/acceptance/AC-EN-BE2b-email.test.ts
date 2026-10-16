/**
 * BE-2b 生成邮箱规则（docs/02_业务建模/34 EN-R12、AC-EN-06）：
 * 规则按组织范围 + 附加人员条件 + 优先级匹配，命中第一条即停止（该条失败不再尝试下一条）；前缀字段 + 后缀，
 * 重名时在最大序号上 +1；前缀为空或含非法字符 → 失败并写失败原因；重聘入职 / 实习转正不生成。
 * 生成只给出邮箱建议（供办理入职表单填写），不预留、不回写人员档案。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addHire,
  addPending,
  businessRevision,
  entryAction,
  entryWorld,
  hireBody,
  type EntryWorld,
} from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface Rule {
  readonly name: string;
  readonly priority: number;
  readonly enabled?: boolean;
  readonly orgIds: readonly string[];
  readonly employTypes?: readonly string[];
  readonly prefixField: 'employeeCode' | 'namePinyin' | 'pinyinInitials';
  readonly domain: string;
}

async function rulesOf(w: EntryWorld) {
  const response = await w.session.request('GET', '/entry-email-rules');
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { revision: number; entryEmailRules: (Rule & { id: string })[] };
}

function putRules(w: EntryWorld, entryEmailRules: readonly object[], revision?: number) {
  return rulesOf(w).then(async (current) =>
    w.session.request('PUT', '/entry-email-rules', {
      ifMatch: revision ?? current.revision,
      body: { entryEmailRules },
    }),
  );
}

async function setRules(w: EntryWorld, rules: readonly Rule[]) {
  const response = await putRules(w, rules);
  expect(response.status, await response.clone().text()).toBe(200);
}

const rule = (w: EntryWorld, patch: Partial<Rule> = {}): Rule => ({
  name: '默认规则',
  priority: 1,
  orgIds: [w.org.id],
  prefixField: 'employeeCode',
  domain: 'example.com',
  ...patch,
});

/** 添加待入职；登录邮箱可指定，用来制造“已被占用”的邮箱。 */
async function pendingEntry(
  w: EntryWorld,
  input: { code: string; loginEmail?: string; orgId?: string; employType?: string; kind?: string },
) {
  const employee = await w.session.employee('邮箱合成员工', input.code);
  const body = hireBody(input.orgId ?? w.org.id, '2026-10-10', { pendingEntry: true });
  const fields = { ...body.fields, employType: input.employType ?? 'internal' };
  const response = await addHire(w.session, employee, {
    ...body,
    fields,
    ...(input.loginEmail ? { loginEmail: input.loginEmail } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const business = (await response.json()) as { id: string };
  return { employee, id: business.id };
}

async function generate(w: EntryWorld, recordId: string, expected = 200) {
  const response = await w.session.request('POST', `/pending-entries/${recordId}/generate-email`, {
    ifMatch: await businessRevision(w, recordId),
    body: {},
  });
  expect(response.status, await response.clone().text()).toBe(expected);
  return (await response.json()) as Record<string, unknown>;
}

describe('BE-2b 邮箱规则配置', () => {
  it('初始为空；整份替换后版本号 +1；旧版本号重提 409；可清空', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-config');
    expect(await rulesOf(w)).toEqual({ revision: 0, entryEmailRules: [] });
    await setRules(w, [
      rule(w),
      rule(w, { name: '第二条', priority: 2, employTypes: ['intern'], domain: 'Intern.Example.com' }),
    ]);
    const saved = await rulesOf(w);
    expect(saved.revision).toBe(1);
    expect(saved.entryEmailRules).toMatchObject([
      { name: '默认规则', priority: 1, enabled: true, orgIds: [w.org.id], employTypes: [], domain: 'example.com' },
      { name: '第二条', employTypes: ['intern'], domain: 'intern.example.com' },
    ]);
    expect((await putRules(w, [rule(w)], 0)).status).toBe(409);
    expect((await putRules(w, [])).status).toBe(200);
    expect(await rulesOf(w)).toEqual({ revision: 2, entryEmailRules: [] });
  });

  it.each([
    ['后缀不合法', { domain: 'not a domain' }],
    ['前缀字段不在白名单', { prefixField: 'idNumber' }],
    ['组织范围为空', { orgIds: [] }],
    ['组织不存在', { orgIds: [randomUUID()] }],
    ['附加条件不在雇佣关系内', { employTypes: ['robot'] }],
    ['优先级为负', { priority: -1 }],
    ['名称为空', { name: ' ' }],
    ['多余字段', { extra: 1 }],
  ])('配置校验：%s → 400，配置不变', async (_name, patch) => {
    const w = await entryWorld(testDb().db, `be2b-em-bad-${_name.length}`);
    const response = await putRules(w, [{ ...rule(w), ...patch }]);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await rulesOf(w)).toEqual({ revision: 0, entryEmailRules: [] });
  });

  it('规则名重复、条数超上限 → 400；没有配置写权限 → 403', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-limits');
    expect((await putRules(w, [rule(w), rule(w)])).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, index) => rule(w, { name: `规则${index}`, priority: index }));
    expect((await putRules(w, many)).status).toBe(400);
    const authorize: Authorizer = (request) => request.action !== 'tenant.employment.configuration.write';
    const denied = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
    const response = await denied.request('PUT', '/api/tenant/employment/entry-email-rules', {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body: { entryEmailRules: [rule(w)] },
    });
    expect(response.status).toBe(403);
    expect((await rulesOf(w)).revision).toBe(0);
  });

  it('租户隔离：别的租户配置的规则不影响本租户', async () => {
    const a = await entryWorld(testDb().db, 'be2b-em-iso-a');
    const b = await entryWorld(testDb().db, 'be2b-em-iso-b');
    await setRules(a, [rule(a)]);
    expect(await rulesOf(b)).toEqual({ revision: 0, entryEmailRules: [] });
    const entry = await pendingEntry(b, { code: 'iso01' });
    expect(await generate(b, entry.id)).toMatchObject({ status: 'no_rule' });
  });
});

describe('BE-2b 生成邮箱（AC-EN-06）', () => {
  it('前缀取工号 + 后缀；邮箱统一小写', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-basic');
    await setRules(w, [rule(w)]);
    const entry = await pendingEntry(w, { code: 'ZhangSan' });
    expect(await generate(w, entry.id)).toMatchObject({ status: 'generated', email: 'zhangsan@example.com' });
  });

  it('重名时在最大序号上 +1（含已被占用两次、序号有空洞）', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-seq');
    await setRules(w, [rule(w)]);
    const taken = ['zhangsan@example.com', 'zhangsan1@example.com'];
    for (const [index, loginEmail] of taken.entries()) await pendingEntry(w, { code: `holder${index}`, loginEmail });
    const first = await pendingEntry(w, { code: 'zhangsan' });
    expect(await generate(w, first.id)).toMatchObject({ status: 'generated', email: 'zhangsan2@example.com' });
    await pendingEntry(w, { code: 'holder9', loginEmail: 'Zhangsan5@Example.com' });
    expect(await generate(w, first.id)).toMatchObject({ email: 'zhangsan6@example.com' });
    // 别的后缀、别的前缀的邮箱不占序号
    await pendingEntry(w, { code: 'holder10', loginEmail: 'zhangsan9@other.com' });
    await pendingEntry(w, { code: 'holder11', loginEmail: 'zhangsanli@example.com' });
    expect(await generate(w, first.id)).toMatchObject({ email: 'zhangsan6@example.com' });
  });

  it('前缀取姓名全拼：读人员档案的拼音，已占用的人员档案工作邮箱同样算占用', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-pinyin');
    await setRules(w, [rule(w, { prefixField: 'namePinyin' })]);
    const entry = await pendingEntry(w, { code: 'py01' });
    const patch = (employeeId: string, body: object, ifMatch: number) =>
      tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00.000Z') }).request(
        'PATCH',
        `/api/tenant/personnel/employees/${employeeId}`,
        { user: w.session.user.id, tenant: w.session.tenant.id, ifMatch, body },
      );
    expect(await generate(w, entry.id)).toMatchObject({ status: 'failed', reason: 'PREFIX_EMPTY' });
    const set = await patch(entry.employee.id, { namePinyin: 'LiSi' }, 0);
    expect(set.status, await set.clone().text()).toBe(200);
    expect(await generate(w, entry.id)).toMatchObject({ status: 'generated', email: 'lisi@example.com' });
    const holder = await pendingEntry(w, { code: 'py02' });
    const mail = await patch(holder.employee.id, { workEmail: 'lisi@example.com' }, 0);
    expect(mail.status, await mail.clone().text()).toBe(200);
    expect(await generate(w, entry.id)).toMatchObject({ status: 'generated', email: 'lisi1@example.com' });
  });

  it('前缀为空或含非法字符 → 失败并写失败原因；命中第一条即停止，不再尝试下一条', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-fail');
    await setRules(w, [
      rule(w, { name: '先命中', priority: 1 }),
      rule(w, { name: '后备', priority: 2, domain: 'backup.example.com' }),
    ]);
    const illegal = await pendingEntry(w, { code: 'li si' });
    const first = await generate(w, illegal.id);
    expect(first).toMatchObject({ status: 'failed', reason: 'PREFIX_ILLEGAL', ruleName: '先命中' });
    expect(first.email).toBeUndefined();
    const audits = await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT after FROM audit_events
        WHERE tenant_id=${w.session.tenant.id} AND action='employment.entry.email_generate'`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { after: unknown }[];
    });
    expect(audits).toMatchObject([{ after: { status: 'failed', reason: 'PREFIX_ILLEGAL' } }]);
  });

  it('按优先级（数字小的先）、组织范围含下级、雇佣关系条件、启用状态匹配', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-match');
    const child = await w.session.org('下级部门', {
      establishedOn: '2026-01-01',
      parents: { admin: { parentId: w.org.id } },
    });
    const outside = await w.session.org('范围外部门', { establishedOn: '2026-01-01' });
    await setRules(w, [
      rule(w, { name: '停用', priority: 0, enabled: false, domain: 'off.example.com' }),
      rule(w, { name: '实习生', priority: 1, employTypes: ['intern'], domain: 'intern.example.com' }),
      rule(w, { name: '低优先', priority: 9, domain: 'low.example.com' }),
      rule(w, { name: '高优先', priority: 2, domain: 'high.example.com' }),
    ]);
    const inChild = await pendingEntry(w, { code: 'm01', orgId: child.id });
    expect(await generate(w, inChild.id)).toMatchObject({ email: 'm01@high.example.com', ruleName: '高优先' });
    const intern = await pendingEntry(w, { code: 'm02', employType: 'intern' });
    expect(await generate(w, intern.id)).toMatchObject({ email: 'm02@intern.example.com' });
    const none = await pendingEntry(w, { code: 'm03', orgId: outside.id });
    expect(await generate(w, none.id)).toMatchObject({ status: 'no_rule' });
  });

  it('重聘入职不生成（EN-R12）', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-rehire');
    await setRules(w, [rule(w)]);
    const employee = await w.session.employee('重聘合成员工', 'rehire01');
    const hired = await w.session.business(employee.id, hireBody(w.org.id, '2026-01-05'), employee.revision);
    const left = await w.session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-03-31', fields: {} },
      hired.employeeRevision,
    );
    const response = await addHire(
      w.session,
      { id: employee.id, revision: left.employeeRevision },
      { ...hireBody(w.org.id, '2026-10-10', { pendingEntry: true }), kind: 'rehire' },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(await generate(w, id)).toMatchObject({ status: 'skipped', reason: 'REHIRE_NOT_GENERATED' });
  });

  it('已取消入职 409、已入职 409、记录不存在 404；body 只接受空对象', async () => {
    const w = await entryWorld(testDb().db, 'be2b-em-state');
    await setRules(w, [rule(w)]);
    const cancelled = await addPending(w, '2026-10-10', '取消合成员工');
    expect((await entryAction(w, cancelled.recordId, 'cancel', {})).status).toBe(200);
    await generate(w, cancelled.recordId, 409);
    const done = await addPending(w, '2026-09-01', '已入职合成员工');
    expect((await entryAction(w, done.recordId, 'complete', { probation: false })).status).toBe(200);
    await generate(w, done.recordId, 409);
    const missing = await w.session.request('POST', `/pending-entries/${randomUUID()}/generate-email`, {
      ifMatch: 1,
      body: {},
    });
    expect(missing.status).toBe(404);
    const live = await addPending(w, '2026-10-10', '多余字段合成员工');
    const extra = await w.session.request('POST', `/pending-entries/${live.recordId}/generate-email`, {
      ifMatch: await businessRevision(w, live.recordId),
      body: { prefix: 'x' },
    });
    expect(extra.status).toBe(400);
  });
});
