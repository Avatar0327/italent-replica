/**
 * F-366 实习生「实习中」排序（规格 31 末尾 F-366 补充）：原站默认 OrderCode 升序 + 实习开始日期降序，复刻没有 OrderCode，
 * 退化为实习开始日期（实习入职日）降序、同日记录 id 升序；表头只有实习机构 / 实习部门 / 直线经理三列可排，单列，
 * 值 方向 NULLS LAST、再 id 升序。其余三个页签未取证，不收排序参数。排序列须可查看，否则 403（不让排序成为探针）。
 */
import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { internWorld, scopedRequest, type InternViewItem, type InternWorld } from './AC-IN-BE6a-support.js';

const testDb = useTestDb();
const ids = (items: readonly InternViewItem[]) => items.map((item) => item.id);
const allFields = () =>
  [...MODULE_OBJECTS.employmentRecord.fields, ...MODULE_OBJECTS.employee.fields].map((field) => field.code);

/** 根下行政维度的组织，sequence 决定 DEC-089 名次。 */
const org = (w: InternWorld, name: string, broadType: string, parentId: string, sequence: number) =>
  w.session.org(`${name}-${randomUUID()}`, {
    broadType,
    establishedOn: '2024-01-01',
    parents: { admin: { parentId, sequence } },
  });

/** 实习入职：返回实习中视图里的行 ID（入职任职记录）。 */
const intern = async (w: InternWorld, name: string, effectiveDate: string, fields: Record<string, unknown>) =>
  (await w.hire(name, 'intern', { effectiveDate, fields: { employType: 'intern', ...fields } })).hireId;

/** 工号受控的在职经理：直线经理按工号排序（同兼职直线经理，view-sort.ts）。 */
async function manager(w: InternWorld, prefix: string, departmentId: string) {
  const created = await w.session.employee(`合成经理${prefix}`, `${prefix}_${randomUUID().replaceAll('-', '')}`);
  const hire = { kind: 'hire', mode: 'direct', effectiveDate: '2026-08-01', fields: { departmentId } };
  await w.session.business(created.id, hire, created.revision);
  return created.id;
}

describe('AC-IN-F366 实习中默认顺序', () => {
  it('不带排序参数：实习开始日期降序，新入职的在前', async () => {
    const w = await internWorld(testDb().db, 'f366-default');
    const older = await intern(w, '早入职合成实习生', '2026-09-01', { departmentId: w.org.id });
    const newer = await intern(w, '晚入职合成实习生', '2026-09-10', { departmentId: w.org.id });
    expect(ids(await w.view('interning'))).toEqual([newer, older]);
  });
});

