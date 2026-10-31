/**
 * BE-13a / AC-HA-13a-05～06：员工结构两张报表（B53，规格 35“补充：员工结构两张报表”）。
 * 一级组织 × 列；默认雇佣关系 = 内部员工（不含实习生），可切到实习生 / 全部；带时点与部门筛选。
 * 固定夹具（asOf = 2026-10-01）：一级组织 机构A（甲、乙）、部门B（丙、丁）；实习生戊在机构A。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { boardClient, structureWorld, type BoardClient, type Report } from './AC-HA-13a-support.js';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-01';

async function buildWorld() {
  const w = await structureWorld(database().db, 'ha13a-reports');
  const a = await w.org('机构A', undefined, '机构');
  const a1 = await w.org('部门A1', a);
  const b = await w.org('部门B');
  const s1 = await w.job('sequences', '序列甲');
  const s2 = await w.job('sequences', '序列乙');
  // asOf 当天有效但没人用的字典项也展开成列（值 0）
  const s3 = await w.job('sequences', '序列丙');
  const l1 = await w.job('levels', '职级一', { level: 1 });
  const l2 = await w.job('levels', '职级二', { level: 2 });
  await w.hire('报表甲', {
    date: '2026-04-01',
    department: a1,
    profile: { gender: '男', birthday: '2001-10-01', educationLevel: '本科' },
    fields: { sequenceId: s1.id, levelId: l1.id, employmentType: '合成类别甲', employmentSource: '内部推荐' },
  });
  await w.hire('报表乙', {
    date: '2025-10-01',
    department: a,
    profile: { gender: '女', birthday: '1996-10-01', educationLevel: '硕士' },
    fields: { sequenceId: s2.id, levelId: l2.id, employmentSource: '社会招聘' },
    probationMonths: 6,
  });
  await w.hire('报表丙', { date: '2026-04-02', department: b, profile: { gender: '保密', birthday: '1975-10-01' } });
  await w.hire('报表丁', {
    date: '2015-10-01',
    department: b,
    profile: { educationLevel: '大专' },
    fields: { sequenceId: s1.id },
  });
  await w.hire('报表实习', {
    date: '2026-01-01',
    department: a1,
    profile: { gender: '男', birthday: '2004-01-01', educationLevel: '本科' },
    fields: { employType: 'intern' },
  });
  return { w, a, a1, b, s1, s2, s3, l1, l2 };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

const row = (report: Report, organizationId: string) =>
  report.rows.find((item) => item.organizationId === organizationId)!.cells;

describe('AC-HA-13a B53 员工结构报表', () => {
  let x: World;
  let c: BoardClient;
  beforeAll(async () => {
    x = await buildWorld();
    c = boardClient(database().db, x.w.who);
  }, 300_000);

  it('AC-HA-13a-05：员工素质结构——一级组织 × 合计 / 性别 / 学历四档 / 司龄 6 段 / 平均司龄 / 年龄 6 段 / 平均年龄', async () => {
    const report = await c.report('quality', AS_OF);
    expect(report).toMatchObject({ asOf: '2026-10-01', report: 'quality', employType: 'internal' });
    expect(report.columns.map((column) => column.key)).toEqual([
      'total',
      'gender:男',
      'gender:女',
      'education:doctor',
      'education:master',
      'education:bachelor',
      'education:collegeOrBelow',
      'tenure:under6m',
      'tenure:6mto1y',
      'tenure:1to2y',
      'tenure:2to5y',
      'tenure:5to10y',
      'tenure:10yplus',
      'avgTenure',
      'age:under25',
      'age:25to30',
      'age:31to35',
      'age:36to40',
      'age:41to50',
      'age:51plus',
      'avgAge',
    ]);
    expect(report.rows.map((item) => item.organizationName).sort()).toEqual(['机构A', '部门B'].sort());
    expect(row(report, x.a.id)).toMatchObject({
      total: 2,
      'gender:男': 1,
      'gender:女': 1,
      'education:master': 1,
      'education:bachelor': 1,
      'education:collegeOrBelow': 0,
      'tenure:6mto1y': 1,
      'tenure:1to2y': 1,
      avgTenure: 0.8,
      'age:25to30': 2,
      avgAge: 27.5,
    });
    // 部门B：保密 / 空性别不进男女列，空学历不进四档；没有出生日期的不进年龄段与平均年龄
    expect(row(report, x.b.id)).toMatchObject({
      total: 2,
      'gender:男': 0,
      'gender:女': 0,
      'education:collegeOrBelow': 1,
      'education:bachelor': 0,
      'tenure:under6m': 1,
      'tenure:10yplus': 1,
      avgTenure: 5.7,
      'age:51plus': 1,
      avgAge: 51,
    });
    expect(report.summary.cells).toMatchObject({ total: 4, 'gender:男': 1, avgTenure: 3.2, avgAge: 35.3 });
  });

  it('AC-HA-13a-06：员工任职结构——雇佣关系人数与占比、试用 / 正式、人员来源、人员类别、职务序列与职级按字典展开、性别', async () => {
    const report = await c.report('position', AS_OF);
    const keys = report.columns.map((column) => column.key);
    expect(keys.slice(0, 5)).toEqual([
      'total',
      'employType:internal',
      'employType:internal:ratio',
      'employType:intern',
      'employType:intern:ratio',
    ]);
    // 职务序列 / 职级按 asOf 当天有效的字典项展开（没人用的也有列）；人员来源 / 人员类别按出现的值展开
    for (const key of [
      `sequence:${x.s1.id}`,
      `sequence:${x.s2.id}`,
      `sequence:${x.s3.id}`,
      `level:${x.l1.id}`,
      `level:${x.l2.id}`,
      'status:2',
      'status:3',
      'source:内部推荐',
      'source:社会招聘',
      'category:合成类别甲',
      'gender:男',
      'gender:女',
    ])
      expect(keys, key).toContain(key);
    expect(report.columns.find((column) => column.key === `sequence:${x.s3.id}`)!.label).toBe('序列丙');
    expect(row(report, x.a.id)).toMatchObject({
      total: 2,
      'employType:internal': 2,
      'employType:internal:ratio': 1,
      'employType:intern': 0,
      'status:2': 1,
      'status:3': 1,
      'source:内部推荐': 1,
      'source:社会招聘': 1,
      'category:合成类别甲': 1,
      [`sequence:${x.s1.id}`]: 1,
      [`sequence:${x.s2.id}`]: 1,
      [`sequence:${x.s3.id}`]: 0,
      [`level:${x.l1.id}`]: 1,
      'gender:男': 1,
    });
    expect(row(report, x.b.id)).toMatchObject({ total: 2, 'status:3': 2, [`sequence:${x.s1.id}`]: 1 });
    expect(report.summary.cells).toMatchObject({ total: 4, [`sequence:${x.s1.id}`]: 2 });
  });

  it('AC-HA-13a-06：雇佣关系切换（实习生 / 全部）、部门筛选（含下级）与时点；参数不合法 400、未知报表 404', async () => {
    const intern = await c.report('position', `${AS_OF}&employType=intern`);
    expect(intern.summary.cells).toMatchObject({ total: 1, 'employType:intern': 1, 'employType:intern:ratio': 1 });
    const all = await c.report('position', `${AS_OF}&employType=all`);
    expect(row(all, x.a.id)).toMatchObject({
      total: 3,
      'employType:internal': 2,
      'employType:internal:ratio': 0.6667,
      'employType:intern': 1,
      'employType:intern:ratio': 0.3333,
    });
    const department = await c.report('quality', `${AS_OF}&departmentId=${x.a.id}`);
    expect(department.rows.map((item) => item.organizationId)).toEqual([x.a.id]);
    expect(department.summary.cells).toMatchObject({ total: 2 });
    // 2026-03-31：甲、丙还没入职
    expect((await c.report('quality', 'asOf=2026-03-31')).summary.cells).toMatchObject({ total: 2 });

    for (const bad of ['employType=external', 'asOf=2026-13-01', 'departmentId=bad'])
      expect((await c.get(`/api/tenant/analytics/hr-structure/reports/quality?${bad}`)).status, bad).toBe(400);
    expect((await c.get('/api/tenant/analytics/hr-structure/reports/unknown')).status).toBe(404);
  });
});
