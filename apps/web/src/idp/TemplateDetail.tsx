import { Alert, Descriptions, Empty, Table, Tag } from 'antd';
import { useState, type ReactNode } from 'react';
import { Failure, useRead } from '../evaluation/runtime.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { DetailPage } from '../foundation/templates.js';
import { IDP_API } from './api.js';
import { yesNo } from './listing.js';
import { t } from './messages.js';
import { display } from './model.js';
import type { Template, TemplateModule } from './types.js';

interface Props {
  id: string;
  processName(id?: string): string;
  orgName(id?: string | null): string;
  actions(row: Template): ReactNode;
  onClose(): void;
}
/** 模块对象里除这些通用键以外的属性按“字段设置”原样只读展示。 */
const MODULE_KEYS = new Set(['id', 'moduleType', 'name', 'description', 'displayOrder']);

/** 模板详情：基本信息 + IDP模块（左列表、右设置）+ 通用目标；模块与字段设置本期只读（后端缺口）。 */
export function TemplateDetailDrawer({ id, processName, orgName, actions, onClose }: Props) {
  const detail = useRead<Template>(`${IDP_API}/templates/${id}`);
  const template = detail.data;
  if (!template)
    return (
      <DetailPage
        open
        title={t.templates}
        onClose={onClose}
        summary={detail.error ? <Failure error={detail.error} retry={detail.reload} /> : <PageState kind="loading" />}
      />
    );
  return (
    <DetailPage
      open
      title={display(template.name)}
      onClose={onClose}
      actions={actions(template)}
      summary={
        <>
          <DecisionNote id="idp-templates" />
          {template.referenced && <Alert type="warning" showIcon message={t.referenced} />}
        </>
      }
      sections={[
        {
          key: 'basic',
          title: t.sections.basic,
          children: (
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: 'name', label: t.fields.templateName, children: display(template.name) },
                {
                  key: 'status',
                  label: t.fields.templateState,
                  children: t.templateStatus[template.status ?? ''] ?? t.noValue,
                },
                { key: 'process', label: t.fields.processId, children: processName(template.processId) },
                { key: 'org', label: t.fields.orgId, children: orgName(template.orgId) },
                { key: 'publicDown', label: t.fields.publicDownQuestion, children: yesNo(template.publicDown) },
                { key: 'description', label: t.fields.description, children: display(template.description) },
              ]}
            />
          ),
        },
        { key: 'modules', title: t.sections.modules, children: <Modules modules={template.modules ?? []} /> },
        {
          key: 'common',
          title: t.sections.common,
          children: (
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
          ),
        },
      ]}
    />
  );
}

function Modules({ modules }: { modules: TemplateModule[] }) {
  const sorted = [...modules].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  const [active, setActive] = useState(sorted[0]?.id);
  const current = sorted.find((module) => module.id === active) ?? sorted[0];
  if (!current) return <Empty description={t.empty} />;
  const settings = Object.entries(current).filter(([key]) => !MODULE_KEYS.has(key));
  return (
    <>
      <Alert type="info" showIcon message={t.readonlyTemplate} />
      <div className="idp-template-detail">
        <ul className="idp-module-list" aria-label={t.sections.modules}>
          {sorted.map((module) => (
            <li key={module.id} className={module.id === current.id ? 'active' : undefined}>
              <button type="button" onClick={() => setActive(module.id)}>
                {module.name}
              </button>
            </li>
          ))}
        </ul>
        <div>
          <h3>
            {current.name} <Tag>{t.moduleTypes[current.moduleType] ?? current.moduleType}</Tag>
          </h3>
          <Descriptions
            size="small"
            column={1}
            title={t.sections.settings}
            items={[
              { key: 'description', label: t.fields.description, children: display(current.description) },
              ...settings.map(([key, value]) => ({ key, label: key, children: settingText(value) })),
            ]}
          />
        </div>
      </div>
    </>
  );
}
function settingText(value: unknown): string {
  if (value === null || value === undefined || value === '') return t.noValue;
  if (typeof value === 'boolean') return value ? t.open : t.closed;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}
