import { Alert, Button, Space, Tooltip } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Can, DecisionNote, useSession } from '../foundation/index.js';
import { TransferApplication } from '../self-service/shared/TransferApplication.js';
import { listText as t, text as m } from './messages.js';
import {
  dropdownTools,
  enabledTools,
  isTransferView,
  toolLabels,
  transferBanners,
  transferTools,
  transferViews,
  type TransferTool,
  type TransferView,
} from './page-model.js';
import { ReferenceFrame } from './ReferenceView.js';
import { TransferList } from './TransferList.js';
import './transfer.css';
import './hr-transfer.css';

type FormKind = 'apply' | 'direct';
const isFormKind = (value: string | null): value is FormKind => value === 'apply' || value === 'direct';

/** 调动管理按原站：横向三个视图（?view=），“他人调动申请”“调动”在当前页打开全页表单（?form=）。 */
export function HrTransferPage() {
  return (
    <ReferenceFrame>
      <HrTransferContent />
    </ReferenceFrame>
  );
}
function HrTransferContent() {
  const [params, setParams] = useSearchParams();
  const value = params.get('view');
  const view: TransferView = isTransferView(value) ? value : 'progress';
  const form = params.get('form');
  if (isFormKind(form)) return <TransferFormPage kind={form} onBack={() => setParams({ view })} />;
  return (
    <section className="hr-transfer-page">
      <header className="transfer-list-head">
        <nav className="transfer-views" aria-label={t.views}>
          {transferViews.map((item) => (
            <Button
              key={item.key}
              type="text"
              aria-pressed={item.key === view}
              className={item.key === view ? 'transfer-view transfer-view-active' : 'transfer-view'}
              onClick={() => setParams({ view: item.key })}
            >
              {item.label}
            </Button>
          ))}
        </nav>
        <TransferToolbar view={view} onOpen={(kind) => setParams({ view, form: kind })} />
      </header>
      <DecisionNote id="transfer" />
      <TransferBanner key={view} view={view} />
      <TransferList key={view} view={view} />
    </section>
  );
}
/** 工具顺序按视图；只有他人调动申请、调动有现成表单，其余保留位置禁用（下拉项带箭头）。 */
function TransferToolbar({ view, onOpen }: { view: TransferView; onOpen(kind: FormKind): void }) {
  const className = (tool: TransferTool) => (dropdownTools.includes(tool) ? 'transfer-tool-dropdown' : undefined);
  return (
    <Space wrap>
      {transferTools[view].map((tool) =>
        isFormKind(tool) && enabledTools.includes(tool) ? (
          <Can key={tool} object="TenantBase.EmploymentRecord" button="Transfer.Hr">
            <Button type={tool === 'apply' ? 'primary' : 'default'} onClick={() => onOpen(tool)}>
              {toolLabels[tool]}
            </Button>
          </Can>
        ) : (
          <Tooltip key={tool} title={t.pendingTool}>
            <Button disabled className={className(tool)}>
              {toolLabels[tool]}
            </Button>
          </Tooltip>
        ),
      )}
    </Space>
  );
}
/** 原站浅蓝提示右侧可收起、可关闭；常见问题链接没有落地页，保留位置禁用。 */
function TransferBanner({ view }: { view: TransferView }) {
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const banner = transferBanners[view];
  if (!open) return null;
  return (
    <Alert
      type="info"
      className="transfer-banner"
      closable={{ 'aria-label': t.closeBanner }}
      onClose={() => setOpen(false)}
      message={
        <div className="transfer-banner-body">
          <div>
            {(collapsed ? banner.lines.slice(0, 1) : banner.lines).map((line) => (
              <p key={line}>{line}</p>
            ))}
            {!collapsed && (
              <Button type="link" disabled>
                {banner.link}
              </Button>
            )}
          </div>
          <Button type="link" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? t.expand : t.collapse}
          </Button>
        </div>
      }
    />
  );
}
/**
 * 原站“调动”“他人调动申请”都是当前页全页长表单；两个入口共用同一份申请表单，
 * 底部按钮由预览返回的 allowedActions 决定（直接调动 / 暂存 / 提交），这里不另造按钮。
 */
function TransferFormPage({ kind, onBack }: { kind: FormKind; onBack(): void }) {
  const session = useSession();
  return (
    <section className="hr-transfer-form-page">
      <header className="transfer-form-head">
        <h2>{toolLabels[kind]}</h2>
        <Button onClick={onBack}>{t.back}</Button>
      </header>
      <DecisionNote id="transfer-form" />
      <Alert type="info" message={m.formHint} showIcon />
      <Can object="TenantBase.EmploymentRecord" button="Transfer.Hr">
        <div className="legacy-page r1c-transfer-form">
          <TransferApplication
            key={`${session.tenantId}/${session.identityKey}`}
            tenantId={session.tenantId}
            initiator="hr"
            hrScope={JSON.stringify([session.tenantId, session.identityKey])}
          />
        </div>
      </Can>
    </section>
  );
}
