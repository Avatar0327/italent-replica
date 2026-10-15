import { Alert, Button, type TableColumnsType } from 'antd';
import { DecisionNote, ListPage } from '../foundation/index.js';
import { TransferDrafts } from '../transfer/TransferDrafts.js';
import { ApprovalDetail, formatInstant } from './ApprovalDetail.js';
import { centerText as c, instanceStatus, messages as m, statusLabels, typeLabels } from './messages.js';
import type { ApprovalRow } from './types.js';
import { useApprovalList } from './useApprovalList.js';

/**
 * 我的申请按原站为独立表格（与已申请卡片不同）；标题在当前页打开详情并带返回。
 * 发起人、当前处理人、申请理由列与类别 / 审批状态筛选没有接口，不伪造（后端缺口清单）。
 * 他人调动申请暂存后提示“请在我的申请中查看”，本会话暂存单放在这里。
 */
export function Applications() {
  const state = useApprovalList('initiated');
  const { data, page, selected, timezone } = state;
  if (selected)
    return (
      <ApprovalDetail
        key={selected.id}
        layout="page"
        row={selected}
        onClose={() => state.setSelected(undefined)}
        onChanged={state.refresh}
      />
    );
  return (
    <div className="approval-applications">
      {/* 原站本页没有顶部业务工具栏；ListPage 自带的标题行（含导出）在 r1c-list 下隐藏，标题单独显示。 */}
      <h2 className="approval-section-title">{c.applications}</h2>
      <DecisionNote id="approval-applications" />
      <Alert showIcon type="info" message={c.applicationGap} />
      <div className="r1c-list">
        <ListPage
          title={c.applications}
          data={data}
          columns={applicationColumns((row) => state.setSelected(row), timezone)}
          rowKey="id"
          page={page}
          onPageChange={state.setPage}
          loading={state.loading}
          error={state.error}
          retry={state.refresh}
          filters={
            <Button onClick={state.refresh} loading={state.loading}>
              {m.refresh}
            </Button>
          }
        />
      </div>
      <TransferDrafts />
    </div>
  );
}
/** 列序按原站：标题、类别、审批状态、申请时间；审批状态为深色普通文字（不是标签）。 */
function applicationColumns(onOpen: (row: ApprovalRow) => void, timezone: string): TableColumnsType<ApprovalRow> {
  return [
    {
      title: c.titleColumn,
      key: 'title',
      ellipsis: true,
      render: (_: unknown, row: ApprovalRow) => (
        <Button type="link" className="approval-table-link" onClick={() => onOpen(row)}>
          {row.title}
        </Button>
      ),
    },
    { title: c.category, dataIndex: 'approvalType', render: (type: string) => typeLabels[type] ?? type },
    {
      title: m.status,
      dataIndex: 'status',
      render: (status: string) => instanceStatus[status]?.label ?? statusLabels[status] ?? status,
    },
    { title: c.applyTime, dataIndex: 'createdAt', render: (time: string) => formatInstant(time, timezone) },
  ];
}
