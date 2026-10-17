/**
 * 按证件号的重聘判定（R2 BE-6a；差距表 B38、A48；31 IN-R1；R2f B41）。原站可按证件、手机、邮箱匹配，三键优先级与唯一性
 * 未验证，保守口径：只按“证件类型 + 证件号码”在租户内精确匹配已离职 / 退休人员，多人命中拒绝、不自动挑选；只判定不入职。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { rowsOf } from './read-model.js';

export const rehireMatchInput = z.strictObject({
  idType: z.string().trim().min(1).max(100),
  idNumber: z.string().trim().min(1).max(100),
});
export type RehireMatchInput = z.infer<typeof rehireMatchInput>;

export interface RehireCandidate {
  readonly employeeId: string;
  readonly name: string;
  readonly code: string;
  /** 个人邮箱（人员信息 email）。 */
  readonly email: string | null;
  readonly endKind: 'leave' | 'retirement';
  readonly lastWorkDate: string | null;
  /** 离职 / 退休那条任职的部门。 */
  readonly departmentId: string | null;
  /** 表单“重聘”默认否（R2f B41）。 */
  readonly rehire: false;
}

/**
 * 当前人员信息（personnel 版本链最新一版）匹配、且租户今天有效的任职（今天及以前最后一条）是离职 / 退休。
 * 先限定今天再取最后一条：未来的重聘待入职不挡当前已离职（PR #386 第 1 轮 P2-2）；在职、未来才离职的人不算。
 * where 是对 e（人员）与 v（人员信息最新版）的匹配条件，由两个入口各自给出。
 */
async function endedPeople(tx: Tx, tenantId: string, where: SQL, today: string, limit: number) {
  return rowsOf<Omit<RehireCandidate, 'rehire'>>(
    await tx.execute(sql`
    SELECT e.id AS "employeeId", COALESCE(v.name, e.name) AS name, e.code, v.email,
      r.kind AS "endKind", r.last_work_date::text AS "lastWorkDate",
      COALESCE(snap.department_id, r.department_id) AS "departmentId"
    FROM employment_employees e
    JOIN LATERAL (SELECT v.name, v.email, v.id_type, v.id_number, v.mobile_phone FROM personnel_employee_versions v
      WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id ORDER BY v.revision DESC LIMIT 1) v ON true
    JOIN LATERAL (SELECT t.record_id FROM employment_timeline t
      WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.start_date<=${today}::date
      ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) current ON true
    JOIN employment_records r ON r.tenant_id=e.tenant_id AND r.id=current.record_id
    LEFT JOIN LATERAL (SELECT p.department_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    WHERE e.tenant_id=${tenantId} AND (${where}) AND r.kind IN ('leave','retirement')
    ORDER BY e.id LIMIT ${limit}
  `),
  );
}

export async function matchRehire(
  tx: Tx,
  tenantId: string,
  input: RehireMatchInput,
  today: string,
): Promise<RehireCandidate | null> {
  const rows = await endedPeople(
    tx,
    tenantId,
    sql`v.id_type=${input.idType} AND btrim(v.id_number)=${input.idNumber}`,
    today,
    2,
  );
  if (rows.length > 1)
    throw new AppError('CONFLICT', '该证件号码匹配到多名离职人员，请核对后处理', { reason: 'REHIRE_MATCH_AMBIGUOUS' });
  return rows[0] ? { ...rows[0], rehire: false } : null;
}

export interface RehireKeys {
  readonly idType?: string | null | undefined;
  readonly idNumber?: string | null | undefined;
  readonly mobilePhone?: string | null | undefined;
  readonly email?: string | null | undefined;
}

/** Offer 新建时的重聘提示（34 OF-R2）：证件（类型 + 号码）、手机号、邮箱任一命中，邮箱不分大小写；不判歧义，调用方按权限裁剪后再数。 */
export async function findRehireCandidates(tx: Tx, tenantId: string, keys: RehireKeys, today: string) {
  const blank = (value: string | null | undefined) => value?.trim() || null;
  const [idType, idNumber, mobile, email] = [keys.idType, keys.idNumber, keys.mobilePhone, keys.email].map(blank);
  const conditions: SQL[] = [];
  if (idType && idNumber) conditions.push(sql`(v.id_type=${idType} AND btrim(v.id_number)=${idNumber})`);
  if (mobile) conditions.push(sql`btrim(v.mobile_phone)=${mobile}`);
  if (email) conditions.push(sql`lower(btrim(v.email))=${email.toLowerCase()}`);
  if (!conditions.length) return [];
  return endedPeople(tx, tenantId, sql.join(conditions, sql` OR `), today, 50);
}
