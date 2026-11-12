import { codeText } from '../foundation/code-text.js';
import { Avatar, Space } from 'antd';
import { ApiError } from '../foundation/client.js';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
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
  initialTab,
}: {
  employeeId: string;
  onClose(): void;
  actions?: ReactNode;
  onSaved?(): void;
  reload?: number;
  /** 首次打开的页签（如任职记录列表的“编辑任职”直达任职记录页签）；默认人员信息 */
  initialTab?: 'profile' | 'records' | 'part-time';
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
      defaultTab={initialTab}
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
                      {m.jobNumber}：{codeText((row?.code as string | null) ?? null)}
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
      tabs={detailTabs(row, employeeId, result, initialTab !== undefined)}
    />
  );
}

/**
 * 页签。带 initialTab 的入口（任职记录列表的“编辑任职”）按任职记录自身权限独立加载：人员档案读取 403 / 失败时仍挂载页签，
 * 人员信息页签显示读取状态；不带 initialTab 的其它调用方仍是没读到档案就不渲染页签。
 */
function detailTabs(
  row: Row | undefined,
  employeeId: string,
  result: { loading: boolean; error?: unknown; refresh(): void },
  independent: boolean,
) {
  if (!row && !independent) return undefined;
  return [
    {
      key: 'profile',
      label: m.profile,
      children: row ? (
        <PersonnelProfile row={row} employeeId={employeeId} />
      ) : (
        <ReadPanel {...result}>{null}</ReadPanel>
      ),
    },
    { key: 'records', label: m.records, children: <EmploymentRecords employeeId={employeeId} /> },
    { key: 'part-time', label: partTime.profileTab, children: <EmployeePartTimes employeeId={employeeId} /> },
  ];
}

/**
 * 来源页要求重读时（reload 变化，F-436 第 3 轮）原位重读档案，不换 key 重新挂载：抬头照旧由 ReadPanel 显示读取中 / 错误，
 * 重读进行中页签沿用同一会话、同一员工上一份已读到的档案，页签不卸载——「编辑人员」抽屉、页签内的子集 / 编辑任职 /
 * 兼岗表单及所在页签都保留，未提交输入不丢。401 / 403 清掉旧档案并收起页签；临时失败保留输入，由抬头报错重试。
 * 不传 reload 时与原来一样：没读到就不渲染页签。
 */
function useReloadedRow(
  result: { data?: Row; loading: boolean; error?: unknown; refresh(): void },
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
  const kept = useRef<{ scope: string; row: Row } | undefined>(undefined);
  const denied = result.error instanceof ApiError && [401, 403].includes(result.error.status);
  // 只缓存已提交渲染的档案，不在渲染期写 state；未传 reload 不持缓存，也不多一次渲染。
  // 撤权或切会话立即丢弃缓存，避免点重试后 loading 分支再次显示撤权前档案。
  useLayoutEffect(() => {
    if (reload === undefined || denied || kept.current?.scope !== scope) kept.current = undefined;
    if (reload !== undefined && result.data && !denied) kept.current = { scope, row: result.data };
  }, [reload, denied, scope, result.data]);
  if (result.data || reload === undefined || denied) return result.data;
  return kept.current?.scope === scope ? kept.current.row : undefined;
}
