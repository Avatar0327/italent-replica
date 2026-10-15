/**
 * F-140a（DEC-499，设计 docs/08_设计/F-140_离职调动人工改期设计.md §2）：人工计划生效日与系统实际执行日分字段存储，
 * 计划日只按业务内单调的 version_no 读取（约束 1 / 2），不再从 outbox 改期事件按 (created_at, id) 推断。
 * 离职改期命令本身依赖 R2-T03 B1a～B4（main 尚未实现），其端到端反例见设计 §5，随 F-140b 落地。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { resolvePlannedEffectiveDate, type PlanVersion } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { plannedEffectiveDate } from '../../apps/api/src/modules/employment/timeline.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();

interface StoredVersion {
  versionNo: number;
  effectiveDate: string;
  plannedEffectiveDate: string;
  derived: boolean;
}

async function storedVersions(w: ActivationWorld, businessId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    resultRows<StoredVersion>(
      await tx.execute(sql`SELECT version_no AS "versionNo", effective_date::text AS "effectiveDate",
          planned_effective_date::text AS "plannedEffectiveDate", trigger_business_id IS NOT NULL AS derived
        FROM employment_payload_versions WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid
        ORDER BY version_no`),
    ),
  );
}

async function plannedOf(tx: Tx, tenantId: string, businessId: string) {
  const [row] = resultRows<{ planned: string }>(
    await tx.execute(
      sql`SELECT ${plannedEffectiveDate(tenantId, sql`${businessId}::uuid`, sql`'1900-01-01'::date`)}::text AS planned`,
    ),
  );
  return row!.planned;
}

/** 调动 T 计划 10-20，10-06 批准，调度停到 11-01 迟到落地（系统顺延到 11-01）。 */
async function lateTransfer(label: string) {
  const w = await activationWorld(database().db, label);
  const person = await w.hired();
  const transfer = await w.apply(person.employee.id, '2026-10-20', { departmentId: w.to.id });
  await w.approve(transfer, '2026-10-06T01:00:00Z');
  expect(await w.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect((await w.business(transfer.id)).activation).toMatchObject({ status: 'effective' });
  return { w, person, transfer };
}

describe('F-140 约束 2：人工计划与系统顺延分字段', () => {
  it('迟到顺延只写实际执行日；人工计划字段保持原计划，计划日函数读它', async () => {
    const { w, transfer } = await lateTransfer('f140-split');
    const versions = await storedVersions(w, transfer.id);
    const last = versions.at(-1)!;
    expect(last).toMatchObject({ effectiveDate: '2026-11-01', plannedEffectiveDate: '2026-10-20', derived: true });
    for (const version of versions.filter((item) => !item.derived))
      expect(version.plannedEffectiveDate).toBe(version.effectiveDate);
    expect(await withTenant(w.db, w.session.tenant.id, (tx) => plannedOf(tx, w.session.tenant.id, transfer.id))).toBe(
      '2026-10-20',
    );
  });

  it('数据库护栏：计划列一律由触发器推导，系统派生版本即使显式传入实际日期也沿用人工计划', async () => {
    const { w, transfer } = await lateTransfer('f140-guard');
    const tenantId = w.session.tenant.id;
    const append = (planned: string | null) =>
      withTenant(w.db, tenantId, (tx) =>
        tx.execute(sql`
        INSERT INTO employment_payload_versions
          (id,tenant_id,employee_id,business_id,version_no,previous_version_id,command_id,trigger_business_id,
           is_record_snapshot,kind,mode,effective_date,planned_effective_date,form_id,employ_type)
        SELECT gen_random_uuid(),tenant_id,employee_id,business_id,version_no+1,id,'f140-raw',business_id,true,
          kind,mode,'2026-11-03'::date,${planned}::date,form_id,employ_type
        FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${transfer.id}::uuid
        ORDER BY version_no DESC LIMIT 1`),
      );
    for (const planned of ['2026-11-03', null]) {
      await append(planned);
      expect((await storedVersions(w, transfer.id)).at(-1), String(planned)).toMatchObject({
        effectiveDate: '2026-11-03',
        plannedEffectiveDate: '2026-10-20',
        derived: true,
      });
    }
  });
});

describe('F-140 约束 1：计划日只按版本序号读取', () => {
  it('伪造一条与真实改期事件同一 created_at、UUID 更小的改期事件，计划日不变（#100 第 7 轮根因）', async () => {
    const { w, person, transfer } = await lateTransfer('f140-uuid');
    const tenantId = w.session.tenant.id;
    await withTenant(w.db, tenantId, async (tx) => {
      const [real] = resultRows<{ createdAt: string }>(
        await tx.execute(sql`SELECT created_at::text AS "createdAt" FROM employment_outbox
          WHERE tenant_id=${tenantId} AND business_id=${transfer.id}::uuid
            AND event_type='employment.transfer.rescheduled'`),
      );
      expect(real).toBeDefined();
      await tx.execute(sql`
        INSERT INTO employment_outbox(id,tenant_id,employee_id,business_id,event_type,object_type,object_id,command_id,
          payload,created_at)
        VALUES ('00000000-0000-4000-8000-000000000000',${tenantId},${person.employee.id}::uuid,${transfer.id}::uuid,
          'employment.transfer.rescheduled','employment-business',${transfer.id}::uuid,'f140-forged',
          ${JSON.stringify({ after: { originalEffectiveDate: '2026-11-01', effectiveDate: '2026-11-01' } })}::jsonb,
          ${real!.createdAt}::timestamptz)`);
      expect(await plannedOf(tx, tenantId, transfer.id)).toBe('2026-10-20');
    });
  });

  it('SQL 计划日 ≡ 纯函数：命名反例与随机版本序列，全部版本同一 created_at', async () => {
    const w = await activationWorld(database().db, 'f140-equivalence');
    const person = await w.hired();
    const tenantId = w.session.tenant.id;
    const named: Record<string, PlanVersion[]> = {
      '第 7 轮自构①：人工 11-10 → 10-20，同事务顺延 11-01': [
        m(1, '2026-11-10'),
        m(2, '2026-10-20'),
        d(3, '2026-11-01'),
      ],
      '第 6 轮原反例：人工 10-16 → 10-30': [m(1, '2026-10-16'), m(2, '2026-10-30')],
      '两次改期：10-16 → 10-30 → 10-25': [m(1, '2026-10-16'), m(2, '2026-10-30'), m(3, '2026-10-25')],
      '多次顺延 + 落地后快照': [m(1, '2026-10-20'), d(2, '2026-11-01'), d(3, '2026-11-02'), d(4, '2026-11-02')],
    };
    const random = seeded(140);
    const generated = Array.from(
      { length: 24 },
      (_unused, index) => [`随机 ${index}`, randomVersions(random)] as const,
    );
    await withTenant(w.db, tenantId, async (tx) => {
      for (const [name, versions] of [...Object.entries(named), ...generated]) {
        const businessId = await syntheticBusiness(tx, tenantId, person.employee.id, versions);
        expect(await plannedOf(tx, tenantId, businessId), name).toBe(
          resolvePlannedEffectiveDate({ versions, fallback: '1900-01-01' }),
        );
      }
    });
  });
});

describe('F-140 约束 5（调动同构）：同日已完成的迟到调动', () => {
  // 第 7 轮自构②：计划日决定同日插入位置；关闭自动带出时未填字段在落地时按前驱继承，继承来源随位置改变。
  it.each([
    ['T 计划 10-25：后到的 10-20 计划插在 T 之前，前驱与继承来源为入职', '2026-10-25', 'before'],
    ['T 计划 10-15：后到的 10-20 计划插在 T 之后，前驱与继承来源为 T', '2026-10-15', 'after'],
  ] as const)('%s', async (_name, plannedT, side) => {
    const w = await activationWorld(database().db, `f140-sameday${plannedT}`);
    const person = await w.hired();
    const third = await w.session.org('第三部门', { establishedOn: '2026-01-01' });
    const settings = await w.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: true, autoPopulate: false },
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    const t = await w.apply(person.employee.id, plannedT, { departmentId: w.to.id, place: 'T地点' });
    await w.approve(t, '2026-10-06T01:00:00Z');
    expect(await w.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    w.session.setNow('2026-11-01T03:00:00.000Z');
    const late = await w.apply(person.employee.id, '2026-10-20', { departmentId: third.id });
    expect((await w.approve(late, '2026-11-01T04:00:00Z')).status).toBe('effective');
    const order = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      resultRows<{ recordId: string }>(
        await tx.execute(sql`SELECT record_id AS "recordId" FROM employment_timeline
          WHERE tenant_id=${w.session.tenant.id} AND employee_id=${person.employee.id}::uuid
            AND start_date='2026-11-01' ORDER BY sort_order`),
      ).map((row) => row.recordId),
    );
    expect(order).toEqual(side === 'before' ? [late.id, t.id] : [t.id, late.id]);
    const landed = await w.session.record(late.id, '2026-11-01');
    expect(landed.fields).toMatchObject({
      departmentId: third.id,
      place: side === 'before' ? '原地点' : 'T地点',
    });
  });
});

