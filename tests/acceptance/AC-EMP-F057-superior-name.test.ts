/**
 * F-057 / DEC-325③ / DEC-327：可见人员的范围外上级显示姓名，头像固定留空（真实头像由 F-058 后补）。
 * 姓名展示不授予上级独立访问权，不携带邮箱、部门、证件照等其他资料；字段撤权与幂等重放按当前权限裁剪。
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { type ObjectPermissionBody, type PersonView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();
const APP = survey360.SURVEY360_APP;
const PERSON = survey360.SURVEY360_OBJECTS.person;

interface SuperiorSummary {
  id: string;
  name?: string;
  avatar: null;
}

type PersonResponse = PersonView & { superior?: SuperiorSummary | null };

async function hire(w: World360, name: string, orgId: string, managerId?: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
  return employee;
}

async function finePermission(w: World360, enabled: boolean) {
  const current = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
  await w.ok(w.request('PUT', '/settings', { ifMatch: current.revision, body: { finePermission: enabled } }));
}

async function people(w: World360, by: World360['request'] = w.request) {
  return (await w.ok<{ items: PersonResponse[] }>(by('GET', '/people?pageSize=200'))).items;
}

async function scene(label: string, fine = true) {
  const w = await world360(testDb().db, label);
  const orgA = await w.session.org('可见部门', { establishedOn: '2025-01-01' });
  const orgB = await w.session.org('范围外部门标记', { establishedOn: '2025-01-01' });
  const bossEmployee = await hire(w, '范围外上级姓名', orgB.id);
  const subEmployee = await hire(w, '可见下属', orgA.id, bossEmployee.id);
  const aloneEmployee = await hire(w, '没有上级的员工', orgA.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const all = await people(w);
  const personOf = (employeeId: string) => all.find((person) => person.employeeId === employeeId)!;
  const boss = personOf(bossEmployee.id);
  const sub = personOf(subEmployee.id);
  const alone = personOf(aloneEmployee.id);
  expect(sub.superiorPersonId).toBe(boss.id);

  const advanced = survey360.SURVEY360_PROFILES.find((p) => p.code === 'standard_360_advanced_admin')!;
  const profileId = await w.defineProfile('姓名摘要测试身份', advanced.objects);
  const user = await w.member('姓名摘要查看人');
  await w.grantProfile(user, profileId);
  const mou = async (suffix: string, orgId: string) =>
    (
      await w.ok<{ id: string }>(
        w.enterprise('POST', '/mous', {
          ifMatch: 0,
          body: {
            code: `${label}-${suffix}`,
            name: suffix,
            orgRanges: [{ orgId, includeDescendants: true }],
          },
        }),
        201,
      )
    ).id;
  const visibleMou = await mou('visible', orgA.id);
  const hiddenMou = await mou('hidden', orgB.id);
  const scope = await w.ok<{ revision: number }>(
    w.enterprise('PUT', `/scopes/${user}/${APP}`, { ifMatch: 0, body: { kind: 'mou', mouId: visibleMou } }),
  );
  if (fine) await finePermission(w, true);
  const as = w.as(user);

  /** 经真实身份资料字段权限撤权；重放载荷只含 position，避免被写字段权限先拒绝而漏测响应裁剪。 */
  async function hidePersonFields(hidden: readonly string[]) {
    const original = advanced.objects.find((object) => object.objectCode === PERSON.code)!;
    const { objectCode: _objectCode, ...permissions } = original;
    const body: Omit<ObjectPermissionBody, 'objectCode'> = {
      ...permissions,
      fields: PERSON.fields.map((field) => ({
        fieldCode: field.code,
        view: !hidden.includes(field.code),
        edit: !field.system && !hidden.includes(field.code),
      })),
    };
    const profile = await w.ok<{ revision: number }>(w.enterprise('GET', `/profiles/${profileId}`));
    await w.ok(
      w.enterprise('PUT', `/profiles/${profileId}/objects/${PERSON.code}`, { ifMatch: profile.revision, body }),
    );
  }

  async function moveViewerAway() {
    await w.ok(
      w.enterprise('PUT', `/scopes/${user}/${APP}`, {
        ifMatch: scope.revision,
        body: { kind: 'mou', mouId: hiddenMou },
      }),
    );
  }

  const summary: SuperiorSummary = { id: boss.id, name: boss.name, avatar: null };
  const assertSummary = (body: PersonResponse, expected: SuperiorSummary = summary) => {
    expect(body.superiorPersonId).toBe(boss.id);
    expect(body.superior).toEqual(expected);
    for (const marker of [boss.email, boss.department, bossEmployee.id])
      if (marker) expect(JSON.stringify(body)).not.toContain(marker);
  };
  const put = (key: string, revision = sub.revision) =>
    as('PUT', `/people/${sub.id}`, {
      ifMatch: revision,
      idempotencyKey: key,
      body: { position: '新的下属职位' },
    });
  return { w, user, as, boss, sub, alone, summary, assertSummary, hidePersonFields, moveViewerAway, put };
}

