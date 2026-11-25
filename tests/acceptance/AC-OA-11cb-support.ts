/**
 * BE-11c-b 调动明细世界：在执行世界上加调动明细的写入口（路由 16～18）、可信夹具（同一形状的库内调动行，
 * 基线取生效日现行任职与员工 revision，与写服务同口径）和读库。读写一律在对应租户的 withTenant 内（F-212）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, orgAdjustmentTransferItems, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { normalizeLinkage } from '../../apps/api/src/modules/transfer/linkage/input.js';
import { E, execWorld } from './AC-OA-exec-support.js';
import { BASE } from './AC-OA-head-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

export const FORM_ID = 'TenantBase.CrossDepartmentTransferMultiFormView';
export const TRANSFER_TYPE = 'cross_department';

export interface TransferRowView {
  id: string;
  seq: number;
  employee_id: string;
  department_id: string | null;
  department_item_id: string | null;
  base_record_id: string;
  base_employee_revision: number;
  exec_phase: number;
  execution_result: number | null;
  execution_reason: string | null;
  created_business_id: string | null;
  linkage: Record<string, unknown> | null;
}

export async function transferWorld(db: Db, label: string, options: Parameters<typeof execWorld>[2] = {}) {
  const w = await execWorld(db, label, options);
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, w.tenant.id, fn);
  const ifMatchOf = async (id: string, ifMatch?: number) => ifMatch ?? (await w.stored(id))!.revision;
  const send = async (method: string, path: string, id: string, body: unknown, ifMatch?: number, user = w.hr.id) =>
    w.call(method, `${BASE}/${id}${path}`, { ifMatch: await ifMatchOf(id, ifMatch), body }, user);

  /** 调动明细载荷：目标部门必填，类型与表单由调用方显式给出（11c-a 交接假设）。 */
  const transferBody = (
    employeeId: string,
    department: Record<string, string>,
    over: Record<string, unknown> = {},
  ) => ({
    employeeId,
    department,
    transferTypeCode: TRANSFER_TYPE,
    formId: FORM_ID,
    ...over,
  });
  const addTransfer = (id: string, body: Record<string, unknown>, ifMatch?: number, user?: string) =>
    send('POST', '/transfer-items', id, body, ifMatch, user);
  const patchTransfer = (id: string, itemId: string, body: Record<string, unknown>, ifMatch?: number, user?: string) =>
    send('PATCH', `/transfer-items/${itemId}`, id, body, ifMatch, user);
  const deleteTransfer = (id: string, itemId: string, ifMatch?: number, user?: string) =>
    send('DELETE', `/transfer-items/${itemId}`, id, undefined, ifMatch, user);

  async function transfer(id: string, body: Record<string, unknown>) {
    const res = await addTransfer(id, body);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { revision: number; items: { id: string }[] };
  }

  /** 可信夹具：库内调动行（与写服务同一基线口径），不经写路由；用于只验执行 / 开闸的用例。 */
  async function seed(
    id: string,
    employeeId: string,
    over: Partial<typeof orgAdjustmentTransferItems.$inferInsert> & { linkageInput?: unknown } = {},
  ) {
    const { linkageInput, ...columns } = over;
    const itemId = randomUUID();
    await inTenant(async (tx) => {
      const record = await findCurrentRecord(tx, w.tenant.id, employeeId, E);
      const [base] = resultRows<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM employment_employees WHERE id = ${employeeId}`),
      );
      const [last] = resultRows<{ seq: number }>(
        await tx.execute(sql`SELECT coalesce(max(seq), 0)::int AS seq FROM org_adjustment_transfer_items
          WHERE adjustment_id = ${id}`),
      );
      await tx.insert(orgAdjustmentTransferItems).values({
        id: itemId,
        tenantId: w.tenant.id,
        adjustmentId: id,
        seq: last!.seq + 1,
        employeeId,
        baseRecordId: record!.id,
        baseEmployeeRevision: base!.revision,
        departmentId: w.b,
        transferTypeCode: TRANSFER_TYPE,
        formId: FORM_ID,
        dottedManagerSpecified: Object.hasOwn(columns, 'dottedManagerId'),
        ...(linkageInput === undefined ? {} : { linkage: normalizeLinkage(linkageInput) }),
        ...columns,
      });
    });
    return itemId;
  }

  async function transferRows(id: string): Promise<TransferRowView[]> {
    return inTenant(async (tx) =>
      resultRows<TransferRowView>(
        await tx.execute(sql`SELECT id, seq, employee_id, department_id, department_item_id, base_record_id,
            base_employee_revision, exec_phase, execution_result, execution_reason, created_business_id, linkage
          FROM org_adjustment_transfer_items WHERE adjustment_id = ${id} ORDER BY seq`),
      ),
    );
  }

  /** 可信夹具：同一员工的 n 行占位调动行（库内无按员工唯一索引；只供上限用例，不经写路由）。 */
  async function seedMany(id: string, employeeId: string, count: number) {
    await inTenant(async (tx) => {
      const record = await findCurrentRecord(tx, w.tenant.id, employeeId, E);
      await tx.execute(sql`INSERT INTO org_adjustment_transfer_items
        (id, tenant_id, adjustment_id, seq, employee_id, base_record_id, base_employee_revision, department_id,
         transfer_type_code, form_id)
        SELECT gen_random_uuid(), ${w.tenant.id}, ${id}, g, ${employeeId}, ${record!.id}, 1, ${w.b},
          ${TRANSFER_TYPE}, ${FORM_ID} FROM generate_series(1, ${count}) g`);
    });
  }

  async function transferAudits(id: string): Promise<string[]> {
    return inTenant(async (tx) =>
      resultRows<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events WHERE object_type = 'org-adjustment-transfer-item'
          AND coalesce(after->>'adjustmentId', before->>'adjustmentId') = ${id} ORDER BY occurred_at, id`),
      ).map((row) => row.action),
    );
  }

  /** 生效日当天入职的员工（同日入职，11c2 前调动入口关闭）：走入职业务接口，入职日 = 调整单生效日。 */
  async function staffHiredOnEffectiveDate(departmentId: string) {
    const created = await w.employee(`ZZ_同日入职${uniqueSuffix()}`);
    const body = { kind: 'hire', mode: 'direct', effectiveDate: E, fields: { employType: 'internal', departmentId } };
    const res = await w.call('POST', `/api/tenant/employment/employees/${created.id}/businesses`, {
      ifMatch: created.revision,
      body: withLoginEmail(created.id, body),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return created.id;
  }

  /** 建单 + 一条改名明细 + 调动明细（可信夹具）+ 提交 + 两节点同意。 */
  async function approvedWithTransfers(
    range: readonly string[],
    transfers: readonly (readonly [employeeId: string, over?: Parameters<typeof seed>[2]])[],
    orgItems: readonly Record<string, unknown>[] = [],
  ) {
    const view = await w.created(w.headBody({ adjustmentRange: range }));
    for (const item of orgItems) await w.item(view.id, item);
    const itemIds: string[] = [];
    for (const [employeeId, over] of transfers) itemIds.push(await seed(view.id, employeeId, over));
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.acted(view.id, w.head, 'approve');
    return { id: view.id, itemIds };
  }

  /** 员工在某日的现行任职（部门、类型、来源）。 */
  async function currentRecord(employeeId: string, date = E) {
    return inTenant(async (tx) => {
      const [row] = resultRows<{ id: string; department_id: string | null; kind: string; change_type: string | null }>(
        await tx.execute(sql`SELECT id, department_id, kind, change_type FROM employment_records
          WHERE employee_id = ${employeeId} AND start_date <= ${date}::date
          ORDER BY start_date DESC, created_at DESC LIMIT 1`),
      );
      return row;
    });
  }

  /** 合同夹具（走合同业务接口）：先建类型与法人公司主数据，再给员工建一份现行合同；合同表读自己的租户。 */
  async function contractOf(employeeId: string) {
    const master = async (kind: string, name: string) => {
      const res = await w.call('POST', `/api/tenant/contracts/master-data/${kind}`, {
        ifMatch: 0,
        body: { code: randomUUID(), name },
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const fields = {
      typeId: await master('types', 'ZZ_劳动合同'),
      companyId: await master('companies', 'ZZ_合成法人公司'),
      effectiveDate: '2026-09-01',
      endDate: '2028-08-31',
      termType: 'fixed',
      termMonths: 24,
      signingDate: '2026-08-25',
    };
    const res = await w.call('POST', '/api/tenant/contracts/commands', {
      ifMatch: 0,
      body: { operation: 'create', mode: 'direct', employeeId, fields },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function contractChanges(employeeId: string) {
    return inTenant(async (tx) =>
      resultRows<{ before: string; after: string }>(
        await tx.execute(sql`SELECT before_contract_id AS before, after_contract_id AS after
          FROM contract_changes WHERE employee_id = ${employeeId}`),
      ),
    );
  }

  return {
    ...w,
    contractOf,
    contractChanges,
    inTenant,
    transferBody,
    addTransfer,
    patchTransfer,
    deleteTransfer,
    transfer,
    seed,
    seedMany,
    transferAudits,
    staffHiredOnEffectiveDate,
    transferRows,
    approvedWithTransfers,
    currentRecord,
  };
}

export type TransferWorld = Awaited<ReturnType<typeof transferWorld>>;
