/**
 * AC-F476-08（P8 IDP 片，第 5 轮 P2-1，DEC-869 / DEC-834④；设计 §5.2“办理时不可见，后来新增权限也不补露”）：
 * 关键信息的披露上限在办理时按办理人的数据范围（行）与字段权限（列）冻结进办理份。
 * - 办理后收窄办理人的范围：已办读取仍列出办理时可见的行；办理时范围外的行办理份里也没有。
 * - 办理后放宽办理人的字段权：已办读取不补露办理时看不到的字段，办理份里也没有。
 * - 另一类业务（组织调整）的办理份不受影响：内容仍是 snapshot + 组织调整扩展，扩展与直接加载的结果一致。
 * 办理与读取都走真实授权器：员工另授关键信息三对象（无计划查看权 → 参与人分支）与本部门范围。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadOrgContent } from '../../apps/api/src/modules/org-adjustment/content.js';
import { copiesOfPlan, GOAL_A, seen } from './AC-F476-idp-support.js';
import { copiesOf, NAME_A } from './AC-F476-support.js';
import { idpOperator } from './AC-IDP-permission-support.js';
import { IDP, permissionWorldOf, planWorld } from './AC-IDP-plan-support.js';
import { flowWorld } from './AC-OA-approval-support.js';
import { rename } from './AC-OA-items-support.js';

const testDb = useTestDb();
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };
const STRENGTHS = 'ZZ_办理时可见的优势';
const HIDDEN_ITEMS = 'ZZ_办理时看不到的待发展项';
const OUT_REMARK = 'ZZ_范围外带教备注';

const idsOf = (rows: readonly Record<string, unknown>[] | undefined) => (rows ?? []).map((r) => r.id).sort();

/**
 * 关键信息：范围内带教 / 职业发展 / 轮岗各一条，另有一条带教人在范围外的带教。员工（办理人）持关键信息三对象、
 * 本部门范围，career 可另隐藏部分字段；员工经真实授权器“同意”（提交）第 1 阶段，留下办理份。
 */
async function handledScene(label: string, hiddenCareer: readonly string[] = []) {
  const w = await planWorld(testDb().db, label);
  const pw = await permissionWorldOf(w);
  const otherOrg = await w.org('范围外部门');
  const stranger = await w.person('范围外带教人', otherOrg);
  const make = async (path: string, body: Record<string, unknown>) =>
    (await w.ok<{ id: string }>(await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body }), 201)).id;
  const employeeId = w.employee.employeeId;
  const ids = {
    tutorIn: await make('/tutorships', { tutorEmployeeId: w.manager.employeeId, tuteeEmployeeId: employeeId, ...span }),
    tutorOut: await make('/tutorships', {
      tutorEmployeeId: stranger.employeeId,
      tuteeEmployeeId: employeeId,
      remark: OUT_REMARK,
      ...span,
    }),
    career: await make('/careers', { employeeId, strengths: STRENGTHS, developmentItems: HIDDEN_ITEMS, ...span }),
    shift: await make('/work-shifts', { employeeId, orgId: w.dept, ...span }),
  };
  const handler = await idpOperator(pw, {
    objects: ['tutorship', 'career', 'workShift'],
    orgId: w.dept,
    user: { id: w.employee.userId },
    hidden: { career: hiddenCareer },
  });
  const plan = await w.startedPlan();
  await w.addGoal(plan, w.employee.userId, { name: GOAL_A });
  const { instance, task } = await w.pendingTask(plan, 1, w.employee.userId);
  const handled = await w.realHttp(w.employee.userId, 'POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
    ifMatch: instance.revision,
    body: {},
  });
  expect(handled.status, await handled.clone().text()).toBe(200);
  const copies = (await copiesOfPlan(w, plan.id)).filter((copy) => copy.actor_user_id === w.employee.userId);
  expect(copies).toHaveLength(1);
  return { w, handler, ids, plan, stranger, copy: copies[0]! };
}

describe('AC-F476-08 IDP：关键信息的披露上限在办理时冻结（P2-1）', () => {
  it('办理后收窄办理人的数据范围：已办读取仍是办理时可见的行；办理时范围外的行办理份里也没有', async () => {
    const { w, handler, ids, plan, stranger, copy } = await handledScene('f476-idp-ceil-scope');
    await handler.setOrg(null);
    // 范围确已收窄：直接读取已是 404
    expect((await handler.request('GET', `/tutorships/${ids.tutorIn}`)).status).toBe(404);
    expect((await handler.request('GET', `/careers/${ids.career}`)).status).toBe(404);

    const view = await seen(w, w.employee.userId, plan.id);
    expect(view.contentView).toMatchObject({ mode: 'frozen' });
    expect(idsOf(view.keyInfo?.tutorships)).toEqual([ids.tutorIn]);
    expect(idsOf(view.keyInfo?.careers)).toEqual([ids.career]);
    expect(idsOf(view.keyInfo?.workShifts)).toEqual([ids.shift]);
    expect(view.keyInfo?.careers?.[0]).toMatchObject({ strengths: STRENGTHS });
    for (const leaked of [ids.tutorOut, stranger.employeeId, OUT_REMARK]) expect(copy.text).not.toContain(leaked);
  });

  it('办理后放宽办理人的字段权：已办读取不补露办理时看不到的字段，办理份里也没有', async () => {
    const { w, handler, ids, plan, copy } = await handledScene('f476-idp-ceil-field', ['developmentItems']);
    await handler.hideFields('career', []);
    // 字段权确已放宽：直接读取已能看到
    expect(await (await handler.request('GET', `/careers/${ids.career}`)).text()).toContain(HIDDEN_ITEMS);

    const view = await seen(w, w.employee.userId, plan.id);
    expect(view.contentView).toMatchObject({ mode: 'frozen' });
    const career = view.keyInfo?.careers?.find((row) => row.id === ids.career);
    expect(career).toMatchObject({ strengths: STRENGTHS });
    expect(career).not.toHaveProperty('developmentItems');
    expect(JSON.stringify(view)).not.toContain(HIDDEN_ITEMS);
    expect(copy.text).toContain(STRENGTHS);
    expect(copy.text).not.toContain(HIDDEN_ITEMS);
  });

  it('不外溢：组织调整的办理份仍只有 snapshot / ext，ext 与办理前直接加载的组织调整内容一致', async () => {
    const w = await flowWorld(testDb().db, 'f476-idp-ceil-org');
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const expected = await withTenant(w.db, w.tenant.id, (tx) => loadOrgContent(tx, w.tenant.id, id));
    expect(expected).not.toBeNull();
    await w.acted(id, w.hrbp, 'approve');

    const [copy] = await copiesOf(w, (await w.instance(id)).id);
    const content = JSON.parse(copy!.text) as Record<string, unknown>;
    expect(Object.keys(content).sort()).toEqual(['ext', 'snapshot']);
    expect(content.ext).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(copy!.text).toContain(NAME_A);
  });
});
