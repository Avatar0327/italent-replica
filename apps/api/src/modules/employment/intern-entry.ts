/**
 * DEC-830①：实习转正的人只在转正日计一次入职。
 * 转正开新周期（DEC-797），实习周期开头那条入职记录的 entry_date 存在新周期的 trainee_start_date 上；
 * 期末（asOf）当天或之前已转正的，这条“实习开始”记录不再算入职 / 首次入职，由转正记录按转正日计。
 * 转正周期是追加保留数据：撤销（删除）转正后周期仍在、转正记录已离开时间轴，所以必须确认该周期的转正记录仍在时间轴上，
 * 否则删除后实习开始记录被误排除（入职漏计、首次入职日期为空）。
 * 未转正（含转正日在 asOf 之后的追溯视图、转正已撤销）和实习期满前就离职的人不受影响。
 */
import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';

/**
 * `rec` 是任职记录别名（要有 tenant_id / employee_id / kind / entry_date）。
 * 为真 = 这条记录可作为一次入职：转正记录要转正日已到（asOf 当天或之前），其余记录不能是已转正者的实习开始记录。
 */
export function countsAsEntryOnce(rec: string, asOf: string | SQL): SQL {
  const r = sql.raw(rec);
  return sql`(CASE WHEN ${r}.kind = 'intern_regularization' THEN ${r}.entry_date <= ${asOf}::date
    ELSE NOT EXISTS (SELECT 1 FROM employment_cycles k
      JOIN employment_records g ON g.tenant_id=k.tenant_id AND g.staff_id=k.id AND g.kind='intern_regularization'
      JOIN employment_timeline gt ON gt.tenant_id=g.tenant_id AND gt.record_id=g.id
      WHERE k.tenant_id=${r}.tenant_id AND k.employee_id=${r}.employee_id
        AND k.trainee_start_date=${r}.entry_date AND g.entry_date<=${asOf}::date) END)`;
}
