/**
 * R3-T05 A1（继任记录读侧）验收夹具：同一租户里的组织、关键职位、真实任职（经组织 / 职务 / 任职接口建数据，
 * 与 AC-ORG-people-support 同一装配），继任记录与目标锁用 SQL 直接落库（A1 没有写接口，写侧在 A2）。
 * 日期固定为 2026-10-01（租户时区 Asia/Shanghai）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import {
  type HiredEmployee,
  type JobObject,
  type Organization,
  orgPeopleWorld,
  resultRows,
  TODAY,
} from './AC-ORG-people-support.js';
import { loginEmailOf } from './AC-EMP-support.js';

export const SC_TODAY = TODAY;
export const SC_BASE = '/api/tenant/succession';
export const OPEN_END = '9999-12-31';
export const SC_NOW = new Date(`${TODAY}T01:00:00.000Z`);

export interface RecordSeed {
  readonly type: 'org' | 'position';
  readonly targetId: string;
  readonly successorId: string;
  readonly readinessId?: string | null;
  readonly backupType?: 'principal' | 'deputy';
  readonly startDate?: string;
  readonly endDate?: string;
  readonly endReason?: string | null;
  readonly endSource?: string | null;
  readonly sourceKind?: 'manual' | 'review_sync';
  readonly deleted?: boolean;
}

export interface ReadinessSeed {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly color: string;
}

export interface RecordView {
  readonly id: string;
  readonly revision: number;
  readonly successionType: 'org' | 'position';
  readonly targetOrgId: string | null;
  readonly targetPositionId: string | null;
  readonly successorEmployeeId: string;
  readonly readinessId: string | null;
  readonly backupType: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly endReason: string | null;
  readonly endSource: string | null;
  readonly sourceKind: string;
  readonly status: 'active' | 'ended';
  readonly successor?: { employeeId: string; name: string; email: string | null; label: string };
  readonly targetOrg?: { id: string; name: string };
  readonly targetPosition?: { id: string; name: string; orgId: string | null };
  readonly readiness?: { id: string; code: string; name: string; color: string } | null;
  readonly personInCharge?: { employeeId: string; name: string; email: string | null; label: string } | null;
  readonly incumbents?: { employeeId: string; name: string; email: string | null; label: string }[];
  readonly [key: string]: unknown;
}

export interface RecordList {
  readonly items: RecordView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly asOf: string;
  readonly hasDataPermission: boolean;
}

/** 合成员工的“姓名(邮箱)”展示：登录邮箱由入职时自动开户，规则同人员信息的邮箱兜底（survey360/sync.ts）。 */
export const labelOf = (employee: HiredEmployee) => `${employee.name}(${loginEmailOf(employee.id)})`;

export async function successionWorld(db: Db, label: string) {
  const world = await orgPeopleWorld(db, label);
  const post = await world.job('posts', '继任职务');
  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[2]) => withTenant(db, world.tenant.id, run);

  const position = (orgId: string, name: string, extra: Record<string, unknown> = {}) =>
    world.job('positions', name, { orgId, postId: post.id, isKey: true, ...extra });

  /** 把员工设为组织负责人（PATCH 追加同日版本）。 */
  async function setHead(org: Organization, employee: HiredEmployee) {
    const response = await world.patchOrg(org, { personInChargeId: employee.id, effectiveDate: TODAY });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function readiness(name: string, extra: Record<string, unknown> = {}): Promise<ReadinessSeed> {
    const code = `RN${randomUUID().slice(0, 6)}`;
    const response = await world.call('POST', 'talent-review/readiness-levels', {
      ifMatch: 0,
      body: { code, name, color: '#3366FF', ...extra },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ReadinessSeed;
  }

  async function insertRecord(seed: RecordSeed): Promise<string> {
    const id = randomUUID();
    const { type } = seed;
    await asTenant(async (tx) => {
      await tx.execute(sql`
        INSERT INTO succession_records (id, tenant_id, succession_type, target_org_id, target_position_id,
          successor_employee_id, readiness_id, backup_type, start_date, end_date, end_reason, end_source, source_kind,
          deleted_at, created_by, updated_by)
        VALUES (${id}::uuid, ${world.tenant.id}::uuid, ${type},
          ${type === 'org' ? seed.targetId : null}::uuid, ${type === 'position' ? seed.targetId : null}::uuid,
          ${seed.successorId}::uuid, ${seed.readinessId ?? null}::uuid, ${seed.backupType ?? 'principal'},
          ${seed.startDate ?? '2026-09-01'}::date, ${seed.endDate ?? OPEN_END}::date, ${seed.endReason ?? null},
          ${seed.endSource ?? null}, ${seed.sourceKind ?? 'manual'},
          ${seed.deleted ? sql`now()` : null}, ${world.user.id}::uuid, ${world.user.id}::uuid)`);
    });
    return id;
  }

  async function userOf(employee: HiredEmployee): Promise<string> {
    return asTenant(async (tx) => {
      const rows = resultRows<{ user_id: string }>(
        await tx.execute(
          sql`SELECT user_id FROM permission_user_person_links WHERE employee_id = ${employee.id}::uuid`,
        ),
      );
      expect(rows).toHaveLength(1);
      return rows[0]!.user_id;
    });
  }

  const request = (method: string, path: string, options: Parameters<typeof world.call>[2] = {}) =>
    world.call(method, `succession${path}`, options);

  async function list(query = ''): Promise<RecordList> {
    const response = await request('GET', `/records${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as RecordList;
  }

  /** 一套标准数据：组织 A（负责人 head）、其下关键职位 P（现任 incumbent）、两名继任者。 */
  async function standard() {
    const orgA = await world.org('继任A部');
    const orgB = await world.org('继任B部');
    const keyPosition = await position(orgA.id, '关键岗位P');
    const head = await world.hire('负责人甲', { departmentId: orgB.id });
    await setHead(orgA, head);
    const incumbent = await world.hire('现任乙', { departmentId: orgA.id, positionId: keyPosition.id });
    const successor1 = await world.hire('继任丙', { departmentId: orgB.id });
    const successor2 = await world.hire('继任丁', { departmentId: orgB.id });
    return { orgA, orgB, keyPosition, head, incumbent, successor1, successor2 };
  }

  return { ...world, db, post, position, setHead, readiness, insertRecord, userOf, request, list, standard, asTenant };
}

export type SuccessionWorld = Awaited<ReturnType<typeof successionWorld>>;
export type { HiredEmployee, JobObject, Organization };
