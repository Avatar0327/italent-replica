import { Avatar, Space } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { DetailPage } from '../foundation/templates.js';
import { ReadPanel } from './ReadPanel.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { useRead } from './useRead.js';
import { EditPersonButton } from './EditCommands.js';
import { EmploymentRecords, PersonnelProfile } from './ProfileSections.js';
import { displayValue, type Row } from './model.js';
import { m } from './messages.js';
import { EmployeePartTimes } from '../part-time/EmployeePartTimes.js';
import { m as partTime } from '../part-time/messages.js';

/**
 * actions：业务模块挂在详情顶部的入口（如实习生，FE-R2d3），详情本身不变。
 * onSaved：抬头「编辑人员」保存后通知来源页刷新（员工列表的姓名等摘要，第 2 轮 P2-6）。
 * reload：来源页的重读信号（F-436），值一变就原位重读，见 useReloadedRow；不传时行为不变。
 */
export function StaffDetail({
  employeeId,
  onClose,
  actions,
  onSaved,
  reload,
}: {
  employeeId: string;
  onClose(): void;
  actions?: ReactNode;
  onSaved?(): void;
  reload?: number;
}) {
  const result = useRead<Row>(`/api/tenant/personnel/employees/${encodeURIComponent(employeeId)}`);
  const permission = usePermissions(PERSONNEL_OBJECT);
  const row = useReloadedRow(result, employeeId, reload);
  const name = permission.field('name').visible && row ? displayValue(row.name) : m.detail;
  return (
    <DetailPage
      open
      onClose={onClose}
      title={m.detail}
      actions={
        <>
          <EditPersonButton
            employeeId={employeeId}
            saved={() => {
              result.refresh();
              onSaved?.();
            }}
          />
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

/**
 * 来源页要求重读时（reload 变化，F-436 第 3 轮）原位重读档案，不换 key 重新挂载：抬头照旧由 ReadPanel 显示读取中 / 错误，
 * 重读进行中页签沿用同一会话、同一员工上一份已读到的档案，页签不卸载——「编辑人员」抽屉、页签内的子集 / 编辑任职 /
 * 兼岗表单及所在页签都保留，未提交输入不丢。重读失败（如已撤权 403）不再沿用旧档案，按当前权限收起页签。
 * 不传 reload 时与原来一样：没读到就不渲染页签。
 */
function useReloadedRow(
  result: { data?: Row; loading: boolean; refresh(): void },
  employeeId: string,
  reload?: number,
) {
  const session = useSession();
  const scope = JSON.stringify([session.tenantId, session.identityKey, employeeId]);
  const refresh = useRef(result.refresh);
  const seen = useRef(reload);
  useEffect(() => {
    refresh.current = result.refresh;
  });
  // 挂载时的值只记下（挂载本来就读）；StrictMode 重放 effect 时值未变，不多读
  useEffect(() => {
    if (seen.current === reload) return;
    seen.current = reload;
    refresh.current();
  }, [reload]);
  const [kept, keep] = useState<{ scope: string; row: Row }>();
  if (result.data && (kept?.row !== result.data || kept.scope !== scope)) keep({ scope, row: result.data });
  if (result.data || reload === undefined || !result.loading) return result.data;
  return kept?.scope === scope ? kept.row : undefined;
}
