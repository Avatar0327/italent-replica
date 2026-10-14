import { Button, Card, Empty, Tag } from 'antd';
import { useState } from 'react';
import { CreateCommands } from '../evaluation/CreateEntry.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { useSession } from '../foundation/Session.js';
import { ViewHeading } from '../foundation/ViewHeading.js';
import { IDP_API, useCollection } from './api.js';
import { t } from './messages.js';
import { display, period } from './model.js';
import { PlanDetailDrawer } from './PlanDetail.js';
import type { PlanSummary } from './types.js';
import './idp.css';

const STATUS_COLOR: Record<string, string> = { running: 'blue', ended: 'green', terminated: 'default' };

/**
 * 员工自助 > 我的发展计划：参与人列表（本人 / 指导人 / 当前审批人，K-30～K-32），固定字段。
 * 只读：参与人的填写与审批在审批中心完成，本页不给 HR 干预动作。
 */
export function MyPlansPage() {
  const session = useSession();
  return (
    <CreateCommands>
      <MyPlans key={`${session.tenantId}/${session.identityKey}`} />
    </CreateCommands>
  );
}
function MyPlans() {
  const list = useCollection<PlanSummary>(`${IDP_API}/my-plans`);
  const [openId, setOpenId] = useState<string>();
  const items = list.items ?? [];
  return (
    <div className="idp-page idp-my-plans">
      <header className="page-heading">
        <ViewHeading title={t.myPlans} />
        <Button onClick={list.reload}>{t.actions.refresh}</Button>
      </header>
      <DecisionNote id="idp-my-plans" />
      {list.error ? (
        <PageState kind="error" error={list.error} retry={list.reload} />
      ) : list.loading ? (
        <PageState kind="loading" />
      ) : !items.length ? (
        <Empty description={t.empty} />
      ) : (
        <div className="idp-card-grid">
          {items.map((plan) => (
            <Card key={plan.id} size="small" className="idp-plan-card">
              <Button type="link" className="idp-card-title" onClick={() => setOpenId(plan.id)}>
                {display(plan.name)}
              </Button>
              <Tag color={STATUS_COLOR[plan.status ?? '']}>{t.status[plan.status ?? ''] ?? t.noValue}</Tag>
              <dl>
                <dt>{t.fields.period}</dt>
                <dd>{period(plan.startDate, plan.endDate)}</dd>
                <dt>{t.fields.currentStageName}</dt>
                <dd>{display(plan.currentStageName)}</dd>
                <dt>{t.fields.currentNodeName}</dt>
                <dd>{display(plan.currentNodeName)}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
      {openId && (
        <PlanDetailDrawer
          id={openId}
          onClose={() => setOpenId(undefined)}
          can={() => false}
          edit={() => undefined}
          intervene={() => undefined}
        />
      )}
    </div>
  );
}
