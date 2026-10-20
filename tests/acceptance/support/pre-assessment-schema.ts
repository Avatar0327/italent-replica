/**
 * 升级测试夹具（R2-T03 B3-3）：离职开闸后，旧结构上用当前接口造的离职会当场生效 / 先查在途考核，而考核表在迁移
 * be15b1_probation_assessment 才建。在更早的结构上临时建一张同名空表（含各查询读到的列，不含约束），前置步骤跑完即撤掉，
 * 再由测试执行升级迁移按正式结构重建——同 pre-blacklist-schema、pre-part-time-schema 先例。生产总是先迁移再服务，
 * 生产代码不判断表是否存在（DEC-402）。已有该表（已升级）的库不动。
 * R2 BE-5d2 起同法补意向退休申请表 retirement_intentions（任职命令的足迹复核 currentTargets 读它，迁移 be5d2_retirement_intention 才建）。
 */
import { type Db, sql } from '@italent/db';

const present = async (db: Db, table: string) => {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { present: boolean }[];
  return rows[0]?.present === true;
};

/** 补出临时表并返回撤掉它们的函数；表已存在时不动。必须在升级迁移之前调用返回的函数。 */
export async function addPreAssessmentTable(db: Db): Promise<() => Promise<void>> {
  const added: string[] = [];
  if (!(await present(db, 'employment_probation_assessments'))) {
    await db.execute(sql`CREATE TABLE employment_probation_assessments (id uuid NOT NULL, tenant_id uuid NOT NULL,
      employee_id uuid NOT NULL, anchor_id uuid NOT NULL, department_id uuid, assessment_type text NOT NULL,
      assessment_name text NOT NULL, assessment_date date NOT NULL, self_evaluation text, manager_rating text,
      regularization_opinion text, regularization_date date, status text NOT NULL, initiation text NOT NULL,
      initiator_user_id uuid NOT NULL, regularization_business_id uuid, revision integer NOT NULL)`);
    await db.execute(sql`GRANT SELECT ON employment_probation_assessments TO app_user`);
    added.push('employment_probation_assessments');
  }
  if (!(await present(db, 'retirement_intentions'))) {
    await db.execute(sql`CREATE TABLE retirement_intentions (id uuid NOT NULL, tenant_id uuid NOT NULL,
      employee_id uuid NOT NULL, department_id uuid, initiator_user_id uuid NOT NULL)`);
    await db.execute(sql`GRANT SELECT ON retirement_intentions TO app_user`);
    added.push('retirement_intentions');
  }
  return async () => {
    for (const table of added) await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(table)}`);
  };
}

export async function withPreAssessmentSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreAssessmentTable(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