describe('AC-EMP 补 / F-057 范围外上级姓名', () => {
  it('详情、列表、PUT 与同键重放均只显示上级 ID、姓名与空头像；直接 GET 仍与不存在同样 404', async () => {
    const s = await scene('f057-show');
    s.assertSummary(await s.w.ok<PersonResponse>(s.as('GET', `/people/${s.sub.id}`)));
    const list = await people(s.w, s.as);
    expect(list.map((person) => person.id)).not.toContain(s.boss.id);
    s.assertSummary(list.find((person) => person.id === s.sub.id)!);

    const key = randomUUID();
    const first = await s.w.ok<PersonResponse>(s.put(key));
    s.assertSummary(first);
    const replay = await s.w.ok<PersonResponse>(s.put(key));
    expect(replay).toEqual(first);
    s.assertSummary(replay);
    expect(await s.w.ok<PersonResponse>(s.w.request('GET', `/people/${s.sub.id}`))).toEqual(first);

    const hidden = await s.as('GET', `/people/${s.boss.id}`);
    const missing = await s.as('GET', `/people/${randomUUID()}`);
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('姓名字段撤权：详情、列表及旧命令重放只保留上级 ID 与空头像，摘要中姓名键缺席', async () => {
    const s = await scene('f057-name');
    const key = randomUUID();
    s.assertSummary(await s.w.ok<PersonResponse>(s.put(key)));
    await s.hidePersonFields(['name']);
    const expected = { id: s.boss.id, avatar: null };
    const detail = await s.w.ok<PersonResponse>(s.as('GET', `/people/${s.sub.id}`));
    s.assertSummary(detail, expected);
    expect(detail).not.toHaveProperty('name');
    s.assertSummary(
      (await people(s.w, s.as)).find((person) => person.id === s.sub.id)!,
      expected,
    );
    const replay = await s.w.ok<PersonResponse>(s.put(key));
    s.assertSummary(replay, expected);
    expect(JSON.stringify(replay)).not.toContain(s.boss.name);
  });

  it('上级字段撤权：详情、列表及旧命令重放均不返回 superiorPersonId 和整个 superior 摘要', async () => {
    const s = await scene('f057-ref');
    const key = randomUUID();
    s.assertSummary(await s.w.ok<PersonResponse>(s.put(key)));
    await s.hidePersonFields(['superiorPersonId']);
    const results = [
      await s.w.ok<PersonResponse>(s.as('GET', `/people/${s.sub.id}`)),
      (await people(s.w, s.as)).find((person) => person.id === s.sub.id)!,
      await s.w.ok<PersonResponse>(s.put(key)),
    ];
    for (const result of results) {
      expect(result).not.toHaveProperty('superiorPersonId');
      expect(result).not.toHaveProperty('superior');
      expect(JSON.stringify(result)).not.toContain(s.boss.id);
      expect(JSON.stringify(result)).not.toContain(s.boss.name);
    }
  });

  it('下属移出当前范围后同键重放返回 404，原成功业务数据保持不变', async () => {
    const s = await scene('f057-scope');
    const key = randomUUID();
    const first = await s.w.ok<PersonResponse>(s.put(key));
    s.assertSummary(first);
    await s.moveViewerAway();
    const replay = await s.put(key);
    const missing = await s.as('GET', `/people/${randomUUID()}`);
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual(await missing.json());
    expect(await s.w.ok<PersonResponse>(s.w.request('GET', `/people/${s.sub.id}`))).toEqual(first);
  });

  it('没有上级时详情、列表、PUT 与重放均返回 superior:null', async () => {
    const s = await scene('f057-null');
    expect(await s.w.ok<PersonResponse>(s.as('GET', `/people/${s.alone.id}`))).toMatchObject({
      superiorPersonId: null,
      superior: null,
    });
    expect((await people(s.w, s.as)).find((person) => person.id === s.alone.id)).toMatchObject({
      superiorPersonId: null,
      superior: null,
    });
    const key = randomUUID();
    const put = () =>
      s.as('PUT', `/people/${s.alone.id}`, {
        ifMatch: s.alone.revision,
        idempotencyKey: key,
        body: { position: '无上级职位' },
      });
    const first = await s.w.ok<PersonResponse>(put());
    expect(first).toMatchObject({ superiorPersonId: null, superior: null });
    expect(await s.w.ok<PersonResponse>(put())).toEqual(first);
  });

  it('跨租户上级 ID 不能用于新增或修改；失败后当前人员与列表保持不变', async () => {
    const s = await scene('f057-tenant');
    const other = await world360(testDb().db, 'f057-other');
    const foreignBoss = await other.person('另一租户上级');
    const before = await s.w.ok<PersonResponse>(s.w.request('GET', `/people/${s.sub.id}`));
    const beforePeople = await people(s.w);
    const changed = await s.w.request('PUT', `/people/${s.sub.id}`, {
      ifMatch: before.revision,
      body: { superiorPersonId: foreignBoss.id },
    });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({ error: { details: { reason: 'SUPERIOR_NOT_FOUND' } } });
    const created = await s.w.request('POST', '/people', {
      ifMatch: 0,
      body: { name: '跨租户失败人员', email: 'cross-tenant-superior@example.com', superiorPersonId: foreignBoss.id },
    });
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({ error: { details: { reason: 'SUPERIOR_NOT_FOUND' } } });
    expect(await s.w.ok<PersonResponse>(s.w.request('GET', `/people/${s.sub.id}`))).toEqual(before);
    expect(await people(s.w)).toEqual(beforePeople);
    const foreign = await s.w.request('GET', `/people/${foreignBoss.id}`);
    const missing = await s.w.request('GET', `/people/${randomUUID()}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it('人员审计 before/after 同口径显示摘要并按联合字段权限裁剪；精细化受限人仍看不到人员日志', async () => {
    const s = await scene('f057-audit', false);
    await s.w.ok<PersonResponse>(s.put(randomUUID()));
    const audit = auditApi(testDb().db, '2026-10-01T02:00:00Z', { authorize: s.w.authorize });
    const viewer = { user: s.user, tenant: s.w.tenantId };
    const logs = (await audit.dataChanges(viewer, { limit: '100' })).items;
    const update = logs.find((log) => log.objectId === s.sub.id && log.action === 'survey360.person.update')!;
    expect(update).toBeDefined();
    const detail = await audit.dataChange(viewer, update.id);
    for (const value of [detail.before, detail.after]) s.assertSummary(value as PersonResponse);

    await s.w.ok(
      s.w.request('PUT', `/people/${s.boss.id}`, {
        ifMatch: s.boss.revision,
        body: { name: '后来修改的上级姓名' },
      }),
    );
    const frozen = await audit.dataChange(viewer, update.id);
    for (const value of [frozen.before, frozen.after]) s.assertSummary(value as PersonResponse);
    expect(JSON.stringify(frozen)).not.toContain('后来修改的上级姓名');

    await s.hidePersonFields(['name']);
    const noName = await audit.dataChange(viewer, update.id);
    for (const value of [noName.before, noName.after])
      s.assertSummary(value as PersonResponse, { id: s.boss.id, avatar: null });
    expect(JSON.stringify(noName)).not.toContain(s.boss.name);
    await s.hidePersonFields(['superiorPersonId']);
    const noSuperior = await audit.dataChange(viewer, update.id);
    for (const value of [noSuperior.before, noSuperior.after]) {
      expect(value).not.toHaveProperty('superiorPersonId');
      expect(value).not.toHaveProperty('superior');
    }
    expect(JSON.stringify(noSuperior)).not.toContain(s.boss.id);
    expect(JSON.stringify(noSuperior)).not.toContain(s.boss.name);

    await s.hidePersonFields([]);
    const nextBoss = await s.w.person('下一名上级姓名', { department: '下一上级私密部门' });
    const current = await s.w.ok<PersonResponse>(s.as('GET', `/people/${s.sub.id}`));
    await s.w.ok(
      s.as('PUT', `/people/${s.sub.id}`, {
        ifMatch: current.revision,
        body: { superiorPersonId: nextBoss.id, position: '切换上级时的新职位' },
      }),
    );
    const query = { objectId: s.sub.id, action: 'survey360.person.update', field: 'name', limit: '100' };
    const named = await audit.dataChanges(viewer, query);
    expect(named.items).toHaveLength(1);
    const change = await audit.dataChange(viewer, named.items[0]!.id);
    expect(change.before).toMatchObject({
      superior: { id: s.boss.id, name: '后来修改的上级姓名', avatar: null },
    });
    expect(change.after).toMatchObject({ superior: { id: nextBoss.id, name: nextBoss.name, avatar: null } });
    expect(change.changes).toContainEqual(expect.objectContaining({ field: 'superior.name', to: nextBoss.name }));

    await s.hidePersonFields(['superiorPersonId']);
    // 顶层 name 仍可见；field=name 不能借嵌套上级 name 的变化匹配到整条日志。
    expect((await audit.dataChanges(viewer, query)).items).toEqual([]);
    const onlyPosition = await audit.dataChange(viewer, change.id);
    expect(onlyPosition.changes).toContainEqual(
      expect.objectContaining({ field: 'position', to: '切换上级时的新职位' }),
    );
    for (const marker of [
      s.boss.id,
      '后来修改的上级姓名',
      nextBoss.id,
      nextBoss.name,
      nextBoss.email,
      nextBoss.department,
    ])
      if (marker) expect(JSON.stringify(onlyPosition)).not.toContain(marker);

    await finePermission(s.w, true);
    expect(
      (await audit.dataChanges(viewer, { limit: '100' })).items.some((log) => log.objectType === 'survey360-person'),
    ).toBe(false);
    const restricted = await audit.get(`/data-changes/${update.id}`, viewer);
    expect(restricted.status).toBe(404);
    expect(await restricted.text()).not.toContain(s.boss.name);
  });
});
