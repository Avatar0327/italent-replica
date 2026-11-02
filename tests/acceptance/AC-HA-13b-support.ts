/**
 * BE-13b 人员流动分析（B50）与流动情况报表（B54）的验收夹具（规格 35“补充：BE-13…”B50、“流动情况各报表的算法”）。
 * 一套固定的组织 / 人员 / 入离职 / 调动造数（租户今天 = 2026-10-06），期望值一律是手写的 ID 集合与数字。
 * 看板客户端、受限授权与管理单元范围复用 BE-13a 的夹具（AC-HA-13a-support）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, type Db } from '@italent/db';
import { expect } from 'vitest';
import { retireBody, retirementWorld } from './AC-RT-support.js';
import { boardClient } from './AC-HA-13a-support.js';
import { pinExitGate, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const MOVEMENT_BASE = '/api/tenant/analytics/hr-movement';
/** 字典编码类分组键（离职类型 / 原因 / 去向、调动类型）：JSON 元组，空值为 null（第 3 轮，不用字符串哨兵）。 */
export const groupKey = (...parts: (string | null)[]) => JSON.stringify(parts);
export const MOVEMENT_TODAY = '2026-10-06';
const LONG_AGO = '2000-01-01';

export interface ReportTable {
  key: string;
  name: string;
  columns: { key: string; label: string }[];
  rows: { key: string; label: string; cells: Record<string, number | null> }[];
  summary: { cells: Record<string, number | null> };
}
export interface MovementReport {
  asOf: string;
  report: string;
  name: string;
  kind: string;
  year: number;
  month: number | null;
  hasDataPermission: boolean;
  tables: ReportTable[] | null;
}
export interface MovementGroup {
  key: string;
  label: string;
  count: number;
  parent?: string | null;
  opening?: number;
  closing?: number;
  rate?: number;
  ratio?: number | null;
}

