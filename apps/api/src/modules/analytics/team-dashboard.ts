/**
 * 团队人事看板的范围（docs/02_业务建模/35 §2.1b、AC-HA-06，DEC-763③）：
 * 本人 + 本人负责部门（含下级部门，asOf 当天的行政维度）里的在职人员 + 经主职直线经理一路往下的汇报链（含隔级）。
 * 不含虚线下属，离职人员不在在职行集里。范围只由“调用者是谁”算出，与角色的数据范围（管理单元 / 看全部）无关——
 * 人事管理员兼部门负责人时团队看板也不会被角色范围放大（原站 A2：报表 311 人、团队看板 8 人）。
 * 看板数字与钻取明细都从同一个谓词取行（hr-structure.ts structurePeopleWhere），所以数字 = 明细。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';

export interface TeamViewer {
  readonly tenantId: string;
  readonly userId: string;
  readonly asOf: string;
}
export interface TeamVisibility {
  /** 候选行（别名 m，带 employee_id / org_id）的可见谓词。 */
  readonly visible: SQL;
  /** 调用者没有绑定人员档案时为 false：范围为空，全部为 0，不退回“全部”（硬规则 1）。 */
  readonly hasDataPermission: boolean;
}

/** 红灯阶段的占位：先返回全租户，AC-HA-06 的范围断言应因此失败；绿灯提交换成真实范围。 */
export async function teamVisibility(_tx: Tx, _viewer: TeamViewer): Promise<TeamVisibility> {
  return { visible: sql`true`, hasDataPermission: true };
}
