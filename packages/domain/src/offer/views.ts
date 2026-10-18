/**
 * Offer 管理的 10 个视图（R2 BE-14a C1）与行操作矩阵（BE-14a2；34 §2.1，A19）。列序列宽与前端 apps/web/src/offers/messages.ts
 * （派发附录 B2）一致；field 为空的列是本段还没有数据来源的字段（简历、附件、签署、同步状态等），接口照样返回列定义、值为空。
 * 当前审批人 / 当前审批节点随 BE-14a3 取在途审批实例。
 */
import type { OfferApprovalStatus, OfferField, OfferStatus } from './rules.js';
import { offerEditable, offerInvalidatable, type OfferStateFacts } from './rules.js';

export type OfferListField =
  | OfferField
  | 'status'
  | 'approvalStatus'
  | 'offerType'
  | 'acceptTime'
  | 'refusalTime'
  | 'refusalRemark'
  | 'invalidAt'
  | 'sentBy'
  | 'sentAt'
  | 'currentApprovers'
  | 'currentApprovalNode';

/** 原站显示名 → 字段；不在表里的列（简历信息、Offer附件、签署状态等）没有数据来源。 */
const LABEL_FIELDS: Readonly<Record<string, OfferListField>> = {
  姓名: 'name',
  个人邮箱: 'personalEmail',
  邮箱: 'personalEmail',
  手机号码: 'mobile',
  证件类型: 'idType',
  证件号码: 'idNumber',
  性别: 'gender',
  录用部门: 'departmentId',
  部门: 'departmentId',
  组织全称: 'departmentId',
  应聘职位: 'appliedPosition',
  职位: 'positionId',
  录用职位: 'positionId',
  职务: 'postId',
  预计入职日期: 'plannedEntryDate',
  拟入职日期: 'plannedEntryDate',
  入职日期: 'plannedEntryDate',
  审批状态: 'approvalStatus',
  offer状态: 'status',
  Offer类型: 'offerType',
  工作地点: 'workPlace',
  '试用期(月)': 'probationMonths',
  直线经理: 'directManagerId',
  接受offer日期: 'acceptTime',
  拒绝offer日期: 'refusalTime',
  拒绝原因备注: 'refusalRemark',
  失效时间: 'invalidAt',
  Offer发送人: 'sentBy',
  Offer发送日期: 'sentAt',
  当前审批人: 'currentApprovers',
  当前审批节点: 'currentApprovalNode',
};

type ColumnSpec = readonly [label: string, width: number];
interface ViewSource {
  readonly key: string;
  readonly code: string;
  readonly label: string;
  readonly statuses: readonly OfferStatus[] | null;
  readonly approval?: OfferApprovalStatus;
  readonly filters: readonly string[];
  readonly columns: readonly ColumnSpec[];
}

const w = (label: string, width = 140): ColumnSpec => [label, width];
const DATE = 105;

/**
 * 视图编码以 …NavView 为准（R2e3）。原站页签实测编码只有待发 / 已接受 / 已入职三项（34 文末，ListView 形态），
 * 其余按同一命名规则给出，R2e3 spec §2.1 原表在维护者本机，合入前未能逐项对照（见 PR“未决 / 假设”）。
 */