describe('AC-IN-F366 三列单列排序', () => {
  it('实习机构：按部门上溯的最近机构名次升 / 降，行上返回同源的 institutionId', async () => {
    const w = await internWorld(testDb().db, 'f366-institution');
    const first = await org(w, '合成机构甲', '机构', w.session.tenant.id, 1);
    const second = await org(w, '合成机构乙', '机构', w.session.tenant.id, 2);
    const underSecond = await org(w, '乙下部门', '部门', second.id, 1);
    const underFirst = await org(w, '甲下部门', '部门', first.id, 1);
    // 后入职的挂在名次靠前的机构下：升序与默认（开始日期降序）恰好相反，不会被默认顺序蒙过
    const a = await intern(w, '机构乙合成实习生', '2026-09-10', { departmentId: underSecond.id });
    const b = await intern(w, '机构甲合成实习生', '2026-09-01', { departmentId: underFirst.id });
    const asc = await w.view('interning', '&sortBy=institutionId&direction=asc');
    expect(ids(asc)).toEqual([b, a]);
    expect(asc.map((item) => item.institutionId)).toEqual([first.id, second.id]);
    expect(ids(await w.view('interning', '&sortBy=institutionId'))).toEqual([b, a]);
    expect(ids(await w.view('interning', '&sortBy=institutionId&direction=desc'))).toEqual([a, b]);
  });

  it('实习部门：按部门名次升 / 降', async () => {
    const w = await internWorld(testDb().db, 'f366-department');
    const front = await org(w, '前部门', '部门', w.session.tenant.id, 1);
    const back = await org(w, '后部门', '部门', w.session.tenant.id, 2);
    const a = await intern(w, '后部门合成实习生', '2026-09-10', { departmentId: back.id });
    const b = await intern(w, '前部门合成实习生', '2026-09-01', { departmentId: front.id });
    expect(ids(await w.view('interning', '&sortBy=departmentId&direction=asc'))).toEqual([b, a]);
    expect(ids(await w.view('interning', '&sortBy=departmentId&direction=desc'))).toEqual([a, b]);
  });

  it('直线经理：按经理工号升 / 降，没有经理的排最后；行上返回 directManagerId', async () => {
    const w = await internWorld(testDb().db, 'f366-manager');
    const alpha = await manager(w, 'MGRA', w.org.id);
    const beta = await manager(w, 'MGRB', w.org.id);
    // 三条入职日两两不同，升序结果既不是旧的开始日期升序，也不是新的默认降序
    const none = await intern(w, '无经理合成实习生', '2026-09-10', { departmentId: w.org.id });
    const a = await intern(w, '经理乙合成实习生', '2026-09-01', { departmentId: w.org.id, directManagerId: beta });
    const b = await intern(w, '经理甲合成实习生', '2026-09-20', { departmentId: w.org.id, directManagerId: alpha });
    const asc = await w.view('interning', '&sortBy=directManagerId&direction=asc');
    expect(ids(asc)).toEqual([b, a, none]);
    expect(asc.map((item) => item.directManagerId ?? null)).toEqual([alpha, beta, null]);
    expect(ids(await w.view('interning', '&sortBy=directManagerId&direction=desc'))).toEqual([a, b, none]);
  });
});

describe('AC-IN-F366 排序参数校验与字段权限', () => {
  it('direction 不带 sortBy、不可排的列、非法方向、其余三个页签带排序：400', async () => {
    const w = await internWorld(testDb().db, 'f366-invalid');
    await intern(w, '校验合成实习生', '2026-09-01', { departmentId: w.org.id });
    const bad = [
      'view=interning&direction=asc',
      'view=interning&direction=desc',
      'view=interning&sortBy=name',
      'view=interning&sortBy=entryDate',
      'view=interning&sortBy=institution',
      'view=interning&sortBy=departmentId&direction=sideways',
      'view=converting&sortBy=departmentId',
      'view=converted&sortBy=institutionId&direction=asc',
      'view=left&sortBy=directManagerId',
    ];
    for (const query of bad) expect((await w.session.request('GET', `/interns?${query}`)).status, query).toBe(400);
  });

  it('看不到的字段不能用来排序（403），看得到时照常排序', async () => {
    const w = await internWorld(testDb().db, 'f366-hidden');
    await intern(w, '字段权限合成实习生', '2026-09-01', { departmentId: w.org.id });
    for (const field of ['institutionId', 'departmentId', 'directManagerId']) {
      const hidden = scopedRequest(
        w,
        [],
        allFields().filter((code) => code !== field),
        true,
      );
      const denied = await hidden('GET', `/interns?view=interning&sortBy=${field}&direction=asc`);
      expect(denied.status, field).toBe(403);
      expect(((await denied.json()) as { error: { code: string } }).error.code, field).toBe('FORBIDDEN');
      // 不排序时照常列出，但看不到的列不在响应里（新增的机构 / 经理两列同样按字段裁剪）
      const listed = (await (await hidden('GET', '/interns?view=interning')).json()) as { items: object[] };
      expect(listed.items.length, field).toBe(1);
      expect(Object.hasOwn(listed.items[0]!, field), field).toBe(false);
      const shown = scopedRequest(w, [], allFields(), true);
      expect((await shown('GET', `/interns?view=interning&sortBy=${field}&direction=asc`)).status, field).toBe(200);
    }
  });
});
