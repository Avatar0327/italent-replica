/**
 * AC-F476-08（P8 IDP 片，第 5 轮 P2-1，DEC-869 / DEC-834④；设计 §5.2“办理时不可见，后来新增权限也不补露”）：
 * 关键信息的披露上限在办理时按办理人的数据范围（行）与字段权限（列）冻结进办理份。
 * - 办理后收窄办理人的范围：已办读取仍列出办理时可见的行；办理时范围外的行办理份里也没有。
 * - 办理后放宽办理人的字段权：已办读取不补露办理时看不到的字段，办理份里也没有。
 * - 另一类业务（组织调整）的办理份不受影响：内容仍是 snapshot + 组织调整扩展，扩展与直接加载的结果一致。
 * - 同一命令里的自动处理（同人自动同意）写系统份：actor 为空，关键信息按“无办理人”存空，不按触发命令的人工操作人
 *   裁剪（第 6 轮 P2-1 残留：采集身份与最终写份的 actor 同口径）。
 * 办理与读取都走真实授权器：员工另授关键信息三对象（无计划查看权 → 参与人分支）与本部门范围。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadOrgContent } from '../../apps/api/src/modules/org-adjustment/content.js';
import { copiesOfPlan, GOAL_A, seen } from './AC-F476-idp-support.js';
import { copiesOf, NAME_A } from './AC-F476-support.js';
import { idpOperator } from './AC-IDP-permission-support.js';
import { IDP, permissionWorldOf, planWorld, type PlanWorldOptions } from './AC-IDP-plan-support.js';
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
async function handledScene(label: string, hiddenCareer: readonly string[] = [], options: PlanWorldOptions = {}) {
  const w = await planWorld(testDb().db, label, options);
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
  return { w, handler, ids, plan, stranger, instance, copy: copies[0]! };
}

/** 制定计划阶段：员工制定目标 → 员工确认（与上一节点审批人相同，自动同意）。 */
const EMPLOYEE = { type: 'object_field', value: 'idp_employee' };
const EMPLOYEE_ACTIONS = { avoidSelf: false, reject: false, jump: true, revoke: false };
const AUTO_SAME_NODES = [
  { key: 'set_goals', name: '制定发展目标', approver: EMPLOYEE, actions: EMPLOYEE_ACTIONS },
  {
    key: 'approve_plan',
    name: '员工确认发展计划',
    approver: EMPLOYEE,
    actions: EMPLOYEE_ACTIONS,
    sameAssigneeSkip: true,
    sameAssigneeResult: 'approve',
  },
];

interface KindRow extends Record<string, unknown> {
  readonly node_key: string;
  readonly handling_kind: string;
  readonly actor_user_id: string | null;
  readonly key_info: Record<string, unknown> | null;
}

async function kindsOf(w: Awaited<ReturnType<typeof planWorld>>, instanceId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    // 同一命令里两份的 acted_at 相同，按各自办理日志的写入顺序排
    const result = await tx.execute(sql`SELECT c.node_key, c.handling_kind, c.actor_user_id::text,
        c.content->'ext'->'keyInfoShown' AS key_info
      FROM approval_handling_contents c
      JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
      WHERE c.instance_id = ${instanceId}::uuid ORDER BY l.created_at, l.seq`);
    return (Array.isArray(result) ? result : (result as { rows: KindRow[] }).rows) as KindRow[];
  });
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

  it('同一命令里同人自动同意的系统份：actor 为空、关键信息存空；人工份仍是办理人看得到的那份', async () => {
    const { w, ids, instance } = await handledScene('f476-idp-ceil-auto', [], { planNodes: AUTO_SAME_NODES });
    const rows = await kindsOf(w, instance.id);
    expect(rows.map((row) => [row.node_key, row.handling_kind, row.actor_user_id])).toEqual([
      ['set_goals', 'human', w.employee.userId],
      ['approve_plan', 'system', null],
    ]);
    const [human, system] = rows;
    const careers = (human!.key_info?.careers ?? []) as Record<string, unknown>[];
    expect(careers.map((row) => row.id)).toEqual([ids.career]);
    expect(careers[0]).toMatchObject({ strengths: STRENGTHS });
    expect(idsOf(human!.key_info?.tutorships as Record<string, unknown>[])).toEqual([ids.tutorIn]);
    expect(system!.key_info).toEqual({});
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