function m(versionNo: number, effectiveDate: string): PlanVersion {
  return { versionNo, effectiveDate, manual: true };
}

function d(versionNo: number, effectiveDate: string): PlanVersion {
  return { versionNo, effectiveDate, manual: false };
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function randomVersions(random: () => number): PlanVersion[] {
  const length = 1 + Math.floor(random() * 6);
  return Array.from({ length }, (_unused, index) => {
    const day = String(1 + Math.floor(random() * 28)).padStart(2, '0');
    return { versionNo: index + 1, effectiveDate: `2026-10-${day}`, manual: index === 0 || random() < 0.4 };
  });
}

/** 新建一个业务头并按给定序列追加载荷版本（复制入职首版的必填列），全部版本共用同一 created_at。 */
async function syntheticBusiness(tx: Tx, tenantId: string, employeeId: string, versions: readonly PlanVersion[]) {
  const businessId = randomUUID();
  await tx.execute(sql`INSERT INTO employment_business_objects(id,tenant_id,employee_id)
    VALUES (${businessId}::uuid,${tenantId},${employeeId}::uuid)`);
  let previous: string | null = null;
  for (const version of versions) {
    const id = randomUUID();
    const trigger = version.manual ? null : businessId;
    await tx.execute(sql`
      INSERT INTO employment_payload_versions
        (id,tenant_id,employee_id,business_id,version_no,previous_version_id,command_id,trigger_business_id,
         kind,mode,effective_date,form_id,employ_type,created_at)
      SELECT ${id}::uuid,tenant_id,employee_id,${businessId}::uuid,${version.versionNo},${previous}::uuid,
        ${trigger === null ? null : 'f140-derived'},${trigger}::uuid,'transfer','application',
        ${version.effectiveDate}::date,form_id,employ_type,'2026-11-01T01:00:00Z'::timestamptz
      FROM employment_payload_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
      ORDER BY version_no LIMIT 1`);
    previous = id;
  }
  return businessId;
}
