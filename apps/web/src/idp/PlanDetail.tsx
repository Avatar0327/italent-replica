import { Alert, Button, Descriptions, Empty, Space, Steps, Table, Tag } from 'antd';
import type { ReactNode } from 'react';
import { idpDemoBasic, idpDemoReview } from '../demo-stubs/idp.js';
import { Failure, useRead } from '../evaluation/runtime.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { DetailPage, type DetailSection } from '../foundation/templates.js';
import { IDP_API } from './api.js';
import type { InterventionKind } from './Interventions.js';
import { t } from './messages.js';
import { display, period, planActions, type PlanAction } from './model.js';
import type { KeyInfoRow, PlanDetail, PlanGoal, PlanModule, PlanSummary, Stage } from './types.js';
import { useNames } from './useNames.js';

interface Props {
  id: string;
  onClose(): void;
  can(action: PlanAction): boolean;
  edit(plan: PlanSummary): void;
  intervene(kind: InterventionKind, plan: PlanSummary): void;
}
/** 详情动作：编辑、开始、跳转、转交（原站转交只在详情发起）与删除；按状态 ∩ 授权给出。 */
const DETAIL_ACTIONS: readonly PlanAction[] = ['update', 'start', 'jump', 'transfer', 'delete'];

export function PlanDetailDrawer({ id, onClose, can, edit, intervene }: Props) {
  const detail = useRead<PlanDetail>(`${IDP_API}/plans/${id}`);
  const plan = detail.data;
  const names = useNames('employee', [plan?.employeeId, plan?.tutorEmployeeId]);
  if (!plan)
    return (
      <DetailPage
        open
        title={t.plans}
        onClose={onClose}
        summary={detail.error ? <Failure error={detail.error} retry={detail.reload} /> : <PageState kind="loading" />}
      />
    );
  const actions = planActions(plan, can).filter((action) => DETAIL_ACTIONS.includes(action));
  return (
    <DetailPage
      open
      title={display(plan.name)}
      onClose={onClose}
      actions={
        <Space>
          {actions.map((action) => (
            <Button
              key={action}
              type={action === 'update' ? 'primary' : 'default'}
              danger={action === 'delete'}
              onClick={() => (action === 'update' ? edit(plan) : intervene(action as InterventionKind, plan))}
            >
              {action === 'update' ? t.actions.edit : t.actions[action]}
            </Button>
          ))}
        </Space>
      }
      summary={
        <>
          <DecisionNote id="idp-plan-detail" />
          <Descriptions
            size="small"
            column={3}
            items={[
              { key: 'employee', label: t.fields.employeeId, children: names(plan.employeeId) },
              { key: 'status', label: t.fields.status, children: t.status[plan.status ?? ''] ?? t.noValue },
              { key: 'period', label: t.fields.period, children: period(plan.startDate, plan.endDate) },
              { key: 'role', label: t.fields.tutorRole, children: t.tutorRoles[plan.tutorRole ?? ''] ?? t.noValue },
              { key: 'tutor', label: t.fields.tutorEmployeeId, children: names(plan.tutorEmployeeId) },
              { key: 'node', label: t.fields.currentNodeName, children: display(plan.currentNodeName) },
            ]}
          />
        </>
      }
      sections={sections(plan)}
    />
  );
}

