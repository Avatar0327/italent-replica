/**
 * R2-T09b 验收夹具：离职 / 退休的职责转交强校验（DT-R4）、业务内指定日期（DT-R3）与未转交清空（DT-R5）。
 * 在职责转交菜单夹具（menuWorld：组织负责人、转交记录、检查离职退休人员）之上叠加退休辅助；全部经公开 HTTP 入口。
 */
import { sql } from '@italent/db';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { menuWorld } from './AC-DT-menu-support.js';
import { retireBody, withRetirement } from './AC-RT-support.js';

export const TODAY = '2026-10-06';
/** DT-R4 的提示原文（北森实测，规格 `30` “补充：强校验实测”）。 */
export const DT_R4_MESSAGE = '检查到该人员还有职责未指定接收人，无法继续操作。请执行职责转交操作';

export type ExitKind = 'leave' | 'retirement';

export async function dutyExitWorld(db: Db, label: string, today = TODAY) {
  const m = await menuWorld(db, label, today);
  const x = withRetirement(db, m, today);
  const tenantId = x.session.tenant.id;
  const bodyOf = (kind: ExitKind, last: string, mode: 'application' | 'direct', exit?: object) =>
    kind === 'leave'
      ? leaveBody(last, mode, mode === 'application' ? { exitTypeCode: 'voluntary', ...exit } : exit)
      : retireBody(last, mode, exit);

  /** 被转交人担任负责人的组织。 */
  async function headedOrg(name: string, holderId = x.employee.id) {
    const org = await x.session.org(name, { establishedOn: '2026-01-01' });
    await x.setHead(org.id, holderId);
    return org;
  }
  /** 请求体里的转交计划（exit.dutyTransfer）。 */
  const plan = (items: {
    subordinates?: { employeeId: string; receiverId: string }[];
    orgRoles?: { orgId: string; receiverId: string }[];
  }) => ({
    subordinates: (items.subordinates ?? []).map((s) => ({ ...s, relation: 'direct' })),
    orgRoles: (items.orgRoles ?? []).map((o) => ({ ...o, role: 'person_in_charge' })),
  });

  /** 直接离职 / 退休（公开入口，真实门禁）；原样返回响应，时钟按“生效日已到则停在最后工作日”处理。 */
  const tryDirect = (kind: ExitKind, last: string, exit?: object) =>
    x.atDay(x.parkedDay(last, today), () => x.createLeave(x.employee.id, bodyOf(kind, last, 'direct', exit)));
  async function createdDirect(kind: ExitKind, last: string, exit?: object) {
    const response = await tryDirect(kind, last, exit);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; status: string };
  }
  /** 申请离职 / 退休：提交后在 at 审批通过（不校验职责）。 */
  async function approvedApplication(kind: ExitKind, last: string, at: string, exit?: object) {
    const draft = await x.createdLeave(x.employee.id, bodyOf(kind, last, 'application', exit));
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    return x.approve(draft, `${x.parkedDay(last, at)}T02:00:00Z`);
  }

  async function problem(response: Response) {
    const body = (await response.json()) as {
      error?: { code: string; message: string; details?: { reason?: string } };
    };
    return {
      status: response.status,
      code: body.error?.code,
      message: body.error?.message,
      reason: body.error?.details?.reason,
    };
  }
  async function expectRejected(response: Response) {
    expect(await problem(response)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: DT_R4_MESSAGE,
      reason: 'EXIT_DUTY_TRANSFER_REQUIRED',
    });
  }

  const exitTiming = async (businessId: string) =>
    (
      await x.sqlRows<{ timing: string; date: string | null }>(sql`SELECT duty_transfer_timing AS timing,
        duty_transfer_date::text AS date FROM exit_requests WHERE tenant_id=${tenantId}
        AND business_id=${businessId}::uuid`)
    )[0];
  /** 写入面计数：拒绝时业务对象与扩展行都不能多出一行。 */
  const writes = async () =>
    (
      await x.sqlRows<{ businesses: number; exits: number; runs: number }>(sql`SELECT
        (SELECT count(*)::int FROM employment_business_objects WHERE tenant_id=${tenantId}) AS businesses,
        (SELECT count(*)::int FROM exit_requests WHERE tenant_id=${tenantId}) AS exits,
        (SELECT count(*)::int FROM transfer_linkage_runs WHERE tenant_id=${tenantId}) AS runs`)
    )[0]!;
  /** 转交记录视图里属于离职 / 退休的行（来源 2 / 4）。 */
  async function exitRecords(employeeId = x.employee.id) {
    const listed = await x.records('tab=all');
    return listed.items.filter((row) => row.employeeId === employeeId && row.source !== 1);
  }
  const patchExit = async (id: string, revision: number, body: object, kind: ExitKind = 'leave') =>
    x.session.request('PATCH', `/${kind === 'leave' ? 'exits' : 'retirements'}/${id}`, { ifMatch: revision, body });

  return {
    ...x,
    headedOrg,
    plan,
    bodyOf,
    tryDirect,
    createdDirect,
    approvedApplication,
    problem,
    expectRejected,
    exitTiming,
    writes,
    exitRecords,
    patchExit,
    tenantId,
  };
}

export type DutyExitWorld = Awaited<ReturnType<typeof dutyExitWorld>>;

/**
 * 固定“下属先于经理”的锁序场景：UUID 是随机生成的，所以先换世界直到经理的 UUID 落在上半区，再逐个造下属直到有一个更小的
 * （经理在上半区时每次命中概率 ≥ 1/2，30 次内未命中的概率约 1e-9，不会随机红）。
 */
export async function smallerSubordinateWorld(make: (label: string) => Promise<DutyExitWorld>, label: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = await make(`${label}-${attempt}`);
    if (x.employee.id.toLowerCase() < '80000000') continue;
    for (let index = 0; index < 30; index++) {
      const candidate = await x.subordinateOf(x.employee.id, `合成小号下属${index}`);
      if (candidate.id.toLowerCase() < x.employee.id.toLowerCase()) return { x, subordinate: candidate };
    }
  }
  throw new Error('未取得 UUID 小于经理的下属');
}
