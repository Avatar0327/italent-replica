/**
 * F-058 / DEC-327：账号头像投影到 360 人员与最小上级摘要；范围外头像不开放人员详情，
 * 字段撤权、幂等重放、历史审计仍按当前查看权裁剪。未绑定人员保持默认头像，不读取证件照。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { type ObjectPermissionBody, type PersonView, world360, type World360 } from './AC-360-support.js';
import { imageFixture } from './AC-TC-model-image-support.js';

const testDb = useTestDb();
const PERSON = survey360.SURVEY360_OBJECTS.person;

interface AvatarReference {
  id: string;
  url: string;
}

interface PersonResponse extends PersonView {
  avatar?: AvatarReference | null;
  superior?: { id: string; name?: string; avatar: AvatarReference | null } | null;
}

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

async function uploadAvatar(w: World360, employeeId: string) {
  const result = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE employee_id=${employeeId}::uuid`),
  );
  const links = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { user_id: string }[];
  expect(links).toHaveLength(1);
  const user = links[0]!.user_id;
  const base = '/api/tenant/account/avatar';
  const call = (method: string, path = '', extra: Parameters<World360['api']['request']>[2] = {}) =>
    w.api.request(method, `${base}${path}`, { ...extra, user, tenant: w.tenantId });
  const current = await w.ok<{ revision: number }>(call('GET'));
  const fixture = imageFixture();
  const registered = await w.ok<{ revision: number; attachment: { id: string } }>(
    call('POST', '/attachments', {
      ifMatch: current.revision,
      body: { ...fixture.metadata, filename: 'synthetic-avatar.png' },
    }),
    201,
  );
  const uploaded = await w.ok<{ revision: number; avatar: AvatarReference }>(
    call('POST', `/attachments/${registered.attachment.id}/upload`, {
      ifMatch: registered.revision,
      body: { base64: fixture.base64 },
    }),
  );
  expect(uploaded.avatar).toEqual({
    id: registered.attachment.id,
    url: `/api/tenant/avatars/${registered.attachment.id}/content`,
  });
  return { ...uploaded, user, call, fixture };
}

async function scene(label: string, fine: boolean) {
  const w = await world360(testDb().db, label);
  const orgA = await w.session.org('可见部门', { establishedOn: '2025-01-01' });
  const orgB = await w.session.org('范围外私密部门', { establishedOn: '2025-01-01' });
  const bossEmployee = await hire(w, '范围外上级头像', orgB.id);
  const subEmployee = await hire(w, '可见下属头像', orgA.id, bossEmployee.id);
  const bossAvatar = await uploadAvatar(w, bossEmployee.id);
  const subAvatar = await uploadAvatar(w, subEmployee.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const all = (await w.ok<{ items: PersonResponse[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const boss = all.find((person) => person.employeeId === bossEmployee.id)!;
  const sub = all.find((person) => person.employeeId === subEmployee.id)!;
  const advanced = survey360.SURVEY360_PROFILES.find((p) => p.code === 'standard_360_advanced_admin')!;
  const profileId = await w.defineProfile('头像摘要测试身份', advanced.objects);
  const user = await w.member('头像摘要查看人');
  await w.grantProfile(user, profileId);
  const mou = await w.ok<{ id: string }>(
    w.enterprise('POST', '/mous', {
      ifMatch: 0,
      body: {
        code: `${label}-visible`,
        name: '仅可见部门',
        orgRanges: [{ orgId: orgA.id, includeDescendants: true }],
      },
    }),
    201,
  );
  await w.ok(
    w.enterprise('PUT', `/scopes/${user}/${survey360.SURVEY360_APP}`, {
      ifMatch: 0,
      body: { kind: 'mou', mouId: mou.id },
    }),
  );
  if (fine) {
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
  }
  const as = w.as(user);
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
  return { w, as, user, boss, sub, bossEmployee, subEmployee, bossAvatar, subAvatar, hidePersonFields };
}

describe('AC-EMP 补 / F-058 人员头像摘要', () => {
  it('范围外上级头像进入详情、列表、首次写及旧命令重放，直接详情仍为统一 404', async () => {
    const s = await scene('f058-summary', true);
    const expected = { id: s.boss.id, name: s.boss.name, avatar: s.bossAvatar.avatar };
    const detail = await s.w.ok<PersonResponse>(s.as('GET', `/people/${s.sub.id}`));
    expect(detail.avatar).toEqual(s.subAvatar.avatar);
    expect(detail.superior).toEqual(expected);
    const list = await s.w.ok<{ items: PersonResponse[] }>(s.as('GET', '/people?pageSize=200'));
    expect(list.items.map((person) => person.id)).not.toContain(s.boss.id);
    expect(list.items.find((person) => person.id === s.sub.id)).toMatchObject({ superior: expected });
    const key = randomUUID();
    const put = () =>
      s.as('PUT', `/people/${s.sub.id}`, {
        ifMatch: s.sub.revision,
        idempotencyKey: key,
        body: { position: '只修改下属职位' },
      });
    expect((await s.w.ok<PersonResponse>(put())).superior).toEqual(expected);
    const replacement = await uploadAvatar(s.w, s.bossEmployee.id);
    expect(replacement.avatar.id).not.toBe(s.bossAvatar.avatar.id);
    expect((await s.w.ok<PersonResponse>(put())).superior).toEqual({ ...expected, avatar: replacement.avatar });
    const hidden = await s.as('GET', `/people/${s.boss.id}`);
    const missing = await s.as('GET', `/people/${randomUUID()}`);
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(await hidden.json()).toEqual(await missing.json());
    for (const marker of [s.boss.email, s.boss.department, s.bossEmployee.id])
      if (marker) expect(JSON.stringify(detail.superior)).not.toContain(marker);
    expect(JSON.stringify(detail)).not.toContain(s.bossAvatar.fixture.base64);
    const image = await s.w.api.request('GET', replacement.avatar.url, {
      user: s.user,
      tenant: s.w.tenantId,
    });
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(replacement.fixture.bytes);
  });

  it('姓名和上级字段撤权同时裁剪真实头像；旧写命令不能恢复已撤权引用', async () => {
    const s = await scene('f058-hidden', true);
    const key = randomUUID();
    const put = () =>
      s.as('PUT', `/people/${s.sub.id}`, {
        ifMatch: s.sub.revision,
        idempotencyKey: key,
        body: { position: '用于重放的职位' },
      });
    await s.w.ok(put());
    await s.hidePersonFields(['name']);
    for (const response of [s.as('GET', `/people/${s.sub.id}`), put()]) {
      const body = await s.w.ok<PersonResponse>(response);
      expect(body).not.toHaveProperty('name');
      expect(body.avatar ?? null).toBeNull();
      expect(body.superior).toEqual({ id: s.boss.id, avatar: null });
      expect(JSON.stringify(body)).not.toContain(s.bossAvatar.avatar.id);
      expect(JSON.stringify(body)).not.toContain(s.subAvatar.avatar.id);
    }
    await s.hidePersonFields(['superiorPersonId']);
    const body = await s.w.ok<PersonResponse>(put());
    expect(body.avatar).toEqual(s.subAvatar.avatar);
    expect(body).not.toHaveProperty('superiorPersonId');
    expect(body).not.toHaveProperty('superior');
    expect(JSON.stringify(body)).not.toContain(s.bossAvatar.avatar.id);
  });

  it('历史人员审计冻结当时的上级头像引用，后续替换不改旧日志，姓名撤权也裁剪嵌套引用叶子', async () => {
    const s = await scene('f058-audit', false);
    await s.w.ok(
      s.as('PUT', `/people/${s.sub.id}`, { ifMatch: s.sub.revision, body: { position: '触发头像摘要审计' } }),
    );
    const audit = auditApi(s.w.db, '2026-10-01T02:00:00Z', { authorize: s.w.authorize });
    const viewer = { user: s.user, tenant: s.w.tenantId };
    const logs = (await audit.dataChanges(viewer, { objectId: s.sub.id, limit: '100' })).items;
    const update = logs.find((log) => log.action === 'survey360.person.update')!;
    expect(update).toBeDefined();
    const replacement = await uploadAvatar(s.w, s.bossEmployee.id);
    const frozen = await audit.dataChange(viewer, update.id);
    for (const value of [frozen.before, frozen.after])
      expect(value).toMatchObject({ superior: { id: s.boss.id, name: s.boss.name, avatar: s.bossAvatar.avatar } });
    expect(JSON.stringify(frozen)).not.toContain(replacement.avatar.id);
    expect(JSON.stringify(frozen)).not.toContain(s.bossAvatar.fixture.base64);
    await s.hidePersonFields(['name']);
    const noName = await audit.dataChange(viewer, update.id);
    expect(JSON.stringify(noName)).not.toContain(s.bossAvatar.avatar.id);
    expect(JSON.stringify(noName)).not.toContain(s.bossAvatar.avatar.url);
    await s.hidePersonFields(['superiorPersonId']);
    const noSuperior = await audit.dataChange(viewer, update.id);
    for (const value of [noSuperior.before, noSuperior.after]) expect(value).not.toHaveProperty('superior');
  });

  it('对象 / 评价者嵌套摘要使用本人头像并按人员姓名权裁剪；未绑定人员为空且头像不能从管理员载荷写入', async () => {
    const s = await scene('f058-nested', false);
    const manual = await s.w.person('没有账号的外部人员');
    expect((await s.w.ok<PersonResponse>(s.w.request('GET', `/people/${manual.id}`))).avatar).toBeNull();
    const q = await s.w.enableQuestionnaire(await s.w.keyBehavior());
    const activity = await s.w.activity({ name: '人员头像摘要活动', showAppraiserName: false }, s.user);
    const object = await s.w.object(activity.id, s.sub.id, [q.id]);
    await s.w.appraiser(activity.id, object.id, s.boss.id, 'superior');
    const path = `/activities/${activity.id}/objects`;
    const objects = await s.w.ok<{ items: { person: { name: string; avatar: AvatarReference | null } }[] }>(
      s.as('GET', path),
    );
    expect(objects.items[0]!.person.avatar).toEqual(s.subAvatar.avatar);
    const appraisers = await s.w.ok<{ items: { appraiser?: { name?: string; avatar?: AvatarReference | null } }[] }>(
      s.as('GET', `${path}/${object.id}/appraisers`),
    );
    expect(appraisers.items[0]!.appraiser?.avatar).toEqual(s.bossAvatar.avatar);
    await s.hidePersonFields(['name']);
    for (const nested of [
      await s.w.ok(s.as('GET', path)),
      await s.w.ok(s.as('GET', `${path}/${object.id}/appraisers`)),
    ]) {
      expect(JSON.stringify(nested)).not.toContain(s.bossAvatar.avatar.id);
      expect(JSON.stringify(nested)).not.toContain(s.subAvatar.avatar.id);
    }
    const injected = await s.w.request('PUT', `/people/${s.sub.id}`, {
      ifMatch: s.sub.revision,
      body: { avatar: s.bossAvatar.avatar },
    });
    expect(injected.status).toBe(400);
    await s.w.transition(activity.id, 'enable');
    const answer = await s.w.ok<Record<string, unknown>>(s.w.link(await s.w.token(activity.id, s.boss.id))('GET', ''));
    expect(answer).not.toHaveProperty('appraiser');
    expect(JSON.stringify(answer)).not.toContain(s.bossAvatar.avatar.id);
  });
});
