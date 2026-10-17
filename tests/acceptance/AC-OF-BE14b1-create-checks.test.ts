/**
 * BE-14b1：新建 / 编辑 Offer 时的 OF-R2 校验（AC-OF-05）：姓名 + 手机 / 邮箱 / 证件号命中黑名单 → 拒绝；
 * 证件号命中离职人员 → 只提示重聘（rehireHint，不阻断，DEC-600）；身份证号带出出生日期。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { internWorld } from './AC-IN-BE6a-support.js';
import { errorOf, offerWorld } from './AC-OF-BE14a-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const ID_CARD = '11010519491231002X';

async function blacklist(w: Awaited<ReturnType<typeof offerWorld>>, body: Record<string, unknown>) {
  const response = await w.seeder.request('POST', '/api/tenant/employment/blacklist', {
    user: w.user.id,
    tenant: w.tenant.id,
    ifMatch: 0,
    body: { reason: 'integrity', ...body },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}

describe('AC-OF-05 黑名单（OF-R2）', () => {
  it('姓名 + 手机命中：新建被拒 409 OFFER_BLACKLISTED，不建 Offer', async () => {
    const w = await offerWorld(testDb().db, 'bl-mobile');
    await blacklist(w, { name: '黑名单合成人', mobilePhone: '13800000001' });
    const response = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', ...w.socialFields(), name: '黑名单合成人', mobile: '13800000001' },
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_BLACKLISTED' });
    expect((await w.list('view=pending')).total).toBe(0);
  });

  it('姓名 + 邮箱 / 证件号命中（不分大小写）同样被拒；只有标识相同而姓名不同不拦', async () => {
    const w = await offerWorld(testDb().db, 'bl-others');
    await blacklist(w, { name: '黑名单合成人', email: 'Black.List@Example.com', idNumber: 'abc123456' });
    const create = (extra: Record<string, unknown>) =>
      w.request('POST', '', { ifMatch: 0, body: { entry: 'offer', ...w.socialFields(), ...extra } });
    const byEmail = await create({ name: '黑名单合成人', personalEmail: 'black.list@example.COM' });
    expect((await errorOf(byEmail)).details).toMatchObject({ reason: 'OFFER_BLACKLISTED' });
    const byId = await create({ name: '黑名单合成人', idType: 'id_card', idNumber: 'ABC123456' });
    expect((await errorOf(byId)).details).toMatchObject({ reason: 'OFFER_BLACKLISTED' });
    const otherName = await create({ name: '同号不同名', idType: 'id_card', idNumber: 'ABC123456' });
    expect(otherName.status, await otherName.clone().text()).toBe(201);
  });

  it('已移出的黑名单不拦', async () => {
    const w = await offerWorld(testDb().db, 'bl-removed');
    const entry = await blacklist(w, { name: '移出合成人', mobilePhone: '13800000002' });
    const removed = await w.seeder.request('POST', '/api/tenant/employment/blacklist/remove', {
      user: w.user.id,
      tenant: w.tenant.id,
      body: { items: [{ id: entry.id, revision: entry.revision }] },
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const response = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', ...w.socialFields(), name: '移出合成人', mobile: '13800000002' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  });

  it('编辑改成黑名单身份同样被拒，原 Offer 不变', async () => {
    const w = await offerWorld(testDb().db, 'bl-update');
    await blacklist(w, { name: '黑名单合成人', mobilePhone: '13800000003' });
    const offer = await w.social({ name: '黑名单合成人' });
    const response = await w.request('PUT', `/${offer.id}`, {
      ifMatch: offer.revision,
      body: { mobile: '13800000003' },
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_BLACKLISTED' });
    expect(await w.get(offer.id)).toMatchObject({ revision: offer.revision, mobile: null });
  });
});

describe('OF-R2 重聘提示与身份证带出', () => {
  it('证件号命中已离职人员：创建成功并返回 rehireHint（只含结束类型与最后工作日，不暴露人员信息）', async () => {
    const w = await internWorld(testDb().db, 'of-rehire');
    const number = `SYN${uniqueSuffix()}`;
    const person = await w.hire('离职合成员工', 'intern');
    await w.identify(person.employee.id, 'id_card', number);
    await w.leave(person.employee.id, '2026-09-20');
    const api = tenantApi(testDb().db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const create = (idNumber: string) =>
      api.request('POST', '/api/tenant/offers', {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: 0,
        body: {
          entry: 'intern',
          name: '重聘合成人',
          personalEmail: `of-${uniqueSuffix()}@example.com`,
          departmentId: w.org.id,
          plannedEntryDate: '2026-11-01',
          idType: 'id_card',
          idNumber,
        },
      });
    const hit = await create(number);
    expect(hit.status, await hit.clone().text()).toBe(201);
    const body = (await hit.json()) as Record<string, unknown>;
    expect(body.rehireHint).toEqual({ endKind: 'leave', lastWorkDate: '2026-09-20' });
    const miss = await create(`SYN${uniqueSuffix()}`);
    expect(miss.status).toBe(201);
    expect(((await miss.json()) as Record<string, unknown>).rehireHint ?? null).toBeNull();
  });

  it('身份证号带出出生日期：未填时带出，已填保留；非身份证或校验位不符不带出也不拒绝', async () => {
    const w = await offerWorld(testDb().db, 'id-card');
    const born = async (extra: Record<string, unknown>) => (await w.social(extra)).birthDate;
    expect(await born({ idType: 'id_card', idNumber: ID_CARD })).toBe('1949-12-31');
    expect(await born({ idType: 'id_card', idNumber: ID_CARD, birthDate: '2000-01-01' })).toBe('2000-01-01');
    expect(await born({ idType: 'passport', idNumber: ID_CARD })).toBeNull();
    expect(await born({ idType: 'id_card', idNumber: '110105194912310021' })).toBeNull();
  });
});
