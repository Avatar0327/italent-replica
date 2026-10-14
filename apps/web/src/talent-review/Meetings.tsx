import { Button } from 'antd';
import { useState } from 'react';
import { reviewDemo } from '../demo-stubs/talent-review.js';
import { DetailPage, ListPage } from '../foundation/templates.js';
import { DemoGrid, DemoNotice } from './DemoPanels.js';
import { tr } from './messages.js';
export function Meetings() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  return (
    <>
      <DemoNotice />
      <ListPage
        title={tr.meetings}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        data={{ items: reviewDemo.meetings, total: 1 }}
        columns={['name', 'ownerOrgId', 'project', 'owner', 'date', 'committee', 'status'].map((key) => ({
          dataIndex: key,
          title:
            key === 'name'
              ? tr.column.meetingName
              : (tr.fields[key as keyof typeof tr.fields] ?? tr.column[key as keyof typeof tr.column]),
          width: 140,
          render: (value: string) =>
            key === 'name' ? (
              <Button type="link" onClick={() => setOpen(true)}>
                {value}
              </Button>
            ) : (
              value
            ),
        }))}
      />
      <DetailPage
        open={open}
        onClose={() => setOpen(false)}
        title={tr.demoMeeting}
        summary={<DemoNotice />}
        tabs={[{ key: 'grid', label: tr.tabs[3], children: <DemoGrid /> }]}
      />
    </>
  );
}
