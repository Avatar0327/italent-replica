import { Alert, Button, Descriptions, Drawer, Input, Space, Tag } from 'antd';
import { useState } from 'react';
import { ApprovalListPanel } from '../approval/ApprovalPage.js';
import { transferExamples, type TransferListRow } from '../demo-stubs/transfer.js';
import { Can, DecisionNote, DetailPage, ListPage, useSession, type PageRequest } from '../foundation/index.js';
import { TransferApplication } from '../self-service/shared/TransferApplication.js';
import { text as m } from './messages.js';
import { ReferenceFrame, ReferenceView } from './ReferenceView.js';
import { TransferDrafts } from './TransferDrafts.js';
import './transfer.css';
import './hr-transfer.css';

export function HrTransferPage() {
  return (
    <ReferenceFrame>
      <HrTransferContent />
    </ReferenceFrame>
  );
}
function HrTransferContent() {
  const [tab, setTab] = useState('progress');
  const [open, setOpen] = useState(false);
  return (
    <section className="hr-transfer-page">
      <ReferenceView
        title={
          tab === 'mine'
            ? m.myApplications
            : tab === 'all'
              ? m.allRecords
              : tab === 'completed'
                ? m.completed
                : m.inProgress
        }
        choices={[
          { key: 'progress', label: m.inProgress },
          { key: 'completed', label: m.completed },
          { key: 'all', label: m.allRecords },
          { key: 'mine', label: m.myApplications },
        ]}
        onChange={setTab}
        actions={
          <Can object="TenantBase.EmploymentRecord" button="Transfer.Hr">
            <Button type="primary" onClick={() => setOpen(true)}>
              {m.subtitle}
            </Button>
          </Can>
        }
      />
      <DecisionNote id="transfer" />
      {tab === 'mine' ? (
        <>
          <TransferDrafts />
          <ApprovalListPanel />
        </>
      ) : (
        <TransferList key={tab} tab={tab} />
      )}
      <TransferDrawer open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
function TransferDrawer({ open, onClose }: { open: boolean; onClose(): void }) {
  const session = useSession();
  return (
    <Drawer
      open={open}
      title={m.subtitle}
      width={1120}
      rootClassName="r1c-reference-drawer"
      onClose={() => onClose()}
      destroyOnHidden
    >
      <DecisionNote id="transfer-form" />
      <Alert type="info" message={m.formHint} showIcon />
      {open && (
        <div className="legacy-page r1c-transfer-form">
          <TransferApplication
            key={`${session.tenantId}/${session.identityKey}`}
            tenantId={session.tenantId}
            initiator="hr"
            hrScope={JSON.stringify([session.tenantId, session.identityKey])}
          />
        </div>
      )}
    </Drawer>
  );
}
function TransferList({ tab }: { tab: string }) {
  const [selected, setSelected] = useState<TransferListRow>();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 15 });
  const rows = transferExamples().filter(
    (row) =>
      (tab === 'all' || (tab === 'completed' ? row.status === 'effective' : row.status !== 'effective')) &&
      `${row.name} ${row.code}`.includes(query.trim()),
  );
  const statuses = { running: m.running, approved: m.approved, effective: m.effectiveStatus };
  return (
    <>
      <>
        <Alert type="info" showIcon message={m.listHint} />
        <div className="hr-demo-notice">
          <Tag color="gold">{m.demo}</Tag>
          <span>{m.listGap}</span>
        </div>
        <div className="r1c-list">
          <ListPage
            title={tab === 'all' ? m.allRecords : tab === 'completed' ? m.completed : m.inProgress}
            data={{ items: rows.slice((page.page - 1) * page.pageSize, page.page * page.pageSize), total: rows.length }}
            rowKey="id"
            page={page}
            onPageChange={setPage}
            filters={
              <Input
                allowClear
                className="transfer-list-search"
                aria-label={m.listSearch}
                placeholder={m.listSearch}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage({ ...page, page: 1 });
                }}
              />
            }
            columns={[
              {
                title: m.employeeName,
                dataIndex: 'name',
                render: (value: string, row: TransferListRow) => (
                  <Button type="link" onClick={() => setSelected(row)}>
                    {value}
                  </Button>
                ),
              },
              { title: m.employeeCode, dataIndex: 'code' },
              { title: m.date, dataIndex: 'effectiveDate' },
              { title: m.type, dataIndex: 'type' },
              { title: m.beforeDepartment, dataIndex: 'beforeDepartment' },
              { title: m.beforePosition, dataIndex: 'beforePosition' },
              { title: m.afterDepartment, dataIndex: 'department' },
              { title: m.afterPosition, dataIndex: 'position' },
              {
                title: m.approvalStatus,
                dataIndex: 'status',
                render: (value: TransferListRow['status']) => (
                  <Tag color={value === 'effective' ? 'green' : 'blue'}>{statuses[value]}</Tag>
                ),
              },
            ]}
          />
        </div>
      </>
      {selected && <TransferExampleDetail selected={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
function TransferExampleDetail({ selected, onClose }: { selected: TransferListRow; onClose(): void }) {
  const statuses = { running: m.running, approved: m.approved, effective: m.effectiveStatus };
  return (
    <DetailPage
      open
      onClose={onClose}
      title={selected.name}
      summary={
        <>
          <DecisionNote id="transfer" />
          <Alert type="info" message={m.demo} description={m.listGap} showIcon />
          <Space>
            <Tag>{statuses[selected.status]}</Tag>
            {selected.code}
          </Space>
        </>
      }
      sections={[
        {
          key: 'transfer',
          title: m.adjustment,
          children: (
            <Descriptions
              bordered
              column={2}
              items={[
                { key: 'date', label: m.date, children: selected.effectiveDate },
                { key: 'type', label: m.type, children: selected.type },
                { key: 'before', label: m.beforeDepartment, children: selected.beforeDepartment },
                { key: 'after', label: m.afterDepartment, children: selected.department },
                { key: 'beforePosition', label: m.beforePosition, children: selected.beforePosition },
                { key: 'afterPosition', label: m.afterPosition, children: selected.position },
              ]}
            />
          ),
        },
      ]}
    />
  );
}
