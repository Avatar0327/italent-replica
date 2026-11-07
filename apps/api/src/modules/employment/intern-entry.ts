/**
 * DEC-832①（取代 DEC-830①）：实习生只在【转正日】计一次入职，实习开始日永远不算入职。
 * - 实习开始那条入职记录 = 入职类记录（hire / rehire / retire_rehire）所在周期的 employ_type = 'intern'
 *   （employment_cycles.employ_type，周期只在入职类业务上设置，转正开出的新周期是 internal）；这条记录一律不计，
 *   不管后来有没有转正：未转正的在职实习生、实习期内没转正就离职的，始终不计入职 / 首次入职日期为空。
 * - 转正记录（intern_regularization）仍在有效时间轴上、转正日 <= asOf 时才计，按转正日一次；
 *   追溯查询时期末早于转正日同样不计；转正被删除（撤销）后转正记录离开时间轴，这个人回到未转正状态。
 * - 非实习的正常入职、转正后离职再入职（新入职记录，周期不是实习）保持原口径。
 * 看板入职（entriesFrom）、人员流动流入（hires 同源）、档案首次入职日期（employeeJoins）共用本片段。
 */
import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';

/**
 * `rec` 是任职记录别名（要有 tenant_id / kind / staff_id / entry_date），且已 JOIN 任职时间轴（只认现存记录）。
 * 为真 = 这条记录可作为一次入职。
 */
export function countsAsEntryOnce(rec: string, asOf: string | SQL): SQL {
  const r = sql.raw(rec);
  return sql`(CASE WHEN ${r}.kind = 'intern_regularization' THEN ${r}.entry_date <= ${asOf}::date
    ELSE NOT EXISTS (SELECT 1 FROM employment_cycles k
      WHERE k.tenant_id=${r}.tenant_id AND k.id=${r}.staff_id AND k.employ_type='intern') END)`;
}
