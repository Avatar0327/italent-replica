import { Button, Space } from 'antd';
import { useState } from 'react';
import { PageState } from '../foundation/PageState.js';
import { apiRoot, type ListResult } from './model.js';
import { PartTimeTable } from './PartTimeTable.js';
import { PartTimeDetail, type Selection } from './PartTimeDetail.js';
import { useRead } from './useRead.js';
import { m } from './messages.js';
import './part-time.css';
export function EmployeePartTimes({ employeeId }: { employeeId: string }) {
  return <EmployeeRecords key={employeeId} employeeId={employeeId} />;
}
function EmployeeRecords({ employeeId }: { employeeId: string }) {
  const [page, setPage] = useState(1);
  const [selected, select] = useState<Selection>();
  const result = useRead<ListResult>(
    `${apiRoot}/employees/${encodeURIComponent(employeeId)}/part-times?page=${page}&pageSize=30`,
  );
  if (result.error) return <PageState kind="error" error={result.error} retry={result.refresh} />;
  return (
    <>
      <PartTimeTable
        rows={result.data?.items ?? []}
        view="all"
        loading={result.loading}
        profile
        noScope={result.data?.hasDataPermission === false}
        onOpen={(row) => select({ id: row.id, request: false })}
      />
      <Space className="part-time-pagination">
        <Button disabled={result.loading || page === 1} onClick={() => setPage(page - 1)}>
          {m.previous}
        </Button>
        <span>{m.page(page)}</span>
        <Button disabled={result.loading || (result.data?.items.length ?? 0) < 30} onClick={() => setPage(page + 1)}>
          {m.next}
        </Button>
      </Space>
      {selected && (
        <PartTimeDetail
          key={`${selected.request}/${selected.id}`}
          selected={selected}
          onSelect={select}
          onClose={() => select(undefined)}
        />
      )}
    </>
  );
}