/** 看板 / 明细沿用 BE-13a 客户端；report 读流动情况报表。 */
export function movementClient(
  db: Db,
  who: { tenant: string; user: string },
  authorize?: Parameters<typeof boardClient>[2],
) {
  const c = boardClient(db, who, authorize);
  async function report(code: string, filters = '') {
    const response = await c.get(`${MOVEMENT_BASE}/reports/${code}?${filters}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as MovementReport;
  }
  const groups = async (code: string, filters: string) =>
    ((await c.component(MOVEMENT_BASE, code, filters)).groups ?? []) as unknown as MovementGroup[];
  const group = async (code: string, filters: string, key: string) =>
    (await groups(code, filters)).find((item) => item.key === key);
  return { ...c, report, groups, group };
}

export async function movementWorld(db: Db) {
  const x = await retirementWorld(db, 'ha-13b', MOVEMENT_TODAY);
  const tenantId = x.session.tenant.id;
  const who = { tenant: tenantId, user: x.session.user.id };
  const api = tenantApi(db, { clock: () => new Date(`${MOVEMENT_TODAY}T01:00:00Z`) });
  const call = (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, path, { ...init, user: who.user, tenant: who.tenant });
  const org = (name: string, parent?: { id: string }) =>
    x.session.org(name, {
      establishedOn: LONG_AGO,
      ...(parent ? { parents: { admin: { parentId: parent.id } } } : {}),
    });

  async function sequence(name: string) {
    const response = await call('POST', '/api/tenant/job/sequences', {
      ifMatch: 0,
      body: { name, code: `HA13B_${randomUUID().replaceAll('-', '')}`, startDate: LONG_AGO },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  async function hire(name: string, date: string, department: { id: string }, fields: Record<string, unknown> = {}) {
    const employee = await x.session.employee(name);
    await x.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: date,
        fields: { employType: 'internal', departmentId: department.id, ...fields },
      },
      employee.revision,
    );
    return employee;
  }
  /** 性别 / 出生日期经人员 PATCH，最高学历经教育子集写入（同 BE-13a 夹具）。 */
  async function profile(employeeId: string, { educationLevel, ...patch }: Record<string, string>) {
    const education = await call('POST', `/api/tenant/personnel/employees/${employeeId}/subsets/education`, {
      ifMatch: 0,
      body: { educationLevel, isHighestEducation: true },
    });
    expect(education.status, await education.clone().text()).toBe(201);
    const current = (await (await call('GET', `/api/tenant/personnel/employees/${employeeId}`)).json()) as {
      revision: number;
    };
    const patched = await call('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
      ifMatch: current.revision,
      body: patch,
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
  }
  /** 合成离职字典（编码带随机后缀，不与预置字典冲突）。 */
  async function dictionary(table: 'exit_types' | 'exit_reasons' | 'exit_whereabouts', name: string) {
    const code = `ha13b_${uniqueSuffix()}`;
    await x.sqlRows(
      sql`INSERT INTO ${sql.identifier(table)}(tenant_id, code, name) VALUES (${tenantId}, ${code}, ${name})`,
    );
    return code;
  }
  /** 已生效离职（可信造数端口）+ 回填离职类型 / 原因 / 去向。 */
  async function leave(
    employeeId: string,
    lastWorkDate: string,
    codes: { type?: string; reason?: string; whereabouts?: string } = {},
  ) {
    const created = await x.effectiveExit(employeeId, lastWorkDate);
    await x.sqlRows(sql`UPDATE exit_requests SET exit_type_code=${codes.type ?? null},
        reason_code=${codes.reason ?? null}, whereabouts_code=${codes.whereabouts ?? null}
      WHERE tenant_id=${tenantId} AND business_id=${created.id}::uuid`);
    return created;
  }
  /** 已生效退休（同 AC-HA-01-02-05 的造数：seed 端口落地后补扩展行）。 */
  async function retire(employeeId: string, lastWorkDate: string) {
    const previous = pinExitGate('seed');
    let created: { id: string; status: string };
    try {
      created = await x.createdLeave(employeeId, retireBody(lastWorkDate, 'direct'));
    } finally {
      pinExitGate(previous);
    }
    expect(created.status).toBe('effective');
    await x.sqlRows(sql`INSERT INTO exit_requests(tenant_id,business_id,employee_id,staff_id,initiator_user_id,mode,
        initiator,duty_transfer_timing)
      SELECT ${tenantId},${created.id}::uuid,${employeeId}::uuid,c.id,${who.user}::uuid,'direct','hr',
        'business_effective'
      FROM employment_cycles c WHERE c.tenant_id=${tenantId} AND c.employee_id=${employeeId}::uuid
      ORDER BY c.entry_date DESC LIMIT 1`);
  }
  /** 调动模块的直接调动（带异动类型）。 */
  async function transfer(employeeId: string, effectiveDate: string, department: { id: string }) {
    const response = await x.session.request('POST', `/transfers/employees/${employeeId}`, {
      ifMatch: (await x.session.getEmployee(employeeId)).revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate,
        fields: { departmentId: department.id },
      },
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  }

  /** 直接办理带部门变化的非调动任职业务（转正 / 组织调整）。 */
  async function departmentChange(employeeId: string, kind: string, effectiveDate: string, department: { id: string }) {
    const response = await x.session.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: (await x.session.getEmployee(employeeId)).revision,
      body: {
        kind,
        mode: 'direct',
        effectiveDate,
        fields: { departmentId: department.id },
        ...(kind === 'regularization' ? { probationResult: 'normal' } : {}),
      },
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  }

  // ---- 组织：甲（含下级甲一组）、乙、范围外、空部门 ----
  const A = await org('甲部');
  const A1 = await org('甲一组', A);
  const B = await org('乙部');
  const H = await org('范围外部');
  const E = await org('空部门');
  const S1 = await sequence('技术序列');
  const T = { vol: await dictionary('exit_types', '主动离职'), inv: await dictionary('exit_types', '被动离职') };
  const R = { pay: await dictionary('exit_reasons', '薪酬'), dev: await dictionary('exit_reasons', '发展') };
  const W = { peer: await dictionary('exit_whereabouts', '同行业') };

  // ---- 人员（期望集合据此手工推导）----
  const p = {
    base: x.employee, // 底层夹具自带：2026-09-01 入职“调出部门”（一级）
    old: await hire('老员工', '2025-01-10', A),
    jan31: await hire('一月底离职', '2025-06-01', A, { isKeyPerson: true }),
    m30: await hire('三十天离职', '2026-03-01', A, { sequenceId: S1.id }),
    m31: await hire('三十一天离职', '2026-03-01', B),
    oct1: await hire('十月一日入职', '2026-10-01', A),
    intern: await hire('实习生', '2026-02-01', B, { employType: 'intern' }),
    external: await hire('外部人员', '2026-02-02', A, { employType: 'external' }),
    extLeave: await hire('外部人员离职', '2026-01-05', A, { employType: 'external' }),
    retired: await hire('七月退休', '2025-03-01', A),
    lastYear: await hire('去年离职', '2025-02-01', A),
    hidden: await hire('范围外离职', '2026-02-10', H),
    reg: await hire('转正', '2025-01-10', A),
    orgAdj: await hire('组织调整', '2025-01-10', A),
  };
  await profile(p.m30.id, { gender: '男', birthday: '1996-05-20', educationLevel: '本科' });
  await leave(p.jan31.id, '2026-01-31', { type: T.vol, reason: R.pay, whereabouts: W.peer });
  await leave(p.m30.id, '2026-03-31', { type: T.vol, reason: R.dev });
  await leave(p.m31.id, '2026-04-01', { type: T.inv });
  await leave(p.extLeave.id, '2026-05-10', { type: T.vol });
  await leave(p.lastYear.id, '2025-11-14', { type: T.inv });
  await leave(p.hidden.id, '2026-08-31', { type: T.vol });
  await retire(p.retired.id, '2026-06-30');
  await transfer(p.old.id, '2026-05-01', A1);
  // 转正同时调动、组织架构调整引起的调动：部门真的从甲部变到甲一组（甲的下级，按甲筛选不变），但业务类型不是“调动”，
  // 6.27 / 调动列都不计（审查 P3-1）
  await departmentChange(p.reg.id, 'regularization', '2026-06-01', A1);
  await departmentChange(p.orgAdj.id, 'org_adjustment', '2026-06-02', A1);

  return {
    ...{ x, db, tenantId, who, A, A1, B, H, E, S1, T, R, W, p, from: x.from },
    ...{ call, org, sequence, hire, leave, retire, transfer },
  };
}
export type MovementWorld = Awaited<ReturnType<typeof movementWorld>>;
