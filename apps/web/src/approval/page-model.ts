import { centerText as c, delegationText as d, processText as p } from './messages.js';
import type { ApprovalAction, ApprovalView } from './types.js';

/**
 * 审批中心页面结构（纯数据，单测直接核对；DEC-489 以原站为准）。
 * 子页可见性只读服务端快照的入口对象，这里不授予权限：流程管理与管理员委托受审批实例对象权限控制（DEC-063 / DEC-070）。
 */
export const APPROVAL_INSTANCE_OBJECT = 'TenantBase.ApprovalInstance';
export type ApprovalSection = 'todos' | 'applications' | 'delegations' | 'processes' | 'admin-delegations';
export const approvalSections: readonly { key: ApprovalSection; label: string; path: string; admin: boolean }[] = [
  // 侧栏以路径作菜单键，我的待办不能与审批中心同用 /approval；/approval 进入后转到这里。
  { key: 'todos', label: c.todos, path: '/approval/todos', admin: false },
  { key: 'applications', label: c.applications, path: '/approval/applications', admin: false },
  { key: 'delegations', label: c.delegations, path: '/approval/delegations', admin: false },
  { key: 'processes', label: c.processes, path: '/approval/processes', admin: true },
  { key: 'admin-delegations', label: c.adminDelegations, path: '/approval/admin-delegations', admin: true },
];
export const visibleSections = (entryObjects: readonly string[]) =>
  approvalSections.filter((section) => !section.admin || entryObjects.includes(APPROVAL_INSTANCE_OBJECT));
/** 菜单子项按服务端快照里审批中心应用的入口对象推导。 */
export const approvalEntryObjects = (snapshot: {
  apps: readonly { app: string; entryObjects?: readonly string[] }[];
}) => snapshot.apps.find((app) => app.app === 'approval')?.entryObjects ?? [];
/** 页面拦截读已推导好的菜单子项，与侧栏同一来源；客户端快照不保留服务端 apps。 */
export const menuSections = (menus: readonly { key: string; children?: readonly { path: string }[] }[]) => {
  const paths = new Set(menus.find((menu) => menu.key === 'approval')?.children?.map((child) => child.path));
  return approvalSections.filter((section) => paths.has(section.path)).map((section) => section.key);
};
export const todosPath = '/approval/todos';
export const sectionOf = (pathname: string) =>
  approvalSections.find((section) => section.path === pathname.replace(/\/+$/, ''))?.key;

/** 详情头部按钮顺序；是否显示只看详情 actions（服务端下发）。 */
export const actionOrder: readonly ApprovalAction[] = ['approve', 'disagree', 'reject', 'transfer', 'withdraw'];

export type TodoTool = 'batchApprove' | 'batchDisagree' | 'delegate' | 'manage';
export const todoTools: Record<ApprovalView, readonly TodoTool[]> = {
  pending: ['batchApprove', 'batchDisagree', 'delegate', 'manage'],
  completed: ['delegate', 'manage'],
  initiated: ['delegate', 'manage'],
};
/** 批量审批没有接口；流程委托、流程管理跳到对应子页（流程管理仍按菜单可见性拦截）。 */
export const todoToolTargets: Partial<Record<TodoTool, ApprovalSection>> = {
  delegate: 'delegations',
  manage: 'processes',
};
export const todoSort: Record<ApprovalView, string> = {
  pending: c.receivedDesc,
  completed: c.handledDesc,
  initiated: c.appliedDesc,
};

export const applicationColumns = ['title', 'category', 'status', 'createdAt'] as const;
/** 原站有、接口没有的列：不伪造，等后端补齐（后端缺口清单）。 */
export const applicationGapColumns = ['initiator', 'handler', 'reason'] as const;

export interface GapView {
  key: string;
  label: string;
  tools: readonly string[];
  banner: readonly string[];
  columns: readonly string[];
  selectable: boolean;
}
export interface GapPage {
  section: ApprovalSection;
  title: string;
  filters: readonly string[];
  views: readonly GapView[];
}
const delegationColumns = [d.startAt, d.endAt, d.typeScope, d.types, d.departmentScope, d.departments];
export const gapPages: Record<'delegations' | 'processes' | 'admin-delegations', GapPage> = {
  delegations: {
    section: 'delegations',
    title: c.delegations,
    filters: [],
    views: [
      {
        key: 'active',
        label: d.activeMine,
        tools: [d.create, d.batchRevoke, d.delegated],
        banner: d.mineBanner,
        columns: [d.principal, d.delegate, ...delegationColumns, d.existingTodos, d.creator, d.operation],
        selectable: true,
      },
      {
        key: 'completed',
        label: d.completedMine,
        tools: [d.delegated],
        banner: d.mineBanner,
        columns: [
          d.principal,
          d.delegate,
          d.createdAt,
          ...delegationColumns,
          d.revokedAt,
          d.existingTodos,
          d.operation,
        ],
        selectable: false,
      },
    ],
  },
  processes: {
    section: 'processes',
    title: p.view,
    filters: [p.title, p.type, p.initiator, p.approver, p.status],
    views: [
      {
        key: 'org',
        label: p.view,
        tools: [p.urge, p.transfer, p.withdraw, p.oneClick, p.export],
        banner: p.banner,
        columns: [
          p.title,
          p.type,
          p.initiator,
          p.code,
          p.approver,
          p.status,
          p.createdAt,
          p.summary,
          p.urgeStatus,
          p.operation,
        ],
        selectable: true,
      },
    ],
  },
  'admin-delegations': {
    section: 'admin-delegations',
    title: c.adminDelegations,
    filters: [d.principal, d.delegate],
    views: [
      {
        key: 'active',
        label: d.activeAdmin,
        tools: [d.create, d.batchRevoke, d.export],
        banner: d.adminBanner,
        columns: [d.principal, d.delegate, ...delegationColumns, d.existingTodos, d.operation],
        selectable: false,
      },
      {
        key: 'completed',
        label: d.completedAdmin,
        tools: [d.export],
        banner: d.adminCompletedBanner,
        columns: [
          ...[d.principal, d.delegate, d.createdAt, ...delegationColumns],
          ...[d.revokedBy, d.revokedAt, d.existingTodos, d.operation],
        ],
        selectable: false,
      },
    ],
  },
};
