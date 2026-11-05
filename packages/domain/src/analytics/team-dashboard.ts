/**
 * 团队人事看板（部门负责人 / 直线经理，docs/02_业务建模/35 §2.1b、AC-HA-06，DEC-763③）：
 * 与 2.1 人事看板是两张不同的看板。指标口径与人员结构分析（B49）同一套，只取三项，编号沿用 B49 的规格编号，
 * 这样同一个人在两张看板上的数字出自同一段代码（apps/api analytics/hr-structure-board.ts）。
 * 本看板没有独立授权对象：谁能看由接口按调用者的负责部门 + 汇报关系算范围，不走授权项（DEC-415 的例外）。
 */
import { HR_STRUCTURE_COMPONENTS } from './hr-structure.js';

/** 6.01 在职人数（正式员工）、6.03 平均司龄、6.08 司龄分布（6 个月以下 / 半年至 1 年 / … / 10 年以上）。 */
export const TEAM_DASHBOARD_CODES = ['6.01', '6.03', '6.08'] as const;
export type TeamDashboardCode = (typeof TEAM_DASHBOARD_CODES)[number];

export const TEAM_DASHBOARD_COMPONENTS = HR_STRUCTURE_COMPONENTS.filter((item) =>
  (TEAM_DASHBOARD_CODES as readonly string[]).includes(item.code),
);
