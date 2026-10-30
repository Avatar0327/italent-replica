import { Avatar, Space } from 'antd';
import type { ReactNode } from 'react';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { DetailPage } from '../foundation/templates.js';
import { ReadPanel } from './ReadPanel.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useRead } from './useRead.js';
import { EditPersonButton } from './EditCommands.js';
import { EmploymentRecords, PersonnelProfile } from './ProfileSections.js';
import { displayValue, type Row } from './model.js';
import { m } from './messages.js';
import { EmployeePartTimes } from '../part-time/EmployeePartTimes.js';
import { m as partTime } from '../part-time/messages.js';

/** actions：业务模块挂在详情顶部的入口（如实习生，FE-R2d3），详情本身不变。 */
export function StaffDetail({
  employeeId,
  onClose,
  actions,
}: {
  employeeId: string;
  onClose(): void;
  actions?: ReactNode;
}) {
  const result = useRead<Row>(`/api/tenant/personnel/employees/${encodeURIComponent(employeeId)}`);
  const permission = usePermissions(PERSONNEL_OBJECT);
  const row = result.data;
  const name = permission.field('name').visible && row ? displayValue(row.name) : m.detail;
  return (
    <DetailPage
      open
      onClose={onClose}
      title={m.detail}
      actions={
        <>
          <EditPersonButton employeeId={employeeId} saved={result.refresh} />
          {actions}
        </>
      }
      summary={
        <>
          <DecisionNote id="personnel-records" />
          <ReadPanel {...result}>
            <div className="staff-profile-heading">
              <Avatar shape="square" size={64}>
                {name.slice(0, 1)}
              </Avatar>
              <div>
                <h2>{name}</h2>
                <Space>
                  {permission.field('code').visible && (
                    <span>
                      {m.jobNumber}：{displayValue(row?.code)}
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
          </ReadPanel>
        </>
      }
      tabs={
        row
          ? [
              { key: 'profile', label: m.profile, children: <PersonnelProfile row={row} employeeId={employeeId} /> },
              { key: 'records', label: m.records, children: <EmploymentRecords employeeId={employeeId} /> },
              { key: 'part-time', label: partTime.profileTab, children: <EmployeePartTimes employeeId={employeeId} /> },
            ]
          : undefined
      }
    />
  );
}
