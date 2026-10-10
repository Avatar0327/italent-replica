/**
 * F-043（#107 第 3 轮审查存量问题，DEC-285④）：360 普通同步循环写入前按目标人员范围复核。
 * 精细化权限生效时（受限管理员，admin.people 非空），同步循环原来只按“员工信息范围”挑员工，对已挂接的 360 人员照写
 * （名称、部门、职位、上级……）——人员在该管理员的 360 人员范围外时同样被覆盖，回执只是把条目藏起来（写入已经发生）。
 * 修复：已挂接的人员在每次写入前按目标人员范围（与人员列表同一谓词，含创建人维度）复核；范围外的跳过、不写，
 * 回执里记入 skipped（受限查看人看到的与“没有这个人”相同，不泄露存在性），并写审计（action = survey360.person.sync_skipped，
 * 对象 = 该 360 人员，只有能查看该人员日志的人看得到）。精细化关闭或不受限管理员不受影响。
 * 反向用例断言具体值：范围外人员的 name / revision 前后各读一次，范围内的照常覆盖。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { scene as baseScene, type SyncPage } from './AC-360-F043-support.js';

const testDb = useTestDb();
const scene = (label: string, fine: boolean) => baseScene(testDb().db, label, fine);

describe('F-043 精细化下同步循环写入前按目标人员范围复核', () => {
  it('范围外已挂接的人员不被覆盖（名称与 revision 前后不变），范围内照常覆盖；回执里看不到范围外条目', async () => {
    const s = await scene('f043a', true);
    const page = await s.w.ok<SyncPage>(s.sync());

    expect(page.updated).toEqual([{ personId: s.insidePerson.id, employeeId: s.inside.id }]);
    expect(JSON.stringify(page)).not.toContain(s.outside.id);
    expect(JSON.stringify(page)).not.toContain(s.outsidePerson.id);
    expect((await s.current(s.insidePerson.id)).name).toBe('范围内新名');
    const outside = await s.current(s.outsidePerson.id);
    expect(outside.name).toBe(s.outsidePerson.name);
    expect(outside.revision).toBe(s.outsidePerson.revision);
  });

  it('每个被跳过的人员记一条审计（对象 = 该 360 人员）：系统管理员看得到，受限管理员看不到；重放不重复记', async () => {
    const s = await scene('f043b', true);
    const key = randomUUID();
    const first = await s.w.ok<SyncPage>(s.sync(key));
    const logs = await s.skippedLogs(s.w.admin);
    expect(logs.map((log) => log.objectId)).toEqual([s.outsidePerson.id]);
    expect(logs[0]!.objectType).toBe('survey360-person');
    expect(await s.skippedLogs(s.admin)).toEqual([]);

    const replay = await s.w.ok<SyncPage>(s.sync(key));
    expect(replay).toEqual(first);
    expect((await s.skippedLogs(s.w.admin)).length).toBe(1);
  });

  it('不受限的系统管理员同步仍覆盖范围外人员；之后受限同步不再有变化', async () => {
    const s = await scene('f043c', true);
    await s.w.ok(s.sync());
    expect((await s.current(s.outsidePerson.id)).name).toBe(s.outsidePerson.name);
    const full = await s.w.ok<SyncPage>(s.w.request('POST', '/people/sync', { body: {} }));
    expect(full.updated.map((e) => e.employeeId).sort()).toEqual([s.outside.id].sort());
    expect((await s.current(s.outsidePerson.id)).name).toBe('范围外新名');
    expect((await s.skippedLogs(s.w.admin)).length).toBe(1);
  });

  it('精细化关闭时不复核：范围外员工同样被覆盖，不记跳过审计（与改动前一致）', async () => {
    const s = await scene('f043d', false);
    const page = await s.w.ok<SyncPage>(s.sync());
    expect(page.updated.map((e) => e.employeeId).sort()).toEqual([s.inside.id, s.outside.id].sort());
    expect((await s.current(s.outsidePerson.id)).name).toBe('范围外新名');
    expect(await s.skippedLogs(s.w.admin)).toEqual([]);
  });
});

/**
 * F-043 第 5 轮（#210 第 4 轮审查 P2-1，DEC-408①）：自动添加的候选查询不截断，按顺序逐个判定直到凑够数量或候选耗尽。
 * 排在前面的下属都在受限管理员的 360 范围外，后面才有范围内的合法下属时，“自动添加 1 名下级”必须加上后者，
 * 不能返回成功却一个都没加。
 */
describe('F-043 自动添加：排在前面的候选都不可添加时继续往后找', () => {
  it('前 3 名下属在范围外（工号排在前面），自动添加 1 名下级 → 加上排在后面的范围内下属', async () => {
    const s = await scene('f043auto', true);
    // 经理名下再招 3 名乙部门（范围外）下属，工号排在范围内下属之前（按工号、ID 排序）
    for (const index of [1, 2, 3]) {
      const employee = await s.w.session.employee(`范围外下属${index}`, `A00${index}`);
      await s.w.session.business(
        employee.id,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2025-01-01',
          fields: { departmentId: s.orgB, directManagerId: s.manager.id },
        },
        employee.revision,
      );
    }
    await s.w.ok(s.w.request('POST', '/people/sync', { body: {} }));
    const q = await s.w.enableQuestionnaire(await s.w.keyBehavior());
    const activity = await s.w.activity({ name: 'F-043 自动添加往后找' }, s.admin);
    const object = await s.w.ok<{ id: string }>(
      s.as('POST', `/activities/${activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: s.managerPerson.id, questionnaireIds: [q.id] },
      }),
      201,
    );
    const result = await s.w.ok<{ added: { appraiserPersonId: string }[]; skipped: unknown[] }>(
      s.as('POST', `/activities/${activity.id}/objects/${object.id}/appraisers/auto`, {
        ifMatch: 0,
        body: { roles: ['subordinate'], limits: { subordinate: 1 } },
      }),
    );
    expect(result.added.map((r) => r.appraiserPersonId)).toEqual([s.insidePerson.id]);
    expect(result.skipped).toEqual([]);
  });
});
