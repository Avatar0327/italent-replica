/**
 * R2-T04 BE-5a 验收夹具：退休办理与生效（docs/08_设计/R2-T04_退休设计.md）。
 * 在 downstreamWorld（离职生效 / 下游夹具）之上加：退休请求体、直接 / 申请 / 审批退休、扩展行读取、
 * 人事“预计 / 实际退休日期”读写。退休与离职共用一个门禁和一个生效编排器，所以夹具也共用离职的那一套。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { addDays } from '@italent/domain';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { dayAt } from './AC-EXIT-activation-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';

export const retireBody = (lastWorkDate: string, mode: 'application' | 'direct' = 'application', exit?: object) => ({
  kind: 'retirement',
  mode,
  lastWorkDate,
  fields: {},
  ...(exit ? { exit } : {}),
});

/** 专用入口 POST retirements/employees/:id 的请求体（不带 kind）。 */
export const dedicatedBody = (lastWorkDate: string, mode: 'application' | 'direct' = 'application', exit?: object) => ({
  mode,
  lastWorkDate,
  ...(exit ? { exit } : {}),
});

/** 在任一退休可用的夹具（离职生效 / 下游夹具及其扩展，如撤销 / 编制夹具）之上叠加退休辅助。 */
export function withRetirement<W extends Awaited<ReturnType<typeof downstreamWorld>>>(
  db: Db,
  x: W,
  today = '2026-10-06',
) {
  const tenantId = x.session.tenant.id;
  const rows = <T>(statement: ReturnType<typeof sql>) => x.sqlRows<T>(statement);

  /** 生效日 E = L + 1 已到时，保存会当场生效；“已确认待生效”的夹具把时钟拨到 L 当天保存（同 exitActivationWorld）。 */
  const parkedDay = (lastWorkDate: string, day: string) => (addDays(lastWorkDate, 1) <= day ? lastWorkDate : day);

  const createRetire = (employeeId: string, body: object) => x.createLeave(employeeId, body);
  const createdRetire = (employeeId: string, body: object) => x.createdLeave(employeeId, body);

  /** 直接退休（最后工作日 L）：E ≤ 今天时按 L 当天保存，停在 approved，供编排器 / 调度验证。 */
  async function directRetire(lastWorkDate: string, exit?: object, employeeId = x.employee.id) {
    return x.atDay(parkedDay(lastWorkDate, today), () =>
      createdRetire(employeeId, retireBody(lastWorkDate, 'direct', exit)),
    );
  }

  /** 提交（审批中）的退休申请。 */
  async function submittedRetire(lastWorkDate: string, employeeId = x.employee.id, exit?: object) {
    const draft = await createdRetire(employeeId, retireBody(lastWorkDate, 'application', exit));
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    if (sent.status !== 200) throw new Error(`提交失败 ${await sent.text()}`);
    return draft;
  }

  const retirementRow = async (businessId: string) =>
    (
      await rows<{
        employee_id: string;
        expected_retirement_date: string | null;
        retire_type: string | null;
        re_employed: boolean;
      }>(sql`SELECT employee_id, expected_retirement_date::text, retire_type, re_employed FROM retirement_requests
        WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`)
    )[0];

  /** 人事最新版本的预计 / 实际退休日期。 */
  const retirementDates = async (employeeId = x.employee.id) =>
    (
      await rows<{ expected: string | null; actual: string | null; revision: number }>(sql`
        SELECT expected_retirement_date::text AS expected, actual_retirement_date::text AS actual, revision
        FROM personnel_employee_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
        ORDER BY revision DESC LIMIT 1`)
    )[0] ?? { expected: null, actual: null, revision: 0 };

  /** 写入人事“预计退休日期”P（走人事写端口，与人事 PATCH 同一版本链）。 */
  async function setExpectedRetirement(date: string | null, employeeId = x.employee.id) {
    await withTenant(db, tenantId, (tx) =>
      appendEmployee(
        tx,
        {
          tenantId,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: dayAt(today),
          commandId: randomUUID(),
          expectedRevision: 0,
        } as never,
        employeeId,
        { expectedRetirementDate: date },
        false,
      ),
    );
  }

  const audits = (businessId: string, action: string) => x.audits(businessId, action);
  const employeeStatusOf = async (businessId: string) =>
    (
      await rows<{ s: number }>(
        sql`SELECT employee_status AS s FROM employment_records WHERE tenant_id=${tenantId} AND id=${businessId}::uuid`,
      )
    )[0]?.s;

  return {
    ...x,
    parkedDay,
    createRetire,
    createdRetire,
    directRetire,
    submittedRetire,
    retirementRow,
    retirementDates,
    setExpectedRetirement,
    audits,
    employeeStatusOf,
  };
}

export async function retirementWorld(db: Db, label: string, today = '2026-10-06') {
  return withRetirement(db, await downstreamWorld(db, label, today), today);
}

export type RetirementWorld = Awaited<ReturnType<typeof retirementWorld>>;
