import { Descriptions, Table } from 'antd';
import type { ApprovalNode } from '@italent/domain';
import { usePermissions } from '../../foundation/Permissions.js';
import { processObject, type VersionView } from './model.js';
import { m } from './messages.js';

const display = (value: unknown): string => {
  if (value === undefined) return m.unread;
  if (value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  if (Array.isArray(value)) return value.map(display).join('、') || m.none;
  return String(value);
};
const displayEnum = (value: unknown): string =>
  Array.isArray(value) ? value.map(displayEnum).join('、') || m.none : (m.values[String(value)] ?? display(value));
export function Conditions({ version }: { version: VersionView }) {
  const permissions = usePermissions(processObject);
  if (!permissions.field('conditions').visible || !version.conditions) return null;
  return (
    <details className="flow-read-config">
      <summary>{m.conditions}</summary>
      <p>
        {m.expression}：{display(version.conditions.expression)}
      </p>
      <Table
        size="small"
        rowKey="no"
        pagination={false}
        dataSource={version.conditions.items}
        columns={[
          { title: m.conditionField, dataIndex: 'field', render: display },
          { title: m.operator, dataIndex: 'operator', render: displayEnum },
          { title: m.value, dataIndex: 'value', render: display },
        ]}
      />
    </details>
  );
}
export function OtherNodeProperties({ node }: { node: ApprovalNode }) {
  const properties: [string, unknown][] = [
    [m.same, node.sameAssigneeSkip],
    [m.sameResult, displayEnum(node.sameAssigneeResult)],
    [m.history, node.historySameAssigneeSkip],
    [m.historyResult, displayEnum(node.historySameAssigneeResult)],
    [m.formFields, node.formFields],
    [m.editableFields, node.editableFields],
    [m.editMode, displayEnum(node.editMode)],
    [m.resubmit, displayEnum(node.rejectResubmit)],
    [m.exits, displayEnum(node.exits)],
  ];
  if (node.kind === 'countersign') {
    properties.push([m.transition, displayEnum(node.transitionRule?.type)]);
    for (const [exit, rule] of Object.entries(node.transitionRule?.rules ?? {}))
      properties.push([`${m.transition} · ${displayEnum(exit)}`, `${displayEnum(rule.kind)} ${rule.value}`]);
  }
  return (
    <details className="flow-read-config">
      <summary>{m.rules}</summary>
      <Descriptions
        size="small"
        column={1}
        items={properties.map(([label, value]) => ({ key: label, label, children: display(value) }))}
      />
      <h4>{m.messageRules}</h4>
      {node.messageRules ? (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={node.messageRules.map((rule, index) => ({ ...rule, key: String(index) }))}
          columns={[
            { title: m.trigger, dataIndex: 'trigger', render: displayEnum },
            { title: m.template, dataIndex: 'template', render: display },
            { title: m.channels, dataIndex: 'channels', render: displayEnum },
            { title: m.recipient, dataIndex: 'recipient', render: displayEnum },
          ]}
        />
      ) : (
        m.unread
      )}
    </details>
  );
}