const SOURCES: readonly ViewSource[] = [
  {
    key: 'pending',
    code: 'TenantBase.MomentumOfferNavView',
    label: '待发Offer',
    statuses: ['pending'],
    filters: ['姓名', '个人邮箱', '审批状态'],
    columns: [
      ...['姓名', '个人邮箱', '证件类型', '证件号码', '性别', '录用部门', '应聘职位'].map((l) => w(l)),
      w('预计入职日期', DATE),
      w('审批状态'),
      w('当前审批人', 110),
      w('简历信息'),
      w('Offer附件', 262),
    ],
  },
  {
    key: 'unsubmitted',
    code: 'TenantBase.UnapprovedOfferNavView',
    label: '未发起审批',
    statuses: ['pending'],
    approval: 'unsubmitted',
    filters: ['姓名', '部门', '职务', '职位'],
    columns: [
      w('姓名', 92),
      w('个人邮箱'),
      w('手机号码'),
      w('性别', 88),
      ...['录用部门', '组织全称', '职位'].map((l) => w(l)),
      w('预计入职日期', DATE),
      ...['简历信息', '面试评价', '批量发起审批结果', '批量发送Offer结果'].map((l) => w(l)),
    ],
  },
  {
    key: 'approving',
    code: 'TenantBase.ApprovingOfferNavView',
    label: '审批中',
    statuses: ['pending'],
    approval: 'approving',
    filters: ['姓名', '个人邮箱', '部门'],
    columns: [
      ...['姓名', '个人邮箱', '手机号码', '证件类型', '证件号码', '录用部门', '组织全称', '应聘职位'].map((l) => w(l)),
      w('预计入职日期', DATE),
      w('审批状态'),
      w('当前审批节点'),
      w('当前审批人', 110),
      w('简历信息'),
    ],
  },
  {
    key: 'approved',
    code: 'TenantBase.ApprovedOfferNavView',
    label: '审批通过',
    statuses: ['pending'],
    approval: 'approved',
    filters: ['姓名', '部门', '职务', '职位'],
    columns: [
      ...['姓名', '个人邮箱', '手机号码', '性别', '录用部门', '职位'].map((l) => w(l)),
      w('预计入职日期', DATE),
      w('简历信息'),
      w('面试评价'),
    ],
  },
  {
    key: 'sent',
    code: 'TenantBase.AlreadySendOfferNavView',
    label: '已发Offer',
    statuses: ['sent'],
    filters: ['姓名', '个人邮箱', '录用部门', '录用职位', '同步状态'],
    columns: [
      ...['姓名', '个人邮箱', '证件类型', '证件号码', '性别', '录用部门', '应聘职位', '录用职位', '工作地点'].map((l) =>
        w(l),
      ),
      w('试用期(月)'),
      w('拟入职日期', DATE),
      w('Offer发送人', 130),
      w('Offer发送日期', DATE),
      w('附件', 262),
      w('Offer附件', 262),
    ],
  },
  {
    key: 'accepted',
    code: 'TenantBase.AlreadyAcceptOfferNavView',
    label: '已接受Offer',
    statuses: ['accepted'],
    filters: ['姓名', '个人邮箱', '录用部门', '录用职位', '同步状态'],
    columns: [
      ...['姓名', '个人邮箱', '证件类型', '证件号码', '性别', '录用部门', '应聘职位'].map((l) => w(l)),
      w('推荐人', 130),
      ...['录用职位', '工作地点', '试用期(月)'].map((l) => w(l)),
      w('拟入职日期', DATE),
      w('接受offer日期', DATE),
      w('Offer发送人', 130),
      w('Offer发送日期', DATE),
      w('签署状态'),
      w('Offer电子签署附件', 262),
      w('Offer电子协议附页', 262),
      w('同步状态', 92),
    ],
  },
  {
    key: 'rejected',
    code: 'TenantBase.AlreadyRefuseOfferNavView',
    label: '已拒绝Offer',
    statuses: ['rejected'],
    filters: ['姓名', '个人邮箱'],
    columns: [
      w('姓名', 118),
      ...['个人邮箱', '证件类型', '证件号码'].map((l) => w(l)),
      w('性别', 72),
      w('录用部门'),
      w('应聘职位'),
      w('拒绝offer日期', DATE),
      w('拒绝原因备注'),
    ],
  },
  {
    key: 'onboarded',
    code: 'TenantBase.AlreadyEntryOfferNavView',
    label: '已入职Offer',
    statuses: ['onboarded'],
    filters: ['姓名', '录用部门', '录用职位', '入职日期'],
    columns: [
      w('姓名', 118),
      ...['邮箱', '证件类型', '证件号码'].map((l) => w(l)),
      w('性别', 72),
      ...['部门', '录用职位', '工作地点'].map((l) => w(l)),
      w('入职日期', DATE),
      w('推荐人', 130),
      w('签署状态', 92),
      w('Offer电子签署附件', 262),
      w('Offer电子协议附页', 262),
    ],
  },
  {
    key: 'all',
    code: 'TenantBase.AllOfferNavView',
    label: '全部Offer',
    statuses: null,
    filters: ['姓名', '个人邮箱', '部门', '审批状态', 'offer状态'],
    columns: [
      ...['姓名', '个人邮箱', '手机号码', '证件类型', '证件号码', '录用部门', '应聘职位'].map((l) => w(l)),
      w('入职日期', DATE),
      w('offer状态'),
      w('审批状态'),
    ],
  },
  {
    key: 'invalid',
    code: 'TenantBase.InvalidOfferNavView',
    label: '失效Offer',
    statuses: ['invalid'],
    filters: ['姓名', '个人邮箱', '部门', '入职日期'],
    columns: [
      w('姓名', 118),
      w('个人邮箱'),
      w('Offer类型'),
      w('入职日期', DATE),
      w('录用部门'),
      w('直线经理', 130),
      w('职位'),
      w('职务序列'),
      w('失效时间', 158),
      w('审批状态', 92),
      w('简历信息'),
      w('面试评价'),
    ],
  },
];

