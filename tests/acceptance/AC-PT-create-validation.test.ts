/**
 * 兼职写入底座与创建校验（docs/08_设计/R2-T05_兼职设计.md §1.1 / §1.3 / §4.2 / §4.3 D-1～D-10，§9 PB-20～23；PT-3a 服务层）：
 * 内部服务 createPartTime 一次事务写底层业务头 + 载荷 + 状态事件 + 记录 + 期限链第 1 期 + 审计 / outbox；
 * 不进时间轴、不写 employment.record.create（P-04）、不触发向后更新；全部校验在员工行锁内，被拒绝时无任何写入。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { serviceWorld, type ServiceWorld } from './AC-PT-service-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

describe('createPartTime：写入底座（§1.3）', () => {
  it('一次写全：业务头 / 载荷 / 状态事件 / 记录 / 第 1 期 / 审计与 outbox；不进时间轴，主职读口径不变', async () => {
    const w = await serviceWorld(database().db, 'pt-create-shape');
    const before = await w.primaryView();
    const result = await w.create({ serviceType: 'secondment', startDate: '2026-09-01', endDate: '2026-12-31' });
    expect(result).toMatchObject({
      employeeId: w.employeeId,
      staffId: w.cycle.id,
      serviceType: 'secondment',
      startDate: '2026-09-01',
      endDate: '2026-12-31',
      departmentId: w.partTimeOrg.id,
      revision: 1,
      warnings: [],
    });
    const facts = await withTenant(w.db, w.tenantId, async (tx) => {
      const one = async <T>(query: ReturnType<typeof sql>) => rowsOf<T>(await tx.execute(query));
      const id = result.id;
      return {
        record: (
          await one<Record<string, unknown>>(sql`SELECT kind, service_type, staff_id, entry_date::text AS entry_date,
            start_date::text AS start_date, last_work_date, employ_type, job_number, department_id, is_inserted,
            inheritance_source_id, employee_status FROM employment_records WHERE tenant_id=${w.tenantId} AND id=${id}`)
        )[0],
        payloads: await one(sql`SELECT version_no, kind, mode, form_id, selected_staff_id, is_record_snapshot
          FROM employment_payload_versions WHERE tenant_id=${w.tenantId} AND business_id=${id}`),
        events: await one(sql`SELECT state, event_no FROM employment_state_events
          WHERE tenant_id=${w.tenantId} AND business_id=${id}`),
        timeline: await one(sql`SELECT 1 FROM employment_timeline WHERE tenant_id=${w.tenantId} AND record_id=${id}`),
        code: (
          await one<{ code: string }>(sql`SELECT code FROM employment_employees
            WHERE tenant_id=${w.tenantId} AND id=${w.employeeId}`)
        )[0]!.code,
        audit: await one<{ action: string; scope_org_id: string | null; scope_employee_id: string | null }>(
          sql`SELECT action, scope_org_id, scope_employee_id FROM audit_events
            WHERE tenant_id=${w.tenantId} AND object_id=${id}`,
        ),
        outbox: await one<{ event_type: string; employee_id: string }>(sql`SELECT event_type, employee_id
          FROM employment_outbox WHERE tenant_id=${w.tenantId} AND object_id=${id}::uuid`),
      };
    });
    expect(facts.record).toMatchObject({
      kind: 'part_time',
      service_type: 'secondment',
      staff_id: w.cycle.id,
      entry_date: w.cycle.entry_date,
      start_date: '2026-09-01',
      last_work_date: null,
      employ_type: 'internal',
      job_number: facts.code,
      department_id: w.partTimeOrg.id,
      is_inserted: false,
      inheritance_source_id: null,
    });
    // 人员状态只是快照，由 0062 触发器取同周期开始日的主职前一条
    expect(facts.record!.employee_status).toBe(3);
    expect(facts.payloads).toEqual([
      expect.objectContaining({
        version_no: 1,
        kind: 'part_time',
        mode: 'direct',
        form_id: 'part_time',
        selected_staff_id: w.cycle.id,
        is_record_snapshot: false,
      }),
    ]);
    expect(facts.events).toEqual([{ state: 'effective', event_no: 1 }]);
    expect(facts.timeline).toEqual([]);
    expect(await w.terms(result.id)).toEqual([
      { term_no: 1, end_date: '2026-12-31', source: 'create', source_id: null },
    ]);
    // 审计按兼职部门归属（§7.4）；不写 employment.record.create（P-04 资格同步入队）
    expect(facts.audit).toEqual([
      expect.objectContaining({
        action: 'employment.part_time.create',
        scope_org_id: w.partTimeOrg.id,
        scope_employee_id: w.employeeId,
      }),
    ]);
    expect(facts.outbox).toEqual([{ event_type: 'employment.part_time.create', employee_id: w.employeeId }]);
    expect(await w.primaryView()).toEqual(before);
  });

  it('可选字段照存；自定义字段、用工形式随记录保存，不从主职继承（A-15）', async () => {
    const w = await serviceWorld(database().db, 'pt-create-fields');
    const result = await w.create({ employmentForm: 'full_time', employmentType: 'normal' });
    const [row] = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ employment_form: string | null; employment_type: string | null; position_id: string | null }>(
        await tx.execute(sql`SELECT employment_form, employment_type, position_id FROM employment_records
          WHERE tenant_id=${w.tenantId} AND id=${result.id}`),
      ),
    );
    expect(row).toEqual({ employment_form: 'full_time', employment_type: 'normal', position_id: null });
  });
});

describe('createPartTime：日期与业务校验（D-1～D-10）', () => {
  it('PB-20：结束日早于开始日 → 400 VALIDATION_FAILED + PART_TIME_END_BEFORE_START，原文提示，无写入', async () => {
    const w = await serviceWorld(database().db, 'pt-end-before-start');
    const before = await w.writes();
    const error = await w.rejection({ startDate: '2026-09-10', endDate: '2026-09-09' });
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(w.reason(error)).toBe('PART_TIME_END_BEFORE_START');
    expect(error.message).toBe('结束日期不能早于开始日期');
    expect(await w.writes()).toEqual(before);
    // 结束日 = 开始日合法
    expect((await w.create({ startDate: '2026-09-10', endDate: '2026-09-10' })).endDate).toBe('2026-09-10');
  });

  it('PB-21：开始日早于所属周期入职日 → 400 PART_TIME_BEFORE_ENTRY；离职之后开始 → 409 PART_TIME_PRIMARY_NOT_ACTIVE', async () => {
    const w = await serviceWorld(database().db, 'pt-start-bounds');
    const early = await w.rejection({ startDate: '2024-12-31', endDate: null });
    expect(early.code).toBe('VALIDATION_FAILED');
    expect(w.reason(early)).toBe('PART_TIME_BEFORE_ENTRY');
    await w.leave('2026-09-15');
    const after = await w.rejection({ startDate: '2026-09-17', endDate: '2026-09-18' });
    expect(after.code).toBe('CONFLICT');
    expect(w.reason(after)).toBe('PART_TIME_PRIMARY_NOT_ACTIVE');
  });

  it('PB-23：兼职部门 10-20 起停用 → 无结束日 / 结束日 ≥ 10-20 被拒（EMPLOYMENT_DEPARTMENT_DISABLED），10-19 前成功', async () => {
    const w = await serviceWorld(database().db, 'pt-dept-disabled');
    const org = await w.org(`停用部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    expect((await w.disableOrg(org, '2026-10-20')).status).toBe(200);
    const before = await w.writes();
    const open = await w.rejection({ departmentId: org.id, startDate: '2026-10-01', endDate: null });
    expect(open.code).toBe('VALIDATION_FAILED');
    expect(w.reason(open)).toBe('EMPLOYMENT_DEPARTMENT_DISABLED');
    expect(w.reason(await w.rejection({ departmentId: org.id, startDate: '2026-10-01', endDate: '2026-10-20' }))).toBe(
      'EMPLOYMENT_DEPARTMENT_DISABLED',
    );
    expect(await w.writes()).toEqual(before);
    const bounded = await w.create({ departmentId: org.id, startDate: '2026-10-01', endDate: '2026-10-19' });
    expect(bounded.departmentId).toBe(org.id);
  });

  it('D-9：开始日早于部门设立日 → 400 ENTRY_BEFORE_DEPARTMENT_FOUNDED', async () => {
    const w = await serviceWorld(database().db, 'pt-before-founded');
    const late = await w.org(`晚设立部门${uniqueSuffix()}`, { establishedOn: '2026-09-20' });
    const error = await w.rejection({ departmentId: late.id, startDate: '2026-09-10', endDate: null });
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(w.reason(error)).toBe('ENTRY_BEFORE_DEPARTMENT_FOUNDED');
  });

  it('D-8：经理必须在开始日在职且不是本人；部门 / 职位 / 任职类型的引用须有效', async () => {
    const w = await serviceWorld(database().db, 'pt-references');
    const self = await w.rejection({ directManagerId: w.employeeId });
    expect(self.code).toBe('VALIDATION_FAILED');
    const stranger = await w.rejection({ dottedManagerId: '00000000-0000-4000-8000-000000000001' });
    expect(stranger.code).toBe('VALIDATION_FAILED');
    const nowhere = await w.rejection({ departmentId: '00000000-0000-4000-8000-000000000002' });
    expect(['VALIDATION_FAILED', 'NOT_FOUND']).toContain(nowhere.code);
    const primary = await w.rejection({ serviceType: 'primary' as never });
    expect(primary.code).toBe('VALIDATION_FAILED');
  });

  it('PT-7 起接受“是否部门负责人 / 新增下属”（§4.8）：联动人员不合格（本人）→ 400 整单拒绝，无写入；false / 空数组等同未给', async () => {
    const w = await serviceWorld(database().db, 'pt-linkage');
    const before = await w.writes();
    const error = await w.rejection({ addedSubordinateIds: [w.employeeId] });
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(w.reason(error)).toBe('TRANSFER_PERSON_NOT_ELIGIBLE');
    expect(await w.writes()).toEqual(before);
    expect((await w.create({ isDepartmentHead: false, addedSubordinateIds: [] })).id).toBeTruthy();
  });

  it('不存在的员工 → 404，无写入', async () => {
    const w = await serviceWorld(database().db, 'pt-no-employee');
    const before = await w.writes();
    const error = await w.rejection({ employeeId: '00000000-0000-4000-8000-0000000000aa' });
    expect(error.code).toBe('NOT_FOUND');
    expect(await w.writes()).toEqual(before);
  });
});

describe('createPartTime：自定义字段按定义校验并进审计（§1.1，DEC-019）', () => {
  it('合法值落库，并以 custom:<id> 同时出现在记录、载荷、审计 after / changes 与 outbox', async () => {
    const w = await serviceWorld(database().db, 'pt-custom-ok');
    const id = await w.customField('integer');
    const result = await w.create({ customFields: { [id]: 17 } });
    const facts = await withTenant(w.db, w.tenantId, async (tx) => {
      const one = async <T>(query: ReturnType<typeof sql>) => rowsOf<T>(await tx.execute(query));
      return {
        record: await one<{ custom_fields: unknown }>(sql`SELECT custom_fields FROM employment_records
          WHERE tenant_id=${w.tenantId} AND id=${result.id}`),
        payload: await one<{ custom_fields: unknown; explicit: string[] }>(sql`SELECT custom_fields,
          explicit_field_codes AS explicit FROM employment_payload_versions
          WHERE tenant_id=${w.tenantId} AND business_id=${result.id}`),
        audit: await one<{ after: Record<string, unknown>; changes: unknown }>(sql`SELECT after, changes
          FROM audit_events WHERE tenant_id=${w.tenantId} AND object_id=${result.id}
            AND action='employment.part_time.create'`),
        outbox: await one<{ payload: { after: Record<string, unknown> } }>(sql`SELECT payload FROM employment_outbox
          WHERE tenant_id=${w.tenantId} AND object_id=${result.id}::uuid AND event_type='employment.part_time.create'`),
      };
    });
    expect(facts.record[0]!.custom_fields).toEqual({ [id]: 17 });
    expect(facts.payload[0]!.custom_fields).toEqual({ [id]: 17 });
    expect(facts.payload[0]!.explicit).toContain(`custom:${id}`);
    expect(facts.audit).toHaveLength(1);
    expect(facts.audit[0]!.after[`custom:${id}`]).toBe(17);
    // 精确的一条变更：自定义字段从 null 变为 17（不是“字符串里包含字段编码”）
    expect(facts.audit[0]!.changes).toContainEqual({ field: `custom:${id}`, from: null, to: 17 });
    expect(facts.outbox).toHaveLength(1);
    expect(facts.outbox[0]!.payload.after[`custom:${id}`]).toBe(17);
  });

  it.each([
    ['整数字段传字符串', async (w: ServiceWorld) => ({ [await w.customField('integer')]: 'not-an-integer' })],
    ['未知字段', async () => ({ ['00000000-0000-4000-8000-0000000000bb']: 1 })],
    ['非任职对象（合同）字段', async (w: ServiceWorld) => ({ [await w.customField('text', 'contract')]: '合同备注' })],
  ] as const)(
    '%s → 400 VALIDATION_FAILED，业务头 / 载荷 / 记录 / 期限 / 审计 / outbox 都不新增',
    async (_name, build) => {
      const w = await serviceWorld(database().db, 'pt-custom-bad');
      const customFields = await build(w);
      const before = await w.writes();
      const error = await w.rejection({ customFields });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(await w.writes()).toEqual(before);
    },
  );
});

describe('writes() 写入指纹覆盖载荷 / 状态事件 / 申请表（PT-3a 审查 P3②）', () => {
  it('创建一条兼职后，载荷版本与状态事件的计数变化被指纹捕获；纯读取不改变指纹', async () => {
    const w = await serviceWorld(database().db, 'pt-writes-payload');
    const before = await w.writes();
    await w.create();
    const after = await w.writes();
    expect(after).toMatchObject({
      payloads: Number(before!.payloads) + 1,
      events: Number(before!.events) + 1,
      heads: Number(before!.heads) + 1,
      requests: before!.requests,
    });
    expect(await w.writes()).toEqual(after);
    // 只写载荷表（不动记录 / 期限 / 审计）也必须被指纹发现：旧指纹看不到这类写入
    await w.moveSnapshot(await w.seedPartTime({ endDate: null }), w.primaryOrg.id);
    expect((await w.writes())!.payloads).toBe(Number(after!.payloads) + 2);
  });
});
