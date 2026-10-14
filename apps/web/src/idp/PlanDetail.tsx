import { Alert, Button, Collapse, Descriptions, Empty, Space, Steps, Table, Tag, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { idpDemoBasic, idpDemoReview } from '../demo-stubs/idp.js';
import { Failure, useRead } from '../evaluation/runtime.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { useApiClient } from '../foundation/Session.js';
import { groupByOwner } from './access.js';
import { IDP_API, useCommand } from './api.js';
import type { InterventionKind } from './Interventions.js';
import { CommandNotice } from './listing.js';
import { t } from './messages.js';
import { display, period, planActions, statusText, taskActions, type PlanAction, type TaskAction } from './model.js';
import { GoalTasks, type TaskWriter } from './PlanTasks.js';
import type { KeyInfoRow, PlanDetail, PlanGoal, PlanModule, PlanSummary, Stage } from './types.js';
import { useNames } from './useNames.js';

interface Props {
  id: string;
  onBack(): void;
  can(action: PlanAction): boolean;
  edit(plan: PlanSummary): void;
  intervene(kind: InterventionKind, plan: PlanSummary): void;
}
/** 详情动作：编辑、开始、跳转、转交（原站转交只在详情发起）与删除；按状态 ∩ 授权给出。 */
const DETAIL_ACTIONS: readonly PlanAction[] = ['update', 'start', 'jump', 'transfer', 'delete'];

/** 重读期间保留上一版内容，避免任务写入后整页闪回“加载中”。 */
function usePlan(id: string) {
  const detail = useRead<PlanDetail>(`${IDP_API}/plans/${id}`);
  const [shown, setShown] = useState<PlanDetail>();
  useEffect(() => {
    if (detail.data) setShown(detail.data);
  }, [detail.data]);
  return { ...detail, plan: detail.data ?? (detail.error ? undefined : shown) };
}

/**
 * 计划详情整页（原站 05）：标题为员工姓名，下方“计划 / 周期 / 指导人”，阶段进度条与当前步骤，
 * 模块按模板顺序折叠展开；任务的增删改按服务端返回的节点按钮开放（B2_05 / B2_06）。
 */
export function PlanDetailPage({ id, onBack, can, edit, intervene }: Props) {
  const api = useApiClient();
  const detail = usePlan(id);
  const plan = detail.plan;
  const names = useNames('employee', [plan?.employeeId, plan?.tutorEmployeeId]);
  const command = useCommand(`${IDP_API}/plans/${id}:task`, id, (planId) =>
    api.request<PlanDetail>(`${IDP_API}/plans/${planId}`),
  );
  const back = <Button onClick={onBack}>{t.back}</Button>;
  if (!plan)
    return (
      <section aria-label={t.plans} className="idp-detail">
        <header className="idp-detail-header">
          <h1>{t.plans}</h1>
          {back}
        </header>
        {detail.error ? <Failure error={detail.error} retry={detail.reload} /> : <PageState kind="loading" />}
      </section>
    );
  const writer: TaskWriter = { command, plan, saved: detail.reload };
  const modules = modulesOf(plan);
  const groups = planGroups(plan, modules);
  const unassigned = [groups.goals, groups.analyses, groups.reviews].some((group) => group.unassigned.length);
  return (
    <section aria-label={display(plan.name)} className="idp-detail">
      <header className="idp-detail-header">
        <div>
          <h1>{names(plan.employeeId)}</h1>
          <p className="idp-muted idp-plan-line">
            <span>{`${t.header.plan}${display(plan.name)}`}</span>
            <span>{`${t.header.period}${period(plan.startDate, plan.endDate)}`}</span>
            <span>{`${t.header.tutor}${plan.tutorEmployeeId ? names(plan.tutorEmployeeId) : t.noValue}`}</span>
          </p>
        </div>
        <Space>
          <DetailActions plan={plan} can={can} edit={edit} intervene={intervene} />
          {back}
        </Space>
      </header>
      <DecisionNote id="idp-plan-detail" />
      <Descriptions
        className="idp-detail-summary"
        size="small"
        column={3}
        items={[
          { key: 'status', label: t.fields.status, children: statusText(t.status, plan.status) },
          { key: 'role', label: t.fields.tutorRole, children: t.tutorRoles[plan.tutorRole ?? ''] ?? t.noValue },
          { key: 'node', label: t.fields.currentNodeName, children: display(plan.currentNodeName) },
        ]}
      />
      {!!plan.stages?.length && <StageSteps stages={plan.stages} />}
      <CommandNotice command={command} />
      <Collapse
        className="idp-detail-modules"
        defaultActiveKey={[...modules.map((module) => module.id), UNASSIGNED]}
        items={[
          ...modules.map((module) => ({
            key: module.id,
            label: module.name,
            children: <ModuleBody plan={plan} module={module} groups={groups} writer={writer} />,
          })),
          ...(unassigned
            ? [
                {
                  key: UNASSIGNED,
                  label: t.unassigned.title,
                  children: <Unassigned plan={plan} groups={groups} writer={writer} />,
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}

function DetailActions({
  plan,
  can,
  edit,
  intervene,
}: Pick<Props, 'can' | 'edit' | 'intervene'> & { plan: PlanSummary }) {
  const actions = planActions(plan, can).filter((action) => DETAIL_ACTIONS.includes(action));
  return actions.map((action) => (
    <Button
      key={action}
      type={action === 'update' ? 'primary' : 'default'}
      danger={action === 'delete'}
      onClick={() => (action === 'update' ? edit(plan) : intervene(action as InterventionKind, plan))}
    >
      {action === 'update' ? t.actions.edit : t.actions[action]}
    </Button>
  ));
}

/** 模块按模板顺序展示；模块字段不可见时只保留关键信息，目标、综述、回顾全部进“未归属”。 */
function modulesOf(plan: PlanDetail): PlanModule[] {
  const modules = [...(plan.modules ?? [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  if (modules.length) return modules;
  return [{ id: 'key_info', moduleType: 'key_info', name: t.sections.keyInfo }];
}

const UNASSIGNED = '__unassigned';
/**
 * 目标、综述、回顾按归属模块分组，统一走 groupByOwner（access.ts 二）：moduleId 被裁剪或指向不在场的模块时
 * 归入“未归属”，不因字段无权查看而整条消失（DEC-431①）。
 */
function planGroups(plan: PlanDetail, modules: PlanModule[]) {
  const ids = (...types: string[]) =>
    modules.filter((module) => types.includes(module.moduleType)).map((module) => module.id);
  return {
    goals: groupByOwner(plan.goals, (goal) => goal.moduleId, ids('goal')),
    analyses: groupByOwner(plan.analyses, (row) => row.moduleId, ids('analysis')),
    reviews: groupByOwner(plan.reviews, (row) => row.moduleId, ids('review', 'summary')),
  };
}
type Groups = ReturnType<typeof planGroups>;

function ModuleBody(props: { plan: PlanDetail; module: PlanModule; groups: Groups; writer: TaskWriter }) {
  const { plan, module, groups, writer } = props;
  if (module.moduleType === 'basic') return <DemoBlock note={t.demoBasic} rows={idpDemoBasic} />;
  if (module.moduleType === 'talent_review') return <DemoBlock note={t.demoReview} rows={idpDemoReview} />;
  if (module.moduleType === 'key_info') return <KeyInfo info={plan.keyInfo} />;
  if (module.moduleType === 'analysis') return <Analyses rows={groups.analyses.of(module.id)} />;
  if (module.moduleType === 'review' || module.moduleType === 'summary')
    return <Reviews rows={groups.reviews.of(module.id)} stages={plan.stages} />;
  if (module.moduleType === 'goal') {
    const { actions, reason } = taskActions(plan, module);
    return (
      <>
        {reason && <Typography.Paragraph type="secondary">{reason}</Typography.Paragraph>}
        <Goals goals={groups.goals.of(module.id)} writer={writer} actions={actions} />
      </>
    );
  }
  return <p className="idp-muted">{module.description || t.moduleReadonly}</p>;
}

/** 归属不明的内容单独列出；拿不到所属模块的节点按钮与“制定任务”开关，任务一律只读（失败即拒绝）。 */
function Unassigned({ plan, groups, writer }: { plan: PlanDetail; groups: Groups; writer: TaskWriter }) {
  const { goals, analyses, reviews } = groups;
  return (
    <section aria-label={t.unassigned.title}>
      <Typography.Paragraph type="secondary">{t.unassigned.note}</Typography.Paragraph>
      {!!goals.unassigned.length && <Goals goals={goals.unassigned} writer={writer} actions={[]} />}
      {!!analyses.unassigned.length && <Analyses rows={analyses.unassigned} />}
      {!!reviews.unassigned.length && <Reviews rows={reviews.unassigned} stages={plan.stages} />}
    </section>
  );
}

const text = (value: string | null | undefined) => (value ? value : t.noContent);
type AnalysisRow = NonNullable<PlanDetail['analyses']>[number];
type ReviewRow = NonNullable<PlanDetail['reviews']>[number];
/** 综述：现状分析、待发展项（plan-routes 详情 analyses）。 */
function Analyses({ rows }: { rows: AnalysisRow[] }) {
  if (!rows.length) return <Empty description={t.noContent} />;
  return rows.map((row, index) => (
    <Descriptions
      key={index}
      size="small"
      column={1}
      items={[
        { key: 'current', label: t.analysis.currentAnalysis, children: text(row.currentAnalysis) },
        { key: 'items', label: t.analysis.developmentItems, children: text(row.developmentItems) },
      ]}
    />
  ));
}

/** 回顾 / 总结：每个阶段一份总结与改进方法（plan-routes 详情 reviews，阶段名取自阶段进度；阶段被裁剪时显示无权查看）。 */
function Reviews({ rows, stages }: { rows: ReviewRow[]; stages?: Stage[] }) {
  if (!rows.length) return <Empty description={t.noContent} />;
  const stageName = (id?: string) => stages?.find((stage) => stage.id === id)?.name ?? t.noAccess;
  return rows.map((row, index) => (
    <Descriptions
      key={index}
      size="small"
      column={1}
      title={rows.length > 1 ? stageName(row.stageId) : undefined}
      items={[
        { key: 'summary', label: t.review.summary, children: text(row.summary) },
        { key: 'improvement', label: t.review.improvement, children: text(row.improvement) },
      ]}
    />
  ));
}

function StageSteps({ stages }: { stages: Stage[] }) {
  const sorted = [...stages].sort((a, b) => a.seq - b.seq);
  const status = { pending: 'wait', running: 'process', ended: 'finish', failed: 'error' } as const;
  return (
    <Steps
      className="idp-stage-steps"
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

function Goals({ goals, writer, actions }: { goals: PlanGoal[]; writer: TaskWriter; actions: TaskAction[] }) {
  if (!goals.length) return <Empty description={t.noGoals} />;
  return (
    <div className="idp-goals">
      {goals.map((goal, index) => (
        // id 被裁剪时退回序号作键；任务操作由 taskRowActions 按目标 id 关闭
        <article key={goal.id ?? `#${index}`} className="idp-goal">
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
          <GoalTasks goal={goal} writer={writer} actions={actions} />
        </article>
      ))}
    </div>
  );
}

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
  // 只展示有中文字段名的列，不回显接口键名
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !!t.keyInfoFields[key]);
  const people = useNames(
    'employee',
    rows.flatMap((row) => keys.filter((key) => key.endsWith('EmployeeId')).map((key) => row[key] as string)),
  );
  const render = (key: string, value: unknown): ReactNode => {
    if (key.endsWith('EmployeeId')) return people(value as string);
    return display(Array.isArray(value) ? value.join('、') : value);
  };
  return (
    <Table
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      columns={keys.map((key) => ({
        key,
        title: t.keyInfoFields[key],
        render: (_: unknown, row: KeyInfoRow) => render(key, row[key]),
      }))}
    />
  );
}
