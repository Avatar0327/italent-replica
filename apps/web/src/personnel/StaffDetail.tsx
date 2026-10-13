import { Avatar, Space } from 'antd';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { DetailPage } from '../foundation/templates.js';
import { PageState } from '../foundation/PageState.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useRead } from './useRead.js';
import { BasicInfo, EmploymentRecords, PersonnelSubsets } from './ProfileSections.js';
import { displayValue, type Row } from './model.js';
import { m } from './messages.js';

export function StaffDetail({ employeeId, onClose }: { employeeId: string; onClose(): void }) {
  const result = useRead<Row>(`/api/tenant/personnel/employees/${encodeURIComponent(employeeId)}`);
  const permission = usePermissions(PERSONNEL_OBJECT);
  const row = result.data;
  const name = permission.field('name').visible && row ? displayValue(row.name) : m.detail;
  return (
    <DetailPage
      open
      onClose={onClose}
      title={m.detail}
      summary={
        <>
          <DecisionNote id="personnel-records" />
          {result.loading ? (
            <PageState kind="loading" />
          ) : result.error ? (
            <PageState kind="error" error={result.error} retry={result.refresh} />
          ) : (
            <div className="staff-profile-heading">
              <Avatar shape="square" size={64}>
                {name.slice(0, 1)}
              </Avatar>
              <div>
                <h2>{name}</h2>
                <Space>
                  {permission.field('code').visible && (
                    <span>
                      {m.labels.code}：{displayValue(row?.code)}
                    </span>
                  )}
                  {permission.field('email').visible && (
                    <span>
                      {m.labels.email}：{displayValue(row?.email)}
                    </span>
                  )}
                </Space>
              </div>
            </div>
          )}
        </>
      }
      tabs={
        row
          ? [
              { key: 'basic', label: m.basic, children: <BasicInfo row={row} /> },
              { key: 'records', label: m.records, children: <EmploymentRecords employeeId={employeeId} /> },
              { key: 'subsets', label: m.subsets, children: <PersonnelSubsets employeeId={employeeId} /> },
            ]
          : undefined
      }
    />
  );
}
