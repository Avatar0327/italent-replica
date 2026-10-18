/**
 * BE-14b1 第 2 轮 P2-01 / P2-04：OF-R2 重聘提示按证件号、手机号、邮箱匹配已离职人员，且提示按操作人当前的任职记录查看权、
 * 数据范围、字段查看权裁剪（结束类型和最后工作日本身就是员工信息）；同键重放时重新授权。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerRealWorld, type OfferRealWorld } from './AC-OF-BE14a-support.js';
import { employmentUsingUserScope, employmentViewer, leaver } from './AC-OF-BE14b1-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const HINT = { endKind: 'leave', lastWorkDate: '2026-09-20' };

async function outsideDepartment(w: OfferRealWorld) {
  const response = await w.seeder.request('POST', '/api/tenant/org/organizations', {
    user: w.user.id,
    tenant: w.tenant.id,
    ifMatch: 0,
    body: { name: '范围外部门', parents: { admin: { parentId: w.tenant.id } }, establishedOn: '2026-01-01' },
  });
  return ((await response.json()) as { id: string }).id;
}

/** 普通成员（真实授权器）新建实习 Offer，返回响应。 */
const create = (w: OfferRealWorld, extra: Record<string, unknown>, idempotencyKey?: string) =>
  w.real('POST', '', {
    ifMatch: 0,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    body: { entry: 'intern', ...w.internFields(), name: '重聘合成候选人', ...extra },
  });

async function hintOf(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { rehireHint?: unknown }).rehireHint;
}

describe('OF-R2 重聘提示：三种匹配键（P2-04）', () => {
  it('证件号、手机号、邮箱各自唯一命中已离职人员：返回提示；邮箱不分大小写；不命中无提示', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-keys');
    await employmentViewer(w);
    const suffix = uniqueSuffix();
    await leaver(w, w.department.id, { idNumber: `ID${suffix}` }, '证件离职员工');
    await leaver(w, w.department.id, { mobilePhone: `139${suffix}` }, '手机离职员工');
    await leaver(w, w.department.id, { email: `Left.${suffix}@Example.com` }, '邮箱离职员工');
    expect(await hintOf(await create(w, { idType: 'id_card', idNumber: ` ID${suffix} ` }))).toEqual(HINT);
    expect(await hintOf(await create(w, { mobile: `139${suffix}` }))).toEqual(HINT);
    expect(await hintOf(await create(w, { personalEmail: `left.${suffix}@example.com` }))).toEqual(HINT);
    expect(await hintOf(await create(w, { idType: 'id_card', idNumber: `NO${suffix}`, mobile: `100${suffix}` }))).toBe(
      undefined,
    );
  });

  it('歧义：两个看得见的离职人员命中同一手机号 → ambiguous，不挑人', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-ambiguous');
    await employmentViewer(w);
    const mobile = `138${uniqueSuffix()}`;
    await leaver(w, w.department.id, { mobilePhone: mobile }, '同号离职员工甲');
    await leaver(w, w.department.id, { mobilePhone: mobile }, '同号离职员工乙');
    expect(await hintOf(await create(w, { mobile }))).toEqual({ ambiguous: true });
  });
});

