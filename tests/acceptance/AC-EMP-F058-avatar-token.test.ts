/** F-058：公开链接头像只按既有令牌上下文提供给本单具名人员，不开放全租户图片。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { LINK, type PersonView, world360 } from './AC-360-support.js';
import { avatarEmployee, employeeAvatar, type AvatarReference } from './AC-EMP-F058-avatar-support.js';

const testDb = useTestDb();
const publicReference = (avatar: AvatarReference) => ({ id: avatar.id, url: `${LINK}/avatars/${avatar.id}/content` });

interface LinkView {
  appraiser?: { name: string; avatar: AvatarReference | null };
  object?: { name: string; avatar: AvatarReference | null };
  tasks?: { relationId: string; object: { name: string; avatar: AvatarReference | null } }[];
  appraisers?: { appraiserPersonId: string; appraiser: { name: string; avatar: AvatarReference | null } }[];
}

async function scene(label: string, showAppraiserName = true) {
  const w = await world360(testDb().db, label);
  const org = await w.session.org('链接头像部门', { establishedOn: '2025-01-01' });
  const bossEmployee = await avatarEmployee(w, '本单评价者', org.id);
  const subEmployee = await avatarEmployee(w, '本单评价对象', org.id, bossEmployee.id);
  const otherEmployee = await avatarEmployee(w, '他单人员私密标记', org.id);
  const bossAvatar = await employeeAvatar(w, bossEmployee.id);
  const subAvatar = await employeeAvatar(w, subEmployee.id);
  const otherAvatar = await employeeAvatar(w, otherEmployee.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const personOf = (id: string) => people.find((person) => person.employeeId === id)!;
  const boss = personOf(bossEmployee.id);
  const sub = personOf(subEmployee.id);
  const other = personOf(otherEmployee.id);
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity({ showAppraiserName });
  const object = await w.object(activity.id, sub.id, [q.id]);
  const relation = await w.appraiser(activity.id, object.id, boss.id, 'superior');
  const otherActivity = await w.activity();
  const otherObject = await w.object(otherActivity.id, other.id, [q.id]);
  await w.appraiser(otherActivity.id, otherObject.id, other.id, 'self');
  await w.transition(activity.id, 'enable');
  await w.transition(otherActivity.id, 'enable');
  const token = await w.token(activity.id, boss.id);
  const link = w.link(token);
  const image = (avatar: AvatarReference) => link('GET', `/avatars/${avatar.id}/content`);
  return {
    w,
    boss,
    sub,
    other,
    bossEmployee,
    subEmployee,
    bossAvatar,
    subAvatar,
    otherAvatar,
    activity,
    object,
    relation,
    q,
    token,
    link,
    image,
  };
}

async function unavailable(response: Promise<Response>, missing: Response) {
  const resolved = await response;
  expect(resolved.status).toBe(404);
  expect(await resolved.json()).toEqual(await missing.clone().json());
}

describe('AC-EMP 补 / F-058 公开令牌头像授权', () => {
  it('作答主页与任务实名摘要返回令牌专属引用；可读字节但不能读他单、跨租户或未知头像', async () => {
    const s = await scene('f058-token-name');
    const body = await s.w.ok<LinkView>(s.link('GET', ''));
    expect(body.tasks?.[0]?.object).toEqual({ name: s.sub.name, avatar: publicReference(s.subAvatar.avatar) });
    expect(body.appraiser).toEqual({ name: s.boss.name, avatar: publicReference(s.bossAvatar.avatar) });
    const task = await s.w.ok<LinkView>(s.link('GET', `/tasks/${s.relation.id}/questionnaires/${s.q.id}`));
    expect(task.object).toEqual(body.tasks![0]!.object);
    expect(task.appraiser).toEqual(body.appraiser);
    const image = await s.image(s.subAvatar.avatar);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-disposition')).toBe('inline');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(s.subAvatar.fixture.bytes);
    const missing = await s.link('GET', `/avatars/${randomUUID()}/content`);
    expect(missing.status).toBe(404);
    await unavailable(s.image(s.otherAvatar.avatar), missing);
    const foreign = await world360(testDb().db, 'f058-token-foreign');
    const otherTenant = await s.w.api.request('GET', publicReference(s.subAvatar.avatar).url, {
      tenant: foreign.tenantId,
      headers: { 'x-survey360-token': s.token },
    });
    expect(otherTenant.status).toBe(404);
    expect(await otherTenant.json()).toEqual(await missing.clone().json());
    expect(JSON.stringify(body)).not.toContain(s.token);
    for (const forbidden of [s.boss.email, s.other.name, s.bossEmployee.id, s.subAvatar.fixture.base64])
      expect(JSON.stringify(body)).not.toContain(forbidden);
  });

  it('匿名开关去掉评价者和真实头像，其本人头像也不能借下载接口取出；对象头像仍可读', async () => {
    const s = await scene('f058-token-anonymous', false);
    const body = await s.w.ok<LinkView>(s.link('GET', ''));
    expect(body).not.toHaveProperty('appraiser');
    expect(body.tasks![0]!.object.avatar).toEqual(publicReference(s.subAvatar.avatar));
    expect(JSON.stringify(body)).not.toContain(s.bossAvatar.avatar.id);
    const missing = await s.link('GET', `/avatars/${randomUUID()}/content`);
    await unavailable(s.image(s.bossAvatar.avatar), missing);
    expect((await s.image(s.subAvatar.avatar)).status).toBe(200);
  });

  it('替换、删除、移除本单关系和撤销令牌即时重新授权，旧头像及未知头像都统一 404', async () => {
    const s = await scene('f058-token-revoke');
    expect((await s.image(s.subAvatar.avatar)).status).toBe(200);
    const replacement = await employeeAvatar(s.w, s.subEmployee.id);
    const missing = await s.link('GET', `/avatars/${randomUUID()}/content`);
    await unavailable(s.image(s.subAvatar.avatar), missing);
    expect((await s.w.ok<LinkView>(s.link('GET', ''))).tasks![0]!.object.avatar).toEqual(
      publicReference(replacement.avatar),
    );
    await s.w.ok(replacement.request('DELETE', '', { ifMatch: replacement.revision }));
    await unavailable(s.image(replacement.avatar), missing);
    expect((await s.w.ok<LinkView>(s.link('GET', ''))).tasks![0]!.object.avatar).toBeNull();
    const third = await employeeAvatar(s.w, s.subEmployee.id);
    await s.w.ok(
      s.w.request('DELETE', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers/${s.relation.id}`, {
        ifMatch: s.relation.revision,
      }),
    );
    await unavailable(s.image(third.avatar), missing);
    await withTenant(s.w.db, s.w.tenantId, (tx) =>
      tx.execute(sql`UPDATE survey360_links SET revoked=true WHERE activity_id=${s.activity.id}::uuid`),
    );
    const home = await s.link('GET', '');
    expect(home.status).toBe(404);
    await unavailable(s.image(s.bossAvatar.avatar), home);
  });

  it('确认令牌只读取本确认单对象和当前实名评价者；确认单取消后沿用主页失效错误', async () => {
    const s = await scene('f058-token-confirm');
    const confirmation = await s.w.ok<{ id: string }>(
      s.w.request('POST', `/activities/${s.activity.id}/objects/${s.object.id}/confirmation`, {
        ifMatch: 0,
        body: {},
      }),
      201,
    );
    const token = await s.w.token(s.activity.id, s.boss.id, 'survey360.confirm_invitation');
    const link = s.w.link(token);
    const body = await s.w.ok<LinkView>(link('GET', ''));
    expect(body.object?.avatar).toEqual(publicReference(s.subAvatar.avatar));
    expect(body.appraisers![0]!.appraiser.avatar).toEqual(publicReference(s.bossAvatar.avatar));
    expect((await link('GET', `/avatars/${s.bossAvatar.avatar.id}/content`)).status).toBe(200);
    const missing = await link('GET', `/avatars/${randomUUID()}/content`);
    await unavailable(link('GET', `/avatars/${s.otherAvatar.avatar.id}/content`), missing);
    const candidates = await s.w.ok<{ items: { avatar: AvatarReference | null }[] }>(
      link('GET', '/confirmation/candidates'),
    );
    expect(candidates.items.length).toBeGreaterThan(0);
    for (const candidate of candidates.items) expect(candidate.avatar).toBeNull();
    await withTenant(s.w.db, s.w.tenantId, (tx) =>
      tx.execute(sql`UPDATE survey360_confirmations SET status='cancelled' WHERE id=${confirmation.id}::uuid`),
    );
    const home = await link('GET', '');
    expect(home.status).toBe(404);
    await unavailable(link('GET', `/avatars/${s.subAvatar.avatar.id}/content`), home);
  });
});
