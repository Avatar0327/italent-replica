/**
 * R2 BE-5c2 验收夹具：退休规则每日批次与立即执行（docs/08_设计/R2-T04_退休设计.md §9.2）。
 * 在 pbWorld（经路由入职的合成员工）之上加：个人资料写入（出生日期、性别，走人事写端口）、预计日期 / 弹性范围规则、
 * 两个自动计算开关、人事最新版本读取、批次登记与跳过清单读取。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { pbWorld, hire, type PbWorld } from './AC-PB-support.js';
import { expect } from 'vitest';
import { tenantApi } from './support/tenant-api.js';

export const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
export const SWITCH = {
  expected_date: 'retirement.auto_expected_date',
  flexible_range: 'retirement.auto_flexible_range',
} as const;
export type Purpose = keyof typeof SWITCH;

/** 租户本地 10:00（Asia/Shanghai）；day 为 UTC 日期，批次业务日 = 该日 + 0（10:00 本地仍是同一天）。 */
export const clockAt = (day: string, time = '02:00:00') => new Date(`${day}T${time}.000Z`);

export interface PersonRow {
  expected: string | null;
  confirmed: boolean | null;
  earliest: string | null;
  latest: string | null;
  flexConfirmed: boolean | null;
  revision: number;
}

export async function batchWorld(db: Db, label: string) {
  const w: PbWorld = await pbWorld(db, label);
  const tenantId = w.session.tenant.id;
  const userId = w.session.user.id;
  const settings = tenantApi(db);
  const sqlRows = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, tenantId, async (tx) => rows<T>(await tx.execute(statement)));

  async function setSwitch(purpose: Purpose, value: boolean) {
    const key = `/api/tenant/settings/${SWITCH[purpose]}`;
    const as = { user: userId, tenant: tenantId };
    const current = await settings.request('GET', key, as);
    expect(current.status, await current.clone().text()).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const response = await settings.request('PUT', key, { ...as, ifMatch: revision, body: { value } });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** 经人事写端口写资料（与人事 PATCH 同一版本链，走 normalizeRetirementRange）。 */
  async function setPerson(employeeId: string, patch: Record<string, unknown>) {
    await withTenant(db, tenantId, (tx) =>
      appendEmployee(
        tx,
        {
          tenantId,
          userId,
          timezone: w.session.tenant.timezone,
          now: clockAt('2026-09-15'),
          commandId: randomUUID(),
          expectedRevision: 0,
        } as never,
        employeeId,
        patch,
        false,
      ),
    );
  }

  /** 入职一名合成员工并写出生日期 / 性别 / 国籍；返回员工 ID。 */
  async function member(name: string, person: Record<string, unknown> = {}) {
    const { employee } = await hire(w, { date: '2026-09-01', months: 1, name });
    await setPerson(employee.id, { birthday: '1975-06-10', gender: 'male', nationality: 'CN', ...person });
    return employee.id;
  }

  async function personOf(employeeId: string): Promise<PersonRow> {
    return (
      await sqlRows<PersonRow>(sql`SELECT expected_retirement_date::text AS expected,
          expected_retirement_confirmed AS confirmed, earliest_retirement_date::text AS earliest,
          latest_retirement_date::text AS latest, flexible_range_confirmed AS "flexConfirmed", revision
        FROM personnel_employee_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
        ORDER BY revision DESC LIMIT 1`)
    )[0]!;
  }

  const employeeCondition = [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }];

  /** 固定年龄预计日期规则（适用 w.org）。 */
  async function fixedAgeRule(years: number, extra: Record<string, unknown> = {}) {
    const response = await w.session.request('POST', '/retirement-rules', {
      ifMatch: 0,
      body: {
        purpose: 'expected_date',
        name: `固定年龄-${years}`,
        priority: 1,
        orgIds: [w.org.id],
        retirementAgeYears: years,
        retirementAgeMonths: 0,
        conditions: employeeCondition,
        ...extra,
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  }

  /** 弹性范围规则：选用内置法定函数（DEC-641）。 */
  async function statutoryRangeRule(extra: Record<string, unknown> = {}) {
    const response = await w.session.request('POST', '/retirement-rules', {
      ifMatch: 0,
      body: {
        purpose: 'flexible_range',
        name: '法定弹性范围',
        priority: 1,
        orgIds: [w.org.id],
        earliestFunction: 'statutory_earliest',
        latestFunction: 'statutory_latest',
        conditions: employeeCondition,
        ...extra,
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  }

  async function runRow(purpose: Purpose, businessDate: string) {
    return (
      await sqlRows<{
        state: string;
        position: string | null;
        attempts: number;
        skipped: number;
        lease: string;
      }>(sql`SELECT state, position_employee_id::text AS position, attempts, skipped_count AS skipped,
          lease_until::text AS lease
        FROM retirement_rule_daily_runs WHERE tenant_id=${tenantId} AND purpose=${purpose}
          AND business_date=${businessDate}::date`)
    )[0];
  }
  /** 员工直接办理离职（最后工作日已过），业务日当天时间轴记录是 leave，不再是批次候选。 */
  async function leave(employeeId: string, lastWorkDate = '2026-09-20') {
    const current = await w.session.getEmployee(employeeId);
    await w.session.business(employeeId, { kind: 'leave', mode: 'direct', lastWorkDate, fields: {} }, current.revision);
  }
  const audits = (employeeId: string) => sql`SELECT action, actor_user_id::text AS actor, after FROM audit_events
    WHERE tenant_id=${tenantId} AND scope_employee_id=${employeeId}::uuid ORDER BY occurred_at, id`;
  const runCount = async () =>
    (
      await sqlRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM retirement_rule_daily_runs
      WHERE tenant_id=${tenantId}`)
    )[0]!.n;
  const skipRows = (purpose: Purpose, businessDate: string) =>
    sqlRows<{ employeeId: string; state: string }>(sql`SELECT employee_id::text AS "employeeId", state
      FROM retirement_rule_run_skips WHERE tenant_id=${tenantId} AND purpose=${purpose}
        AND business_date=${businessDate}::date ORDER BY employee_id`);

  return {
    ...w,
    tenantId,
    userId,
    sqlRows,
    setSwitch,
    setPerson,
    member,
    personOf,
    fixedAgeRule,
    statutoryRangeRule,
    leave,
    audits,
    runRow,
    runCount,
    skipRows,
  };
}

export type BatchWorld = Awaited<ReturnType<typeof batchWorld>>;
