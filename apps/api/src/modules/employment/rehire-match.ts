/**
 * 新增实习生 / 再入职时按证件号的重聘判定（R2 BE-6a；差距表 B38、A48 判定部分；31 IN-R1；R2f B41“再入职入口”）。
 * 原站提示“输入证件类型+证件号码、手机号码、电子邮件，可快速匹配出再入职人员”，三个键的优先级、唯一性未验证；
 * 保守口径：只按“证件类型 + 证件号码”在租户内精确匹配（去首尾空格）当前已离职 / 退休的人员；多人命中明确拒绝，
 * 不自动挑选；手机 / 邮箱匹配与复聘次数未验证、本单不做。只判定，不建档、不入职（重聘入职走已有 kind=rehire）。
 */
import { sql, type Tx } from '@italent/db';
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
  /** 结束类型：离职 / 退休。 */
  readonly endKind: 'leave' | 'retirement';
  readonly lastWorkDate: string | null;
  /** 结束时所在部门（离职 / 退休那条任职的部门）。 */
  readonly departmentId: string | null;
  /** 表单“重聘”默认否（R2f B41）。 */
  readonly rehire: false;
}

/**
 * 当前人员信息（personnel 版本链最新一版）证件匹配、且任职时间轴最后一条是租户今天及以前生效的离职 / 退休。
 * 在职、未来才离职的人不算；取两条判断是否唯一。
 */
export async function matchRehire(
  tx: Tx,
  tenantId: string,
  input: RehireMatchInput,
  today: string,
): Promise<RehireCandidate | null> {
  const rows = rowsOf<Omit<RehireCandidate, 'rehire'>>(
    await tx.execute(sql`
    SELECT e.id AS "employeeId", COALESCE(v.name, e.name) AS name, e.code, v.email,
      r.kind AS "endKind", r.last_work_date::text AS "lastWorkDate",
      COALESCE(snap.department_id, r.department_id) AS "departmentId"
    FROM employment_employees e
    JOIN LATERAL (SELECT v.name, v.email, v.id_type, v.id_number FROM personnel_employee_versions v
      WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id ORDER BY v.revision DESC LIMIT 1) v ON true
    JOIN LATERAL (SELECT t.record_id, t.start_date FROM employment_timeline t
      WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id
      ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) last ON true
    JOIN employment_records r ON r.tenant_id=e.tenant_id AND r.id=last.record_id
    LEFT JOIN LATERAL (SELECT p.department_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    WHERE e.tenant_id=${tenantId} AND v.id_type=${input.idType} AND btrim(v.id_number)=${input.idNumber}
      AND r.kind IN ('leave','retirement') AND last.start_date<=${today}::date
    ORDER BY e.id LIMIT 2
  `),
  );
  if (rows.length > 1)
    throw new AppError('CONFLICT', '该证件号码匹配到多名离职人员，请核对后处理', { reason: 'REHIRE_MATCH_AMBIGUOUS' });
  return rows[0] ? { ...rows[0], rehire: false } : null;
}
