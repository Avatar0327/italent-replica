/**
 * 职责转交菜单（R2-T09a，DEC-602② / DEC-726 / F-408；规格 `30` §补充“职责转交记录结构”“菜单指定日期转交实测”）。
 * 记录结构照原站 DutyTransferCommon：状态 未完成 0 / 已完成 1 / 作废 2 / 草稿 3（无单独“待生效”状态，
 * 指定日期到期前 = 未完成 + 转交时间空 + 带转交日期）；数据来源 菜单 1 / 离职 2 / 调动 3 / 退休 4。
 */

export const DUTY_TRANSFER_OBJECT = 'TenantBase.DutyTransferCommon';
/** 菜单“设置接收人”按钮；原站按钮编码未取证（结果文件未决），按列表级、需新建权登记。 */
export const DUTY_TRANSFER_SET_RECEIVER_BUTTON = 'SetDutyTransferReceiver';

export const DUTY_TRANSFER_STATUS = { unfinished: 0, completed: 1, voided: 2, draft: 3 } as const;
export const DUTY_TRANSFER_SOURCE = { menu: 1, leave: 2, transfer: 3, retirement: 4 } as const;
export const DUTY_TYPE = { orgRole: 1, subordinate: 2 } as const;

/** 职责转交记录的字段（字段权限与审计标签同一份编码）。 */
export const DUTY_TRANSFER_FIELDS = [
  'employeeId',
  'receiverId',
  'dutyType',
  'dutyDetails',
  'status',
  'transferDate',
  'transferTime',
  'batchId',
  'source',
  'operatorId',
] as const;

/** 检查离职退休人员：最近 3 个月（DEC-726）。 */
export const DEPARTED_LOOKBACK_MONTHS = 3;

const ROLE_LABELS: Readonly<Record<string, string>> = { person_in_charge: '负责人', shop_owner: '店长', hrbp: 'HRBP' };
const RELATION_LABELS: Readonly<Record<string, string>> = { direct: '直线', dotted: '虚线' };

/** 职责描述：组织角色“<组织名> 负责人”，下属“<姓名>（直线下属）”。原站描述原文未取证，按此口径。 */
export function dutyDescription(
  duty: { readonly orgRole?: string | null; readonly relation?: string | null },
  name: string,
): string {
  if (duty.orgRole) return `${name} ${ROLE_LABELS[duty.orgRole] ?? duty.orgRole}`;
  return `${name}（${RELATION_LABELS[duty.relation ?? ''] ?? duty.relation}下属）`;
}

/** 被转交人提示：全部职责都已设接收人且同一转交日期时显示（规格 `30` 菜单指定日期实测）。 */
export function dutyPendingHint(total: number, pendingDates: readonly string[]): string | null {
  if (!total || pendingDates.length !== total || new Set(pendingDates).size !== 1) return null;
  return `${total} 个职责已全部设置接收人，将于 ${pendingDates[0]} 生效`;
}

/** 确认弹窗：“请确认以下信息：N个 职责将转交给 <接收人>”，多个接收人用顿号连接。 */
export function dutyConfirmMessage(count: number, receiverNames: readonly string[]): string {
  return `请确认以下信息：${count}个 职责将转交给 ${receiverNames.join('、')}`;
}
