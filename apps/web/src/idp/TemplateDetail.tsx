import { Alert, Button, Descriptions, Empty, Space, Table } from 'antd';
import { useState, type ReactNode } from 'react';
import { Failure, useRead } from '../evaluation/runtime.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { IDP_API } from './api.js';
import { yesNo } from './listing.js';
import { t } from './messages.js';
import { display, statusText } from './model.js';
import { moduleSettingSections, nodeLabeler, type NodeSetting } from './template-settings.js';
import type { ApprovalCandidate, Process, Template, TemplateModule } from './types.js';

interface Props {
  id: string;
  processName(id?: string): string;
  orgName(id?: string | null): string;
  actions(row: Template): ReactNode;
  onBack(): void;
}

/**
 * 模板详情整页（原站 B2_17）：头部“流程：xxx”与返回，引用提示，左侧 IDP模块列表、右侧中文配置分区，末尾通用目标。
 * 模块与字段设置本期只读（后端缺口）；节点按流程与审批目录解析成原站节点名。
 */
export function TemplateDetailPage({ id, processName, orgName, actions, onBack }: Props) {
  const detail = useRead<Template>(`${IDP_API}/templates/${id}`);
  const template = detail.data;
  const back = <Button onClick={onBack}>{t.back}</Button>;
  if (!template)
    return (
      <section aria-label={t.templates} className="idp-detail">
        <header className="idp-detail-header">
          <h1>{t.templates}</h1>
          {back}
        </header>
        {detail.error ? <Failure error={detail.error} retry={detail.reload} /> : <PageState kind="loading" />}
      </section>
    );
  return (
    <section aria-label={display(template.name)} className="idp-detail">
      <header className="idp-detail-header">
        <div>
          <h1>{display(template.name)}</h1>
          <p className="idp-muted">{t.processLine(processName(template.processId))}</p>
        </div>
        <Space>
          {actions(template)}
          {back}
        </Space>
      </header>
      <DecisionNote id="idp-templates" />
      {template.referenced && <Alert type="warning" showIcon message={t.referenced} />}
      <Descriptions
        className="idp-detail-summary"
        size="small"
        column={4}
        items={[
          { key: 'status', label: t.fields.templateState, children: statusText(t.templateStatus, template.status) },
          { key: 'org', label: t.fields.orgId, children: orgName(template.orgId) },
          { key: 'publicDown', label: t.fields.publicDownQuestion, children: yesNo(template.publicDown) },
          { key: 'description', label: t.fields.description, children: display(template.description) },
        ]}
      />
      <h2 className="idp-section-title">{t.sections.modules}</h2>
      <Modules modules={template.modules ?? []} processId={template.processId} />
      <h2 className="idp-section-title">{t.sections.common}</h2>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={template.commonGoals ?? []}
        locale={{ emptyText: t.noGoals }}
        columns={[
          { key: 'name', title: t.fields.name, render: (_, row) => display(row.name) },
          { key: 'measure', title: t.measure, render: (_, row) => display(row.measure) },
        ]}
      />
    </section>
  );
}

/** 节点名需要流程详情与审批目录；任一读取失败时退回“节点名称不可见”，不阻断配置展示。 */
function useNodeLabel(processId?: string): (setting: NodeSetting) => string {
  const process = useRead<Process>(processId ? `${IDP_API}/processes/${processId}` : undefined);
  const approvals = useRead<{ items?: ApprovalCandidate[] }>(`${IDP_API}/approval-processes`);
  return nodeLabeler(process.data?.subProcesses ?? [], approvals.data?.items ?? []);
}

function Modules({ modules, processId }: { modules: TemplateModule[]; processId?: string }) {
  const sorted = [...modules].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  const [active, setActive] = useState(sorted[0]?.id);
  const node = useNodeLabel(processId);
  const current = sorted.find((module) => module.id === active) ?? sorted[0];
  if (!current) return <Empty description={t.empty} />;
  return (
    <>
      <Alert type="info" showIcon message={t.readonlyTemplate} />
      <div className="idp-template-detail">
        <ul className="idp-module-list" aria-label={t.sections.modules}>
          {sorted.map((module) => (
            <li key={module.id} className={module.id === current.id ? 'active' : undefined}>
              <Button type="text" onClick={() => setActive(module.id)}>
                {module.name}
              </Button>
            </li>
          ))}
        </ul>
        <div className="idp-module-settings">
          {moduleSettingSections(current, node).map((section) => (
            <div key={section.title}>
              <h3>{section.title}</h3>
              <Descriptions
                size="small"
                column={1}
                items={section.items.map((item, index) => ({
                  key: `${index}`,
                  label: item.label,
                  children: item.value,
                }))}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
