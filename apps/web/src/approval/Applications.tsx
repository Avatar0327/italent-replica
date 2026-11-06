import { Button } from 'antd';
import { DecisionNote, ListPage } from '../foundation/index.js';
import { ApprovalDetail } from './ApprovalDetail.js';
import { applicationColumns } from './application-columns.js';
import { centerText as c, messages as m } from './messages.js';
import { useApplications } from './useApplications.js';

/**
 * 我的申请按原站为独立表格（§2.10，与已申请卡片不同）：类别 / 审批状态筛选、状态 / 时间排序与总数都在服务端；
 * 标题在当前页打开详情并带返回。申请理由暂无数据来源，显示占位。
 */
export function Applications() {
  const state = useApplications();
  const { data, page, selected, timezone, filters } = state;
  if (selected)
    return (
      <ApprovalDetail
        key={selected.id}
        layout="page"
        applications
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
      <div className="r1c-list">
        <ListPage
          title={c.applications}
          data={data}
          columns={applicationColumns({
            timezone,
            categories: filters.categories,
            statuses: filters.statuses,
            sort: filters.sort,
            onOpen: (row) => state.setSelected(row),
            onFilter: (next) => state.setFilters({ ...filters, ...next }),
            onSort: (sort) => state.setFilters({ ...filters, sort }),
          })}
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
    </div>
  );
}
