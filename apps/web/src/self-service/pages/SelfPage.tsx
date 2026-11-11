import { codeText } from '../../foundation/code-text.js';
import { Alert, Button, Descriptions, Space, Tabs, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { DetailPage, ListPage, PageState, pageQuery, useSession, type PageResult } from '../../foundation/index.js';
import { PersonAvatar } from '../../shared/PersonAvatar.js';
import { ApplicationDrawer } from './ApplicationDrawer.js';
import { QualificationTab } from './QualificationTab.js';
import type { Profile, OwnRecord, Application } from '../../employee-self-service/types.js';
import { selfServiceDemo } from '../../demo-stubs/self-service.js';
import { canApplySelf, instant, recordItems, SELF, statusText, valueText } from './model.js';
import { DemoSection, Notes, ReadState, RecordInfo, Refresh, ServiceHeading, ServiceNav } from './parts.js';
import { useRead } from './useRead.js';
import { SelfRequest, SelfRequestInfo, SelfApprovalProgress } from './SelfRequest.js';
import { selfRequestAllowed, type RequestKind } from './request-model.js';
import { q } from './request-messages.js';
import { messages as m } from './messages.js';

export function SelfPage() {
  const path = useLocation().pathname;
  const session = useSession();
  return (
    <div className="service-page" key={`${session.tenantId}/${session.identityKey}`}>
      <ServiceNav />
      {/^\/self\/(exit|partTime)\/(new|[a-fA-F0-9-]+)$/.test(path) ||
      ['/self', '/self/profile', '/self/applications', '/self/records', '/self/requests'].includes(path) ? (
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
  const request = /^\/self\/(exit|partTime)\/(new|[a-fA-F0-9-]+)$/.exec(path);
  if (request)
    return selfRequestAllowed(profile.data.selfServiceButtons ?? [], request[1] as RequestKind) ? (
      <SelfRequest kind={request[1] as RequestKind} id={request[2]!.toLowerCase()} />
    ) : (
      <PageState kind="forbidden" />
    );
  return path === '/self' || path === '/self/profile' ? (
    <ProfilePage profile={profile.data} refresh={profile.refresh} />
  ) : (
    <ApplicationsPage profile={profile.data} requests={path === '/self/requests'} />
  );
}
function ProfilePage({ profile, refresh }: { profile: Profile; refresh(): void }) {
  const { tenantId } = useSession();
  const [detail, setDetail] = useState(false);
  const [tab, setTab] = useState('personnel');
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
            {m.code}：{codeText(profile.employee.code)}
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
        activeKey={tab}
        onChange={(key) => key !== 'employment' && setTab(key)}
        items={[
          { key: 'personnel', label: m.personnel },
          { key: 'employment', label: <Link to="/self/applications">{m.employment}</Link> },
          { key: 'qualification', label: m.qualification },
        ]}
      />
      {tab === 'qualification' && <QualificationTab />}
      {tab === 'personnel' && <PersonnelSections profile={profile} />}
      <DetailPage
        open={detail}
        onClose={() => setDetail(false)}
        title={profile.employee.name}
        tabs={[{ key: 'record', label: m.employmentInfo, children: <RecordInfo record={profile.record} /> }]}
      />
    </>
  );
}
function PersonnelSections({ profile }: { profile: Profile }) {
  return (
    <div className="service-profile-layout">
      <div>
        <section className="service-section" id="self-basic">
          <h2>{m.employeeInfo}</h2>
          <Descriptions
            column={2}
            items={[
              { key: 'name', label: m.name, children: profile.employee.name },
              { key: 'code', label: m.code, children: codeText(profile.employee.code) },
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
  );
}
function ApplicationsPage({ profile, requests }: { profile: Profile; requests: boolean }) {
  // 员工自动身份只作用于本人入口：本人调动按钮由本人入口随档案返回，不走通用权限查询（F-141 第 2 轮）
  const canApply = canApplySelf((code, level) =>
    (profile.selfServiceButtons ?? []).some((b) => b.buttonCode === code && b.level === level),
  );
  const { tenantId } = useSession();
  const navigate = useNavigate();
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
              {(['exit', 'partTime'] as const)
                .filter((kind) => selfRequestAllowed(profile.selfServiceButtons ?? [], kind))
                .map((kind) => (
                  <Button key={kind} onClick={() => navigate(`/self/${kind}/new`)}>
                    {q.titles[kind]}
                  </Button>
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
const ownRecordWidths: Record<string, number> = {
  departmentId: 140,
  positionId: 140,
  effectiveDate: 105,
  stopDate: 105,
  approvalStatus: 140,
};
function recordColumns(records: OwnRecord[], name: string): TableColumnsType<OwnRecord> {
  const keys = new Map(records.flatMap((record) => recordItems(record).map((item) => [item.key, item.label] as const)));
  const first = ['departmentId', 'positionId', 'effectiveDate', 'stopDate', 'approvalStatus'];
  const ordered = [
    ...first.filter((key) => keys.has(key)),
    ...Array.from(keys.keys()).filter((key) => !first.includes(key)),
  ];
  return [
    { key: 'name', title: m.name, width: 140, render: () => name },
    ...ordered.map((key) => ({
      key,
      title: keys.get(key),
      width: ownRecordWidths[key],
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
  const detail = useRead<{ status: string; record: OwnRecord & Record<string, unknown> }>(
    `${SELF}/applications/${encodeURIComponent(item.id)}`,
  );
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
              {item.applicationKind ? (
                <SelfRequestInfo kind={item.applicationKind} record={detail.data.record} />
              ) : (
                <RecordInfo record={detail.data.record} />
              )}
              {item.applicationKind && ['draft', 'rejected'].includes(String(detail.data.record.status)) && (
                <Link to={`/self/${item.applicationKind}/${item.businessId}`}>{q.draft}</Link>
              )}
            </>
          ) : (
            <ReadState state={detail} />
          ),
        },
        ...(item.applicationKind
          ? [{ key: 'progress', label: q.progress, children: <SelfApprovalProgress id={item.id} /> }]
          : []),
      ]}
    />
  );
}
