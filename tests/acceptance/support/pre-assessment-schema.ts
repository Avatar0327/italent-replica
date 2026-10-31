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
  // F-261：旧结构夹具仍经当前离职入口。临时任务表仅支持造旧实例，升级前撤掉；生产不做缺表兜底。
  if (!(await present(db, 'exit_requests'))) {
    // 当前提交入口会用 Drizzle 读完整扩展行；旧实例没有扩展数据，列齐全但始终保持空表。
    await db.execute(sql`CREATE TABLE exit_requests (tenant_id uuid, business_id uuid, supersedes_business_id uuid,
      employee_id uuid, staff_id uuid, mode text, initiator text, initiator_user_id uuid, attachment_refs jsonb,
      process_code text, exit_type_code text, reason_code text, whereabouts_code text, handover_employee_id uuid,
      add_to_blacklist boolean, blacklist_expiry_date date, blacklist_reason text, blacklist_note text,
      compensation_amount numeric(14,2), non_compete_amount numeric(14,2), last_pay_date date,
      social_insurance_end_month text, annual_leave_settled boolean, tax_period text, tax_year integer,
      employer_name text, actual_leave_date date, pending_transfer_ack jsonb, batch_id uuid,
      duty_transfer_timing text, pre_release_date date, created_at timestamptz)`);
    await db.execute(sql`GRANT SELECT ON exit_requests TO app_user`);
    added.push('exit_requests');
  }
  if (!(await present(db, 'exit_account_settings'))) {
    await db.execute(sql`CREATE TABLE exit_account_settings (tenant_id uuid PRIMARY KEY,
      early_enabled boolean NOT NULL DEFAULT false, basis text, time text,
      in_review boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0)`);
    await db.execute(sql`GRANT SELECT, INSERT, UPDATE ON exit_account_settings TO app_user`);
    added.push('exit_account_settings');
  }
  if (!(await present(db, 'exit_account_tasks'))) {
    await db.execute(sql`CREATE TABLE exit_account_tasks (tenant_id uuid NOT NULL, business_id uuid NOT NULL,
      employee_id uuid NOT NULL, user_id uuid NOT NULL, handler_user_id uuid,
      status text NOT NULL DEFAULT 'pending', reason text, attempts integer NOT NULL DEFAULT 0,
      revision integer NOT NULL DEFAULT 1, command_id text NOT NULL, restore_requested boolean NOT NULL DEFAULT false,
      auto_revision integer, recipient_user_ids uuid[] NOT NULL DEFAULT '{}', PRIMARY KEY(tenant_id,business_id))`);
    await db.execute(sql`GRANT SELECT, INSERT, UPDATE ON exit_account_tasks TO app_user`);
    added.push('exit_account_tasks');
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
