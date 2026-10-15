import type { ApprovalDetail, ApprovalRow } from '../approval/types.js';

// DEC-456：participated 包含待办和抄送，不得用它伪装已办。待后端提供已办查询后替换此适配。
const example: ApprovalDetail = {
  id: 'demo-completed-transfer',
  title: '合成员工林晓的调动申请',
  revision: 1,
  approvalType: 'transfer',
  status: 'approved',
  createdAt: '2026-10-10T02:30:00Z',
  actions: [],
  recordsHidden: false,
  form: { values: { effectiveDate: '2026-11-01', place: '杭州' }, originals: { place: '上海' } },
  tasks: [
    {
      id: 'demo-task',
      nodeName: '部门负责人审批',
      status: 'approved',
      comment: '同意岗位调整。',
      actedAt: '2026-10-11T01:00:00Z',
    },
  ],
  logs: [
    { event: 'start', createdAt: '2026-10-10T02:30:00Z' },
    { event: 'approve', taskId: 'demo-task', createdAt: '2026-10-11T01:00:00Z' },
    { event: 'complete', createdAt: '2026-10-11T01:00:00Z' },
  ],
};
export function completedExamples(): ApprovalRow[] {
  const { id, title, revision, approvalType, status, createdAt } = example;
  return [{ id, title, revision, approvalType, status, createdAt }];
}
export function completedDetail(id: string): ApprovalDetail {
  if (id !== example.id) throw new Error('Unknown demo record');
  return structuredClone(example);
}
