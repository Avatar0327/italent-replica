/**
 * BE-14a 第 2 轮审查（#394 Sol high）必修两项，真实权限授权器复现：
 * P2-01 继承 / 复制带来的字段也要过字段编辑权：校招生提前实习从校招 Offer 继承手机号、复制失效 Offer 带出工资，
 *        对这两个字段无编辑权时整单拒绝，不新增 Offer，不留成功审计和台账。
 * P2-02 引用按被引用对象的当前范围校验：范围外的职位不能写进 Offer（新建、改绑都 400 OFFER_REFERENCE_INVALID），
 *        数据与 revision 不变。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerRealWorld, type OfferBody } from './AC-OF-BE14a-support.js';

const testDb = useTestDb();

describe('P2-01 继承 / 复制带来的字段按字段编辑权校验', () => {
  it('手机号无编辑权：直接提交 403；校招生提前实习从校招 Offer 继承手机号同样 403，无新增、无成功审计与台账', async () => {
    const w = await offerRealWorld(testDb().db, 'inherit', ['mobile']);
    const campus = await w.social({ offerType: 'campus', mobile: '13800000000' });
    const direct = await w.real('POST', '', {
      ifMatch: 0,
      body: { entry: 'intern', ...w.internFields(), mobile: '1' },
    });
    expect(direct.status).toBe(403);
    const before = await w.count();
    const { name: _n, personalEmail: _e, ...rest } = w.internFields();
    const key = randomUUID();
    const inherited = await w.real('POST', '', {
      ifMatch: 0,
      idempotencyKey: key,
      body: { entry: 'campus_early_intern', campusOfferId: campus.id, ...rest },
    });
    expect(inherited.status, await inherited.clone().text()).toBe(403);
    expect(await w.count()).toBe(before);
    expect(await w.traces(key)).toBe(0);
  });

  it('工资无编辑权：复制带工资的失效 Offer 403，无新增、无成功审计与台账', async () => {
    const w = await offerRealWorld(testDb().db, 'copy-salary', ['salaryBeforeRegular']);
    const source = await w.intern({ salaryBeforeRegular: 12000.5 });
    await w.invalidated(source.id);
    const before = await w.count();
    const key = randomUUID();
    const copied = await w.real('POST', `/${source.id}/copy`, { ifMatch: 1, idempotencyKey: key });
    expect(copied.status, await copied.clone().text()).toBe(403);
    expect(await w.count()).toBe(before);
    expect(await w.traces(key)).toBe(0);
  });

  it('有权时继承成功；撤掉手机号编辑权后同键重放也 403（重放按同一规则复核）', async () => {
    const w = await offerRealWorld(testDb().db, 'inherit-replay');
    const campus = await w.social({ offerType: 'campus', mobile: '13800000000' });
    const { name: _n, personalEmail: _e, ...rest } = w.internFields();
    const body = { entry: 'campus_early_intern', campusOfferId: campus.id, ...rest };
    const key = randomUUID();
    const first = await w.real('POST', '', { ifMatch: 0, idempotencyKey: key, body });
    expect(first.status, await first.clone().text()).toBe(201);
    expect(await first.json()).toMatchObject({ mobile: '13800000000' });
    await w.denyEdit(['mobile']);
    const replay = await w.real('POST', '', { ifMatch: 0, idempotencyKey: key, body });
    expect(replay.status).toBe(403);
  });

  it('对照：继承 / 复制的字段都有编辑权时成功', async () => {
    const w = await offerRealWorld(testDb().db, 'inherit-ok');
    const source = await w.intern({ salaryBeforeRegular: 12000.5 });
    await w.invalidated(source.id);
    const copied = await w.real('POST', `/${source.id}/copy`, { ifMatch: 1 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    expect(await copied.json()).toMatchObject({ salaryBeforeRegular: 12000.5, copiedFromOfferId: source.id });
  });
});

describe('P2-02 引用按被引用对象的当前范围校验', () => {
  it('范围外职位：新建 400 OFFER_REFERENCE_INVALID 且不写入；改绑 400，数据与 revision 不变', async () => {
    const w = await offerRealWorld(testDb().db, 'position-scope');
    const before = await w.count();
    const created = await w.real('POST', '', {
      ifMatch: 0,
      body: { entry: 'intern', ...w.internFields(), positionId: w.outsidePosition },
    });
    expect(created.status, await created.clone().text()).toBe(400);
    expect((await errorOf(created)).details).toMatchObject({ reason: 'OFFER_REFERENCE_INVALID' });
    expect(await w.count()).toBe(before);
    const ok = await w.real('POST', '', { ifMatch: 0, body: { entry: 'intern', ...w.internFields() } });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const offer = (await ok.json()) as OfferBody;
    const rebound = await w.real('PUT', `/${offer.id}`, { ifMatch: 1, body: { positionId: w.outsidePosition } });
    expect(rebound.status, await rebound.clone().text()).toBe(400);
    expect((await errorOf(rebound)).details).toMatchObject({ reason: 'OFFER_REFERENCE_INVALID' });
    expect(await w.get(offer.id)).toMatchObject({ positionId: null, revision: 1 });
  });

  it('职级（无组织、无看全部）与合同主体（主数据只认看全部）同样按范围：新建 / 改绑 400，不写入', async () => {
    const w = await offerRealWorld(testDb().db, 'master-scope');
    const before = await w.count();
    for (const extra of [{ levelId: w.level.id }, { contractCompanyId: w.company.id }]) {
      const created = await w.real('POST', '', {
        ifMatch: 0,
        body: { entry: 'intern', ...w.internFields(), ...extra },
      });
      expect(created.status, await created.clone().text()).toBe(400);
      expect((await errorOf(created)).details).toMatchObject({ reason: 'OFFER_REFERENCE_INVALID' });
    }
    expect(await w.count()).toBe(before);
    const offer = (await (
      await w.real('POST', '', { ifMatch: 0, body: { entry: 'intern', ...w.internFields() } })
    ).json()) as OfferBody;
    for (const extra of [{ levelId: w.level.id }, { contractCompanyId: w.company.id }]) {
      const rebound = await w.real('PUT', `/${offer.id}`, { ifMatch: 1, body: extra });
      expect((await errorOf(rebound)).details).toMatchObject({ reason: 'OFFER_REFERENCE_INVALID' });
    }
    expect(await w.get(offer.id)).toMatchObject({ levelId: null, contractCompanyId: null, revision: 1 });
  });
});
