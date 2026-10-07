import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';

// 参数表写在本文件顶层，供 ac-coverage 静态读取（DEC-245）。
const SUBSETS = [
  ['education', { educationLevel: '本科', school: '合成大学' }],
  ['jobhistory', { company: '合成单位', responsibilities: '研究' }],
  ['family', { name: '合成家属', relationship: '父母' }],
  ['training', { name: '合成培训', hours: 8 }],
  ['certificate', { name: '合成证书', number: 'SYN-001' }],
  ['awards', { name: '合成奖项', category: '集体' }],
  ['project-experience', { name: '合成项目', headcount: 3 }],
  ['skill', { name: '合成技能', months: 12 }],
  ['language-ability', { language: '中文', isNative: true }],
  ['estimation-result', { year: 2026, totalGrade: 'A', finalScore: 95 }],
  ['punish', { month: '2026-01', description: '合成记录' }],
  ['professional-technical-post', { qualificationName: '合成资格', level: '高级' }],
  ['vocational-qualification', { name: '合成职业资格', level: '高级' }],
] as const;

const database = useTestDb();
describe('AC-SUB-01/04 人员子集', () => {
  it.each(SUBSETS)('%s 有独立的标准字段 CRUD、来源、版本和删除快照', async (kind, body) => {
    const s = await personnelSession(database().db);
    const created = await s.add(kind, body);
    expect(created).toMatchObject({ ...body, sourceType: 'hr_direct', revision: 1 });
    const read = await s.request('GET', `${s.path(kind)}/${created.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject(body);
    const update = await s.request('PATCH', `${s.path(kind)}/${created.id}`, { ifMatch: 1, body });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ revision: 2 });
    const removed = await s.request('DELETE', `${s.path(kind)}/${created.id}`, { ifMatch: 2 });
    expect(removed.status).toBe(200);
    const list = await s.request('GET', s.path(kind));
    expect(await list.json()).toMatchObject({ items: [] });
    const history = await s.request('GET', `${s.path(kind)}/${created.id}/history`);
    expect(history.status).toBe(200);
    const versions = (await history.json()) as { items: Record<string, unknown>[] };
    expect(versions.items).toHaveLength(3);
    expect(versions.items[0]).toMatchObject({ ...body, deleted: true });
  });

  it('第二条最高学历自动取消旧标记并同步员工；删除后不猜下一最高学历', async () => {
    const s = await personnelSession(database().db);
    const first = await s.add('education', { school: '甲校', educationLevel: '本科', isHighestEducation: true });
    const second = await s.add('education', { school: '乙校', educationLevel: '硕士', isHighestEducation: true });
    const previous = await s.request('GET', `${s.path('education')}/${first.id}`);
    expect(await previous.json()).toMatchObject({ isHighestEducation: false, revision: 2 });
    const person = await s.request('GET', `/employees/${s.employee.id}`);
    expect(await person.json()).toMatchObject({ educationLevel: '硕士', lastSchool: '乙校' });
    expect((await s.request('DELETE', `${s.path('education')}/${second.id}`, { ifMatch: 1 })).status).toBe(200);
    expect(await (await s.request('GET', `/employees/${s.employee.id}`)).json()).toMatchObject({
      educationLevel: null,
    });
  });

  it.each([
    ['education', 'isFirstEducation', 'firstEducationLevel'],
    ['education', 'isHighestDegree', 'highestDegree'],
    ['education', 'isMainMajor', 'major'],
    ['professional-technical-post', 'isHighestLevel', 'highestTechnicalLevel'],
    ['vocational-qualification', 'isHighestLevel', 'highestVocationalLevel'],
  ])('%s 的 %s 最多一个且派生字段可读', async (kind, flag, reflected) => {
    const s = await personnelSession(database().db);
    const input =
      kind === 'education' ? { educationLevel: '本科', degree: '学士', major: '计算机' } : { level: '高级' };
    const first = await s.add(kind!, { ...input, [flag!]: true });
    await s.add(kind!, { ...input, [flag!]: true });
    expect(await (await s.request('GET', `${s.path(kind!)}/${first.id}`)).json()).toMatchObject({ [flag!]: false });
    expect(await (await s.request('GET', `/employees/${s.employee.id}`)).json()).toHaveProperty(reflected!);
  });

  it('409、幂等、缺失命令键、非法字段不产生多余版本', async () => {
    const s = await personnelSession(database().db);
    const key = randomUUID();
    const body = { school: '幂等大学' };
    const item = await s.add('education', body, { idempotencyKey: key });
    expect(await s.add('education', body, { idempotencyKey: key })).toEqual(item);
    expect(
      (
        await s.request('POST', s.path('education'), {
          ifMatch: 0,
          body: { school: '不同内容' },
          idempotencyKey: key,
        })
      ).status,
    ).toBe(409);
    expect((await s.request('PATCH', `${s.path('education')}/${item.id}`, { ifMatch: 0, body })).status).toBe(409);
    expect((await s.request('POST', s.path('education'), { ifMatch: 0, body, idempotencyKey: null })).status).toBe(400);
    expect((await s.request('POST', s.path('education'), { ifMatch: 0, body: { arbitrary: 1 } })).status).toBe(400);
  });

  it('子集列表分页上限与源标识校验，禁止伪造自助审批来源', async () => {
    const s = await personnelSession(database().db);
    expect((await s.request('GET', `${s.path('education')}?pageSize=201`)).status).toBe(400);
    expect(
      (
        await s.request('POST', s.path('education'), {
          ifMatch: 0,
          body: { school: '伪造', sourceType: 'self_service', sourceId: randomUUID() },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.request('POST', s.path('education'), {
          ifMatch: 0,
          body: { school: '缺来源', sourceType: 'info_collection' },
        })
      ).status,
    ).toBe(400);
  });

  it('实际子集表开启 FORCE RLS，跨租户直接 SQL 不可见', async () => {
    const db = database().db;
    const s = await personnelSession(db);
    await s.add('family', { name: '不外泄的合成家属' });
    const other = await personnelSession(db);
    await withTenant(db, other.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT * FROM personnel_family`);
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows).toHaveLength(0);
    });
    const result = await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname LIKE 'personnel_%' AND relkind='r'`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(28);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