export interface OfferViewColumn {
  readonly label: string;
  readonly width: number;
  readonly field: OfferListField | null;
}
export interface OfferView {
  readonly key: string;
  readonly code: string;
  readonly label: string;
  readonly statuses: readonly OfferStatus[] | null;
  readonly approvalStatus: OfferApprovalStatus | null;
  readonly filters: readonly { readonly label: string; readonly field: OfferListField | null }[];
  readonly columns: readonly OfferViewColumn[];
}

export const OFFER_VIEWS: readonly OfferView[] = SOURCES.map((source) => ({
  key: source.key,
  code: source.code,
  label: source.label,
  statuses: source.statuses,
  approvalStatus: source.approval ?? null,
  filters: source.filters.map((label) => ({ label, field: LABEL_FIELDS[label] ?? null })),
  columns: source.columns.map(([label, width]) => ({ label, width, field: LABEL_FIELDS[label] ?? null })),
}));

export function offerView(key: string): OfferView | undefined {
  return OFFER_VIEWS.find((view) => view.key === key);
}

/** 行操作编码（34 §2.1 行操作矩阵；待发的审批子状态按 R2e3 截图，与前端 apps/web/src/offers/model.ts 一致）。 */
export const OFFER_ROW_ACTIONS = [
  'submitApproval',
  'edit',
  'send',
  'transfer',
  'invalidate',
  'linkIntern',
  'view',
  'delete',
  'resend',
  'editSync',
  'viewMail',
  'sign',
  'copy',
  'urge',
  'delegate',
  'revoke',
] as const;
export type OfferRowAction = (typeof OFFER_ROW_ACTIONS)[number];
export interface OfferRowActions {
  readonly primary: readonly OfferRowAction[];
  readonly menu: readonly OfferRowAction[];
}

/**
 * 已接线的行操作：接口只返回这些（再按当前用户权限裁剪）。发送 / 重发已由 BE-14b1 接线；编辑并同步（BE-14b3）已接线；查看邮件 /
 * 电子签署 / 关联在职实习生归 BE-14b；发起审批随 BE-14a3 接线，审批中的催办 / 转交 / 撤销走审批中心实例动作、未接进行操作。
 * 未接线的动作不出现，不给可点但无效的入口。
 */
export const OFFER_WIRED_ROW_ACTIONS: readonly OfferRowAction[] = [
  'submitApproval',
  'edit',
  'send',
  'resend',
  'transfer',
  'invalidate',
  'view',
  'delete',
  'copy',
  'editSync',
];

/**
 * 原站矩阵（AC-OF-16 / 19 / 20）：已拒绝的转移状态只在行主按钮，下拉没有转移与失效；失效只剩复制 / 查看；
 * 已入职主按钮查看邮件。待发失效只给非实习类（DEC-533①）；审批中 / 审批通过的待发按 R2e3 截图。
 */
export function offerRowActions(
  offer: Pick<OfferStateFacts, 'status' | 'approvalStatus' | 'offerType'>,
): OfferRowActions {
  const invalidate: OfferRowAction[] = offerInvalidatable(offer) ? ['invalidate'] : [];
  switch (offer.status) {
    case 'pending':
      if (offer.approvalStatus === 'approving') return { primary: ['urge', 'delegate', 'revoke'], menu: invalidate };
      if (offer.approvalStatus === 'approved' && offerEditable(offer)) return { primary: ['edit'], menu: invalidate };
      return {
        primary: ['submitApproval'],
        menu: ['edit', 'send', 'transfer', ...invalidate, 'linkIntern', 'view', 'delete'],
      };
    case 'sent':
      return { primary: ['resend'], menu: ['editSync', 'transfer', 'viewMail', ...invalidate, 'view'] };
    case 'accepted':
      return { primary: ['editSync'], menu: ['transfer', 'viewMail', ...invalidate, 'sign', 'view'] };
    case 'rejected':
      return { primary: ['transfer'], menu: ['viewMail', 'view'] };
    case 'onboarded':
      return { primary: ['viewMail'], menu: ['sign', 'view'] };
    case 'invalid':
      return { primary: ['copy'], menu: ['viewMail', 'view'] };
  }
}
