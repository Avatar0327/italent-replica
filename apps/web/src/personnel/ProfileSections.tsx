import { Button, Descriptions, Empty, Space, Tag } from 'antd';
import { useId, useState } from 'react';
import { PERSONNEL_OBJECT, SUBSETS } from '@italent/domain';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import type { PageResult } from '../foundation/client.js';
import { ReadPanel } from './ReadPanel.js';
import { useRead } from './useRead.js';
import { useSubsetAccess, type ProfileSubset } from './useSubsetAccess.js';
import { displayValue, fieldValue, recordPeriod, type Row } from './model.js';
import { m, subsetLabels } from './messages.js';

export function FieldGrid({
  row,
  fields,
  allowed,
}: {
  row: Record<string, unknown>;
  fields: string[];
  allowed: readonly string[];
}) {
  const visible = fields.filter((key) => allowed.includes(key) && Object.hasOwn(row, key));
  return visible.length ? (
    <Descriptions
      column={2}
      size="small"
      colon={false}
      items={visible.map((key) => ({
        key,
        label: m.labels[key],
        children: fieldValue(key, row[key]),
      }))}
    />
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={m.noFields} />
  );
}
const profileSections = [
  {
    key: 'basic',
    title: m.basic,
    fields: ['name', 'code', 'gender', 'birthday', 'age', 'nationality', 'nation', 'marryCategory', 'politicalStatus'],
  },
  {
    key: 'contact',
    title: m.contact,
    fields: ['mobilePhone', 'email', 'workEmail', 'backupMail', 'contactAddress', 'emergencyContact', 'emergencyPhone'],
  },
  { key: 'school', title: m.education, fields: ['educationLevel', 'lastSchool', 'major', 'graduateDate'] },
  {
    key: 'dates',
    title: m.dates,
    fields: ['employeeStatus', 'entryDate', 'firstEntryDate', 'latestEntryDate', 'lastWorkDate'],
  },
];