describe('OF-R2 重聘提示：按操作人权限裁剪（P2-01）', () => {
  it('没有任职记录查看权：创建成功但没有提示（与不命中不可区分）', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-no-view');
    const number = `ID${uniqueSuffix()}`;
    await leaver(w, w.department.id, { idNumber: number });
    expect(await hintOf(await create(w, { idType: 'id_card', idNumber: number }))).toBeUndefined();
  });

  it('离职人员在数据范围外：没有提示，也不计入歧义', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-scope');
    await employmentViewer(w);
    const outside = await outsideDepartment(w);
    const mobile = `137${uniqueSuffix()}`;
    await leaver(w, outside, { mobilePhone: mobile }, '范围外离职员工');
    expect(await hintOf(await create(w, { mobile }))).toBeUndefined();
    await leaver(w, w.department.id, { mobilePhone: mobile }, '范围内离职员工');
    expect(await hintOf(await create(w, { mobile }))).toEqual(HINT);
  });

  it('最后工作日字段不可见：只给结束类型；两个字段都不可见：没有提示', async () => {
    const hidden = await offerRealWorld(testDb().db, 'hint-hide-date');
    await employmentViewer(hidden, ['lastWorkDate']);
    const number = `ID${uniqueSuffix()}`;
    await leaver(hidden, hidden.department.id, { idNumber: number });
    expect(await hintOf(await create(hidden, { idType: 'id_card', idNumber: number }))).toEqual({ endKind: 'leave' });
  });

  it('两个提示字段都不可见：单人、多人命中、同键重放一律没有提示（与不命中不可区分，多人也不暴露 ambiguous）', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-hide-all');
    await employmentViewer(w, ['lastWorkDate', 'kind']);
    const single = `ID${uniqueSuffix()}`;
    await leaver(w, w.department.id, { idNumber: single });
    expect(await hintOf(await create(w, { idType: 'id_card', idNumber: single }))).toBeUndefined();
    const mobile = `136${uniqueSuffix()}`;
    await leaver(w, w.department.id, { mobilePhone: mobile }, '同号离职员工甲');
    await leaver(w, w.department.id, { mobilePhone: mobile }, '同号离职员工乙');
    expect(await hintOf(await create(w, { mobile }))).toBeUndefined();
    const key = `hint-hide-replay-${uniqueSuffix()}`;
    const body = { entry: 'intern', ...w.internFields(), name: '重放合成候选人', mobile };
    const post = () => w.real('POST', '', { ifMatch: 0, idempotencyKey: key, body });
    expect(await hintOf(await post())).toBeUndefined();
    expect(await hintOf(await post())).toBeUndefined();
  });

  it('撤权后同键重放：Offer 照旧返回，提示不再交出', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-replay');
    const viewer = await employmentViewer(w);
    const number = `ID${uniqueSuffix()}`;
    await leaver(w, w.department.id, { idNumber: number });
    const key = `hint-replay-${uniqueSuffix()}`;
    const body = { entry: 'intern', ...w.internFields(), name: '重放合成候选人', idType: 'id_card', idNumber: number };
    const post = () => w.real('POST', '', { ifMatch: 0, idempotencyKey: key, body });
    expect(await hintOf(await post())).toEqual(HINT);
    await viewer.revoke();
    expect(await hintOf(await post())).toBeUndefined();
    expect(await w.count()).toBe(1);
  });

  it('范围外的人不挤占候选名额：49 个范围外 + 2 个范围内命中同一手机号，仍判歧义', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-limit');
    await employmentViewer(w);
    const outside = await outsideDepartment(w);
    const mobile = `135${uniqueSuffix()}`;
    for (let start = 0; start < 49; start += 7)
      await Promise.all(
        Array.from({ length: Math.min(7, 49 - start) }, (_, index) =>
          leaver(w, outside, { mobilePhone: mobile }, `范围外离职员工${start + index}`),
        ),
      );
    await leaver(w, w.department.id, { mobilePhone: mobile }, '范围内离职员工甲');
    await leaver(w, w.department.id, { mobilePhone: mobile }, '范围内离职员工乙');
    expect(await hintOf(await create(w, { mobile }))).toEqual({ ambiguous: true });
  }, 240_000);

  it('“使用用户”范围：本人创建的离职任职记录给提示，他人创建的不给', async () => {
    const w = await offerRealWorld(testDb().db, 'hint-using-user');
    await employmentViewer(w);
    await employmentUsingUserScope(w);
    const mine = `ID${uniqueSuffix()}`;
    const others = `ID${uniqueSuffix()}`;
    await leaver(w, w.department.id, { idNumber: mine }, '本人创建的离职员工', w.member.id);
    await leaver(w, w.department.id, { idNumber: others }, '他人创建的离职员工');
    expect(await hintOf(await create(w, { idType: 'id_card', idNumber: mine }))).toEqual(HINT);
    expect(await hintOf(await create(w, { idType: 'id_card', idNumber: others }))).toBeUndefined();
  });
});