/** 模块按模板顺序展示；模块字段不可见时退回到阶段、目标、关键信息三块真实数据。 */
function sections(plan: PlanDetail): DetailSection[] {
  const result: DetailSection[] = [];
  if (plan.stages?.length)
    result.push({ key: 'stages', title: t.sections.stages, children: <StageSteps stages={plan.stages} /> });
  const modules = [...(plan.modules ?? [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  const fallback: PlanModule[] = [
    { id: 'goal', moduleType: 'goal', name: t.sections.goals },
    { id: 'key_info', moduleType: 'key_info', name: t.sections.keyInfo },
  ];
  for (const module of modules.length ? modules : fallback)
    result.push({ key: module.id, title: module.name, children: <ModuleBody plan={plan} module={module} /> });
  return result;
}

function ModuleBody({ plan, module }: { plan: PlanDetail; module: PlanModule }) {
  if (module.moduleType === 'basic') return <DemoBlock note={t.demoBasic} rows={idpDemoBasic} />;
  if (module.moduleType === 'talent_review') return <DemoBlock note={t.demoReview} rows={idpDemoReview} />;
  if (module.moduleType === 'key_info') return <KeyInfo info={plan.keyInfo} />;
  if (module.moduleType === 'goal')
    return (
      <Goals
        goals={(plan.goals ?? []).filter((goal) => !goal.moduleId || !plan.modules || goal.moduleId === module.id)}
      />
    );
  // 回顾 / 总结 / 综述的填写属于参与人流程（R3d-2 只读展示模块说明）
  return <p className="idp-muted">{module.description || t.moduleReadonly}</p>;
}

function StageSteps({ stages }: { stages: Stage[] }) {
  const sorted = [...stages].sort((a, b) => a.seq - b.seq);
  const status = { pending: 'wait', running: 'process', ended: 'finish', failed: 'error' } as const;
  return (
    <Steps
      size="small"
      current={Math.max(
        0,
        sorted.findIndex((stage) => stage.status === 'running'),
      )}
      items={sorted.map((stage) => ({
        title: stage.name,
        status: status[stage.status],
        description: stage.failureReason ?? t.stageStatus[stage.status],
      }))}
    />
  );
}

/** 合成样例与真实数据分块展示并标注“演示数据”（DEC-494 L2）。 */
function DemoBlock({ note, rows }: { note: string; rows: { label: string; value: string }[] }) {
  return (
    <div className="idp-demo">
      <DecisionNote id="idp-demo" />
      <Alert type="warning" showIcon message={<Tag color="orange">{t.demo}</Tag>} description={note} />
      <Descriptions
        size="small"
        column={2}
        items={rows.map((row) => ({ key: row.label, label: row.label, children: row.value }))}
      />
    </div>
  );
}

function Goals({ goals }: { goals: PlanGoal[] }) {
  if (!goals.length) return <Empty description={t.noGoals} />;
  return (
    <div className="idp-goals">
      {goals.map((goal) => (
        <article key={goal.id} className="idp-goal">
          <h3>{display(goal.name)}</h3>
          <Descriptions
            size="small"
            column={2}
            items={[
              { key: 'measure', label: t.measure, children: display(goal.measure) },
              {
                key: 'period',
                label: t.fields.period,
                children: period(goal.startDate ?? undefined, goal.endDate ?? undefined),
              },
            ]}
          />
          {!!goal.tasks?.length && (
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={goal.tasks}
              columns={[
                { key: 'name', title: t.tasks, render: (_, task) => display(task.name) },
                {
                  key: 'period',
                  title: t.fields.period,
                  render: (_, task) => period(task.startDate ?? undefined, task.endDate ?? undefined),
                },
              ]}
            />
          )}
        </article>
      ))}
    </div>
  );
}

const HIDDEN_KEYS = ['id', 'revision', 'tenantId', 'planId', 'createdAt', 'updatedAt'];
function KeyInfo({ info }: { info?: PlanDetail['keyInfo'] }) {
  const blocks = (['careers', 'tutorships', 'workShifts'] as const).filter((key) => info?.[key]?.length);
  if (!blocks.length) return <Empty description={t.empty} />;
  return (
    <>
      {blocks.map((key) => (
        <div key={key} className="idp-key-info">
          <h3>{t.keyInfo[key]}</h3>
          <KeyInfoTable rows={info![key]!} />
        </div>
      ))}
    </>
  );
}
function KeyInfoTable({ rows }: { rows: KeyInfoRow[] }) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !HIDDEN_KEYS.includes(key));
  const people = useNames(
    'employee',
    rows.flatMap((row) => keys.filter((key) => key.endsWith('EmployeeId')).map((key) => row[key] as string)),
  );
  const render = (key: string, value: unknown): ReactNode =>
    key.endsWith('EmployeeId') ? people(value as string) : display(Array.isArray(value) ? value.join('、') : value);
  return (
    <Table
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      columns={keys.map((key) => ({
        key,
        title: t.keyInfoFields[key] ?? key,
        render: (_: unknown, row: KeyInfoRow) => render(key, row[key]),
      }))}
    />
  );
}