/** 原站“人员信息”页签：基本信息与各子集纵向排列，右侧档案导航点击后滚动到对应分区。 */
export function PersonnelProfile({ row, employeeId }: { row: Row; employeeId: string }) {
  const prefix = useId();
  const [active, setActive] = useState<string>();
  const permission = usePermissions(PERSONNEL_OBJECT);
  const allowed = permission.snapshot.objects[PERSONNEL_OBJECT]?.viewableFields ?? [];
  const access = useSubsetAccess();
  const sections = profileSections.filter((section) => section.fields.some((key) => allowed.includes(key)));
  const kinds = Object.keys(access.data ?? {}) as ProfileSubset[];
  const anchors = [
    ...sections.map(({ key, title }) => ({ key, title })),
    ...kinds.map((kind) => ({ key: kind, title: subsetLabels[kind] })),
  ];
  const anchor = (key: string) => `${prefix}-${key}`;
  return (
    <div className="staff-profile">
      <div className="staff-profile-content">
        {sections.map((section) => (
          <section className="staff-section" key={section.key} id={anchor(section.key)} aria-label={section.title}>
            <h3 className="staff-section-title">{section.title}</h3>
            <FieldGrid row={row} fields={section.fields} allowed={allowed} />
          </section>
        ))}
        {access.error !== undefined ? (
          <PageState kind="error" error={access.error} retry={access.refresh} />
        ) : (
          access.loading && <PageState kind="loading" />
        )}
        {kinds.map((kind) => (
          <SubsetRows
            key={`${employeeId}/${kind}`}
            id={anchor(kind)}
            employeeId={employeeId}
            kind={kind}
            allowed={access.data![kind]!.viewableFields}
          />
        ))}
      </div>
      <nav aria-label={m.profileNav}>
        {anchors.map(({ key, title }) => (
          <Button
            type="text"
            key={key}
            className={key === active ? 'is-active' : ''}
            aria-current={key === active ? 'location' : undefined}
            onClick={() => {
              setActive(key);
              document.getElementById(anchor(key))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
          >
            {title}
          </Button>
        ))}
      </nav>
    </div>
  );
}

export function PageButtons({
  page,
  count,
  loading,
  onChange,
}: {
  page: number;
  count: number;
  loading: boolean;
  onChange(page: number): void;
}) {
  return (
    <div className="staff-pagination">
      <span>{m.recordCount(count)}</span>
      <Space>
        <Button disabled={loading || page === 1} onClick={() => onChange(page - 1)}>
          {m.previous}
        </Button>
        <span>{page}</span>
        <Button disabled={loading || count < 15} onClick={() => onChange(page + 1)}>
          {m.next}
        </Button>
      </Space>
    </div>
  );
}
export function EmploymentRecords({ employeeId }: { employeeId: string }) {
  const [page, setPage] = useState(1);
  const object = 'TenantBase.EmploymentRecord';
  const permission = usePermissions(object);
  const allowed = permission.snapshot.objects[object]?.viewableFields ?? [];
  const result = useRead<PageResult<Row>>(
    `/api/tenant/employment/employees/${encodeURIComponent(employeeId)}` + `/records?page=${page}&pageSize=15`,
  );
  return (
    <>
      <DecisionNote id="personnel-records" />
      <p className="staff-muted">{m.chainHint}</p>
      <ReadPanel {...result} empty={!result.data?.items.length && m.noRecords}>
        <div className="staff-records">
          {(result.data?.items ?? []).map((row) => (
            <section className="staff-record" key={row.id}>
              <header>
                <strong>
                  {allowed.includes('kind') ? (m.kinds[String(row.kind)] ?? displayValue(row.kind)) : m.records}
                </strong>
                <span>
                  {recordPeriod({
                    effectiveDate: allowed.includes('effectiveDate') ? row.effectiveDate : undefined,
                    stopDate: allowed.includes('stopDate') ? row.stopDate : undefined,
                  })}
                </span>
                {allowed.includes('isCurrent') && typeof row.isCurrent === 'boolean' && (
                  <Tag color={row.isCurrent ? 'blue' : 'default'}>{row.isCurrent ? m.current : m.historical}</Tag>
                )}
              </header>
              <FieldGrid row={row} allowed={allowed} fields={['staffId', 'entryDate', 'employeeStatus']} />
              <FieldGrid
                row={(row.fields ?? {}) as Record<string, unknown>}
                allowed={allowed}
                fields={['departmentId', 'companyId', 'postId', 'positionId', 'levelId', 'directManagerId']}
              />
            </section>
          ))}
        </div>
      </ReadPanel>
      <p className="staff-muted">{m.referenceHint}</p>
      <PageButtons page={page} count={result.data?.items.length ?? 0} loading={result.loading} onChange={setPage} />
    </>
  );
}

function SubsetRows({
  id,
  employeeId,
  kind,
  allowed,
}: {
  id: string;
  employeeId: string;
  kind: ProfileSubset;
  allowed: readonly string[];
}) {
  const [page, setPage] = useState(1);
  const definition = SUBSETS[kind];
  const result = useRead<PageResult<Row>>(
    `/api/tenant/personnel/employees/${encodeURIComponent(employeeId)}` + `/subsets/${kind}?page=${page}&pageSize=15`,
  );
  const fields = definition.fields.map((field) => field.code).filter((key) => m.labels[key]);
  return (
    <section className="staff-section" id={id} aria-label={subsetLabels[kind]}>
      <h3 className="staff-section-title">{subsetLabels[kind]}</h3>
      <ReadPanel {...result} empty={!result.data?.items.length && m.noSubset(subsetLabels[kind])}>
        {(result.data?.items ?? []).map((row) => (
          <div className="staff-subset-row" key={row.id}>
            <FieldGrid row={row} fields={fields} allowed={allowed} />
          </div>
        ))}
      </ReadPanel>
      <PageButtons page={page} count={result.data?.items.length ?? 0} loading={result.loading} onChange={setPage} />
    </section>
  );
}
