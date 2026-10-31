/**
 * BE-13a / AC-HA-13a-01～04：人员结构分析看板（B49，规格 35“补充：BE-13…”6.01～6.14）。
 * 固定夹具（asOf = 租户今天 2026-10-01）：机构 A（机构）→ 部门 A1 → 小组 A1x；部门 B 直接挂根（没有机构，回落租户根）。
 * 范围 = 正式员工（内部员工，含试用、不含实习生）；每个组件 / 分组都断言数字 = 明细条数 = 手写集合。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { boardClient, ids, STRUCTURE_BASE, structureWorld, type BoardClient } from './AC-HA-13a-support.js';

const database = useTestDb();
const B = STRUCTURE_BASE;
const AS_OF = 'asOf=2026-10-01';

async function buildWorld() {
  const w = await structureWorld(database().db, 'ha13a-structure');
  const institution = await w.org('机构A', undefined, '机构');
  const a1 = await w.org('部门A1', institution);
  const a1x = await w.org('小组A1x', a1);
  const b = await w.org('部门B');
  const s1 = await w.job('sequences', '序列甲');
  const s2 = await w.job('sequences', '序列乙');
  const l1 = await w.job('levels', '职级一', { level: 1 });
  const l2 = await w.job('levels', '职级二', { level: 2 });
  const forms = (await (await w.session.request('GET', '/employment-forms')).json()) as { items: { code: string }[] };
  const form = forms.items[0]!.code;

  const p = {
    // 恰满 6 个月、恰 25 岁
    p1: await w.hire('结构甲', {
      date: '2026-04-01',
      department: a1,
      profile: { gender: '男', birthday: '2001-10-01', educationLevel: '本科' },
      fields: { sequenceId: s1.id, levelId: l1.id, employmentForm: form, employmentType: '合成类别甲' },
    }),
    // 恰满 1 年、恰 30 岁、试用中（试用期最长 6 个月；没办转正，人员状态仍是试用）
    p2: await w.hire('结构乙', {
      date: '2025-10-01',
      department: a1x,
      profile: { gender: '女', birthday: '1996-10-01', educationLevel: '硕士研究生' },
      fields: { sequenceId: s2.id, levelId: l2.id },
      probationMonths: 6,
    }),
    // 差一天满 6 个月、恰 51 岁；没有学历、序列、职级
    p3: await w.hire('结构丙', {
      date: '2026-04-02',
      department: b,
      profile: { gender: '保密', birthday: '1975-10-01' },
    }),
    // 满 11 年；没有性别、出生日期
    p4: await w.hire('结构丁', {
      date: '2015-10-01',
      department: b,
      profile: { educationLevel: '大专' },
      fields: { sequenceId: s1.id },
    }),
  };
  // 实习生不在看板范围（“正式员工，不含实习生”）
  const intern = await w.hire('结构实习', {
    date: '2026-01-01',
    department: a1,
    profile: { gender: '男', birthday: '2004-01-01', educationLevel: '本科' },
    fields: { employType: 'intern' },
  });
  return { w, institution, a1, a1x, b, s1, s2, l1, l2, form, p, intern };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('AC-HA-13a B49 人员结构分析', () => {
  let x: World;
  let c: BoardClient;
  beforeAll(async () => {
    x = await buildWorld();
    c = boardClient(database().db, x.w.who);
  }, 300_000);

  it('AC-HA-13a-01：组件目录 6.01～6.14；asOf 缺省 = 租户今天；6.01 在职人数不含实习生，数字 = 明细', async () => {
    const board = await c.board(B);
    expect(board.asOf).toBe('2026-10-01');
    expect(board.hasDataPermission).toBe(true);
    expect(board.components.map((item) => item.code)).toEqual(
      ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14'].map((n) => `6.${n}`),
    );
    const { p1, p2, p3, p4 } = x.p;
    await c.expectCount(B, '6.01', ids(p1, p2, p3, p4), AS_OF);
    expect((await c.detail(B, '6.01', AS_OF)).ids).not.toContain(x.intern.id);
    // 时点：asOf 前一天还没入职的人不算
    await c.expectCount(B, '6.01', ids(p2, p4), 'asOf=2026-03-31');
  });

  it('AC-HA-13a-02：平均年龄 / 平均司龄（1 位小数，空值不进样本）与机构人数（前 20，没有机构的回落租户根）', async () => {
    const { p1, p2, p3, p4 } = x.p;
    expect(await c.component(B, '6.02', AS_OF)).toMatchObject({ name: '平均年龄', value: 35.3, count: 3 });
    // 司龄 0.5 / 1.0 / 0.4 / 11.0（365 天一年、截断 1 位，同名册）→ 平均 3.2
    expect(await c.component(B, '6.03', AS_OF)).toMatchObject({ name: '平均司龄', value: 3.2, count: 4 });
    await c.expectCount(B, '6.02', ids(p1, p2, p3), AS_OF);
    await c.expectCount(B, '6.03', ids(p1, p2, p3, p4), AS_OF);

    const institutions = (await c.component(B, '6.04', AS_OF)).groups!;
    expect(institutions.map((g) => [g.key, g.count])).toEqual(
      expect.arrayContaining([
        [x.institution.id, 2],
        [x.w.tenantId, 2],
      ]),
    );
    expect(institutions).toHaveLength(2);
    expect(institutions.find((g) => g.key === x.institution.id)!.label).toBe('机构A');
    await c.expectCount(B, '6.04', ids(p1, p2), AS_OF, x.institution.id);
    await c.expectCount(B, '6.04', ids(p3, p4), AS_OF, x.w.tenantId);
  });

  it('AC-HA-13a-03：分组组件——职级、职务序列（含空）、试用 / 正式、司龄 6 段、学历四档、年龄 6 段、性别；固定分段零值也列出', async () => {
    const { p1, p2, p3, p4 } = x.p;
    const cases: [string, string, readonly { id: string }[]][] = [
      ['6.05', x.l1.id, [p1]],
      ['6.05', x.l2.id, [p2]],
      ['6.05', 'none', [p3, p4]],
      ['6.06', x.s1.id, [p1, p4]],
      ['6.06', x.s2.id, [p2]],
      ['6.06', 'none', [p3]],
      ['6.07', 'regular', [p1, p3, p4]],
      ['6.07', 'probation', [p2]],
      ['6.08', 'under6m', [p3]],
      ['6.08', '6mto1y', [p1]],
      ['6.08', '1to2y', [p2]],
      ['6.08', '2to5y', []],
      ['6.08', '10yplus', [p4]],
      ['6.12', 'doctor', []],
      ['6.12', 'master', [p2]],
      ['6.12', 'bachelor', [p1]],
      ['6.12', 'collegeOrBelow', [p4]],
      ['6.12', 'none', [p3]],
      ['6.13', 'under25', []],
      ['6.13', '25to30', [p1, p2]],
      ['6.13', '51plus', [p3]],
      ['6.13', 'none', [p4]],
      ['6.14', '男', [p1]],
      ['6.14', '女', [p2]],
      ['6.14', '保密', [p3]],
      ['6.14', 'none', [p4]],
    ];
    for (const [code, group, people] of cases) await c.expectCount(B, code, ids(...people), AS_OF, group);

    const tenure = (await c.component(B, '6.08', AS_OF)).groups!;
    expect(tenure.map((g) => g.key)).toEqual(['under6m', '6mto1y', '1to2y', '2to5y', '5to10y', '10yplus', 'none']);
    expect(tenure.map((g) => g.label).slice(0, 2)).toEqual(['6月以下', '6月~1年']);
    expect((await c.component(B, '6.07', AS_OF)).groups!.map((g) => [g.label, g.count])).toEqual([
      ['正式', 3],
      ['试用', 1],
    ]);
  });

  it('AC-HA-13a-04：6.11 按机构的本科及以上占比（分子 / 分母 / 占比）；6.09 / 6.10 没有数据源返回 null，明细 404', async () => {
    const { p1, p2 } = x.p;
    const ratio = (await c.component(B, '6.11', AS_OF)).groups!;
    expect(ratio.find((g) => g.key === x.institution.id)).toMatchObject({ count: 2, total: 2, ratio: 1 });
    expect(ratio.find((g) => g.key === x.w.tenantId)).toMatchObject({ count: 0, total: 2, ratio: 0 });
    await c.expectCount(B, '6.11', ids(p1, p2), AS_OF, x.institution.id);
    await c.expectCount(B, '6.11', [], AS_OF, x.w.tenantId);

    for (const code of ['6.09', '6.10']) {
      expect(await c.component(B, code, AS_OF)).toMatchObject({ kind: 'unavailable', value: null, groups: null });
      expect((await c.get(`${B}/components/${code}?${AS_OF}`)).status).toBe(404);
    }
  });

  it('AC-HA-13a-04：看板筛选——任职机构、任职部门（含下级）、职位序列、用工形式、人员类别；数字与明细同一筛选', async () => {
    const { p1, p2, p3, p4 } = x.p;
    const cases: [string, readonly { id: string }[]][] = [
      [`institutionId=${x.institution.id}`, [p1, p2]],
      [`institutionId=${x.w.tenantId}`, [p3, p4]],
      [`departmentId=${x.a1.id}`, [p1, p2]],
      [`departmentId=${x.a1x.id}`, [p2]],
      [`sequenceId=${x.s1.id}`, [p1, p4]],
      [`employmentForm=${encodeURIComponent(x.form)}`, [p1]],
      [`employmentType=${encodeURIComponent('合成类别甲')}`, [p1]],
      [`employmentType=${encodeURIComponent('不存在的类别')}`, []],
    ];
    for (const [filter, people] of cases) await c.expectCount(B, '6.01', ids(...people), `${AS_OF}&${filter}`);
    await c.expectCount(B, '6.14', ids(p2), `${AS_OF}&departmentId=${x.a1.id}`, '女');
  });

  it('AC-HA-13a-04：参数校验——asOf / 筛选 ID 不合法 400，未知组件 404', async () => {
    for (const bad of ['asOf=2026-02-30', 'asOf=abc', 'departmentId=abc', 'institutionId=1', 'sequenceId=x'])
      expect((await c.get(`${B}?${bad}`)).status, bad).toBe(400);
    expect((await c.get(`${B}/components/6.99?${AS_OF}`)).status).toBe(404);
    expect((await c.get(`${B}/components/6.01?${AS_OF}&pageSize=0`)).status).toBe(400);
  });
});
