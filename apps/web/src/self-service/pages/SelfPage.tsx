import { Alert, Button, Descriptions, Space, Tabs, Tooltip, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { DetailPage, ListPage, PageState, pageQuery, useSession, type PageResult } from '../../foundation/index.js';
import { PersonAvatar } from '../../shared/PersonAvatar.js';
import { ApplicationDrawer } from './ApplicationDrawer.js';
import type { Profile, OwnRecord, Application } from '../../employee-self-service/types.js';
import { selfServiceDemo } from '../../demo-stubs/self-service.js';
import { canApplySelf, instant, recordItems, SELF, statusText, valueText } from './model.js';
import { DemoSection, Notes, ReadState, RecordInfo, Refresh, ServiceHeading, ServiceNav } from './parts.js';
import { useRead } from './useRead.js';
import { messages as m } from './messages.js';

export function SelfPage() {
  const path = useLocation().pathname;
  const session = useSession();
  return (
    <div className="service-page" key={`${session.tenantId}/${session.identityKey}`}>
      <ServiceNav />
      {['/self', '/self/profile', '/self/applications', '/self/records', '/self/requests'].includes(path) ? (
        <SelfWorkspace key={path} path={path} />
      ) : (
        <PageState kind="not-found" />
      )}
    </div>
  );
}
function SelfWorkspace({ path }: { path: string }) {
  const profile = useRead<Profile>(`${SELF}/profile`);
  if (!profile.data) return <ReadState state={profile} />;
  return path === '/self' || path === '/self/profile' ? (
    <ProfilePage profile={profile.data} refresh={profile.refresh} />
  ) : (
    <ApplicationsPage profile={profile.data} requests={path === '/self/requests'} />
  );
}
function ProfilePage({ profile, refresh }: { profile: Profile; refresh(): void }) {
  const { tenantId } = useSession();
  const [detail, setDetail] = useState(false);
  return (
    <>
      <Notes id="self.profile" />
      <ServiceHeading title={m.profile}>
        <Refresh onClick={refresh} />
      </ServiceHeading>
      <div className="service-profile-header">
        <PersonAvatar tenantId={tenantId} name={profile.employee.name} avatar={profile.employee.avatar} size={64} />
        <div>
          <h2>{profile.employee.name}</h2>
          <p>
            {profile.record
              ? (recordItems(profile.record).find((item) => item.key === 'departmentId')?.children ?? m.none)
              : m.none}
          </p>
          <span>
            {m.code}：{profile.employee.code}
          </span>
        </div>
        <div className="service-profile-actions">
          <Button onClick={() => setDetail(true)}>{m.detail}</Button>
          <Link to="/self/applications">
            <Button type="primary">{m.records}</Button>
          </Link>
        </div>
      </div>
      <Tabs
        activeKey="personnel"
        items={[
          { key: 'personnel', label: m.personnel },
          { key: 'employment', label: <Link to="/self/applications">{m.employment}</Link> },
        ]}
      />
      <div className="service-profile-layout">
        <div>
          <section className="service-section" id="self-basic">
            <h2>{m.employeeInfo}</h2>
            <Descriptions
              column={2}
              items={[
                { key: 'name', label: m.name, children: profile.employee.name },
                { key: 'code', label: m.code, children: profile.employee.code },
              ]}
            />
            <p className="service-muted">{m.profileReadonly}</p>
          </section>
          <section className="service-section" id="self-employment">
            <h2>{m.employmentInfo}</h2>
            <RecordInfo record={profile.record} />
          </section>
          {selfServiceDemo.sections.map((section) => (
            <DemoSection key={section.key} section={section} />
          ))}
        </div>
        <aside className="service-outline">
          <a href="#self-basic">{m.employeeInfo}</a>
          <a href="#self-employment">{m.employmentInfo}</a>
          {selfServiceDemo.sections.map((section) => (
            <a key={section.key} href={`#demo-${section.key}`}>
              {section.title}
            </a>
          ))}
        </aside>
      </div>
      <DetailPage
        open={detail}
        onClose={() => setDetail(false)}
        title={profile.employee.name}
        tabs={[{ key: 'record', label: m.employmentInfo, children: <RecordInfo record={profile.record} /> }]}
      />
    </>
  );
}
function ApplicationsPage({ profile, requests }: { profile: Profile; requests: boolean }) {
  // 员工自动身份只作用于本人入口：本人调动按钮由本人入口随档案返回，不走通用权限查询（F-141 第 2 轮）
  const canApply = canApplySelf((code, level) =>
    (profile.selfServiceButtons ?? []).some((b) => b.buttonCode === code && b.level === level),
  );
  const { tenantId } = useSession();
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [form, setForm] = useState(false);
  const [selected, setSelected] = useState<Application | null>(null);
  const [notice, setNotice] = useState(false);
  const path = requests ? `${SELF}/applications` : `${SELF}/employees/${profile.employee.id}/records`;
  const rows = useRead<PageResult<OwnRecord | Application>>(`${path}?${pageQuery(page)}`);
  const applications = (rows.data?.items ?? []) as Application[];
  const records = (rows.data?.items ?? []) as OwnRecord[];
  return (
    <>
      <Notes id="self.applications" />
      {notice && <Alert type="success" showIcon closable message={m.submitted} onClose={() => setNotice(false)} />}
      {!requests && <Alert className="service-hint" type="info" showIcon message={m.recordHint} />}
      {requests ? (
        <ListPage<Application>
          title={m.applications}
          data={{ ...rows.data, items: applications }}
          rowKey="id"
          page={page}
          onPageChange={setPage}
          loading={rows.loading}
          error={rows.error}
          retry={rows.refresh}
          actions={<Refresh onClick={rows.refresh} />}
          columns={applicationColumns(profile.timezone, setSelected)}
        />
      ) : (
        <ListPage<OwnRecord>
          title={m.records}
          data={{ ...rows.data, items: records }}
          rowKey="id"
          page={page}
          onPageChange={setPage}
          loading={rows.loading}
          error={rows.error}
          retry={rows.refresh}
          columns={recordColumns(records, profile.employee.name)}
          actions={
            <Space>
              {canApply && (
                <Button type="primary" onClick={() => setForm(true)}>
                  {m.transfer}
                </Button>
              )}
              {[m.leave, m.partTime].map((title) => (
                <Tooltip key={title} title={m.unavailable}>
                  <Button disabled>{title}</Button>
                </Tooltip>
              ))}
              <Refresh onClick={rows.refresh} />
            </Space>
          }
        />
      )}
      <ApplicationDrawer
        open={form && canApply}
        onClose={() => setForm(false)}
        tenantId={tenantId}
        profile={profile}
        onSaved={() => {
          setForm(false);
          setNotice(true);
          rows.refresh();
        }}
      />
      {selected && <ApplicationDetail item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
function recordColumns(records: OwnRecord[], name: string): TableColumnsType<OwnRecord> {
  const keys = new Map(records.flatMap((record) => recordItems(record).map((item) => [item.key, item.label] as const)));
  return [
    { key: 'name', title: m.name, render: () => name },
    ...Array.from(keys, ([key, title]) => ({
      key,
      title,
      render: (_: unknown, row: OwnRecord) => recordItems(row).find((item) => item.key === key)?.children ?? m.none,
    })),
  ];
}
function applicationColumns(timezone: string, select: (item: Application) => void): TableColumnsType<Application> {
  return [
    {
      title: m.applicationTitle,
      dataIndex: 'title',
      render: (title: string, row) => (
        <Button type="link" onClick={() => select(row)}>
          {title}
        </Button>
      ),
    },
    { title: m.category, dataIndex: 'category' },
    { title: m.initiator, dataIndex: 'initiator' },
    { title: m.handlers, dataIndex: 'currentHandlers', render: valueText },
    { title: m.approval, dataIndex: 'status', render: statusText },
    { title: m.reason, dataIndex: 'reason', render: valueText },
    { title: m.submittedAt, dataIndex: 'createdAt', render: (value: string) => instant(value, timezone) },
  ];
}
function ApplicationDetail({ item, onClose }: { item: Application; onClose(): void }) {
  const detail = useRead<{ status: string; record: OwnRecord }>(`${SELF}/applications/${encodeURIComponent(item.id)}`);
  return (
    <DetailPage
      open
      onClose={onClose}
      title={item.title}
      tabs={[
        {
          key: 'record',
          label: m.applicationInfo,
          children: detail.data ? (
            <>
              <Descriptions items={[{ key: 'status', label: m.approval, children: statusText(detail.data.status) }]} />
              <RecordInfo record={detail.data.record} />
            </>
          ) : (
            <ReadState state={detail} />
          ),
        },
      ]}
    />
  );
}
