import { Descriptions, Empty, Space, Tag, Timeline, Button } from 'antd';
import { useState } from 'react';
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
export function BasicInfo({ row }: { row: Row }) {
  const permission = usePermissions(PERSONNEL_OBJECT);
  const allowed = permission.snapshot.objects[PERSONNEL_OBJECT]?.viewableFields ?? [];
  const sections = [
    {
      title: m.basic,
      fields: [
        'name',
        'code',
        'gender',
        'birthday',
        'age',
        'nationality',
        'nation',
        'marryCategory',
        'politicalStatus',
      ],
    },
    {
      title: m.contact,
      fields: [
        'mobilePhone',
        'email',
        'workEmail',
        'backupMail',
        'contactAddress',
        'emergencyContact',
        'emergencyPhone',
      ],
    },
    { title: m.education, fields: ['educationLevel', 'lastSchool', 'major', 'graduateDate'] },
    { title: m.dates, fields: ['employeeStatus', 'entryDate', 'firstEntryDate', 'latestEntryDate', 'lastWorkDate'] },
  ];
  return (
    <>
      {sections
        .filter((section) => section.fields.some((key) => allowed.includes(key)))
        .map((section) => (
          <section className="staff-section" key={section.title}>
            <h3 className="staff-section-title">{section.title}</h3>
            <FieldGrid row={row} fields={section.fields} allowed={allowed} />
          </section>
        ))}
    </>
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
        <span>{m.perPage}</span>
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
        <Timeline
          className="staff-timeline"
          items={(result.data?.items ?? []).map((row) => ({
            color: allowed.includes('isCurrent') && row.isCurrent === true ? 'green' : 'blue',
            children: (
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
                    <Tag color={row.isCurrent ? 'green' : 'default'}>{row.isCurrent ? m.current : m.historical}</Tag>
                  )}
                </header>
                <FieldGrid row={row} allowed={allowed} fields={['staffId', 'entryDate', 'employeeStatus']} />
                <FieldGrid
                  row={(row.fields ?? {}) as Record<string, unknown>}
                  allowed={allowed}
                  fields={['departmentId', 'companyId', 'postId', 'positionId', 'levelId', 'directManagerId']}
                />
              </section>
            ),
          }))}
        />
      </ReadPanel>
      <p className="staff-muted">{m.referenceHint}</p>
      <PageButtons page={page} count={result.data?.items.length ?? 0} loading={result.loading} onChange={setPage} />
    </>
  );
}

export function PersonnelSubsets({ employeeId }: { employeeId: string }) {
  const [selected, setKind] = useState<ProfileSubset>();
  const access = useSubsetAccess();
  if (access.loading) return <PageState kind="loading" />;
  if (access.error) return <PageState kind="error" error={access.error} retry={access.refresh} />;
  const kinds = Object.keys(access.data ?? {}) as ProfileSubset[];
  const kind = selected && kinds.includes(selected) ? selected : kinds[0];
  if (!kind) return <PageState kind="forbidden" />;
  return (
    <div className="staff-subsets">
      <div className="staff-subset-content">
        <SubsetRows
          key={`${employeeId}/${kind}`}
          employeeId={employeeId}
          kind={kind}
          allowed={access.data![kind]!.viewableFields}
        />
      </div>
      <nav aria-label={m.subsets}>
        {kinds.map((key) => (
          <Button
            type="text"
            className={key === kind ? 'is-active' : ''}
            aria-current={key === kind ? 'page' : undefined}
            key={key}
            onClick={() => setKind(key as keyof typeof subsetLabels)}
          >
            {subsetLabels[key]}
          </Button>
        ))}
      </nav>
    </div>
  );
}
function SubsetRows({
  employeeId,
  kind,
  allowed,
}: {
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
    <section className="staff-section">
      <h3 className="staff-section-title">{subsetLabels[kind]}</h3>
      <ReadPanel {...result} empty={!result.data?.items.length && m.noSubsets}>
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
