import { Button, Input, Space, type TableColumnsType } from 'antd';
import { useState, type ReactNode } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import type { Values } from '../foundation/forms/store.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { base, readLatest } from './api.js';
import { ConfigList, dateTime, settingsColumn } from './ConfigList.js';
import { checkReceipt, configWritable, display, enabledText } from './model.js';
import { cr, tr } from './messages.js';
import { objects, type ReviewRecord } from './types.js';
import { useCollection } from './useCollection.js';

const COLLECTION = `${base}/calc-rules`;
const OBJECT = objects['calc-rules'];
type Permission = ReturnType<typeof usePermissions>;

/**
 * 盘点计算规则（R3cd spec §2.6、§3.3）：列表无筛选、无复选、无排序，分页常显。状态原站有草稿 / 启用 / 停用，
 * 后端只有 enabled，不从 enabled 伪造草稿。新增须带计算项目（公式），启停原站未执行，复制无后端接口：入口保留但禁用。
 */
export function CalcRules() {
  const session = useSession();
  const permission = usePermissions(OBJECT);
  const result = useCollection('calc-rules', !!permission.snapshot.objects[OBJECT]);
  const [editing, setEditing] = useState<ReviewRecord>();
  const columns = calcRuleColumns({
    visible: (field) => permission.field(field).visible,
    timezone: session.timezone,
    permission,
    edit: setEditing,
  });
  return (
    <>
      <DecisionNote id="talent-review-calc-rules" />
      <ConfigList
        className="review-calc-rule-list"
        title={tr['calc-rules']}
        actions={
          <Button type="primary" disabled title={tr.unverified}>
            {tr.create}
          </Button>
        }
        columns={columns}
        rows={result.data.items}
        loading={result.loading}
        error={result.error}
        retry={result.refresh}
        hasDataPermission={result.data.hasDataPermission}
      />
      {editing && (
        <CalcRuleForm
          record={editing}
          permission={permission}
          close={() => setEditing(undefined)}
          saved={result.refresh}
        />
      )}
    </>
  );
}

/** 列宽按原站（R3cd spec §3.3）：规则名 211 / 应用说明 211 / 状态 181 / 创建人 201 / 最近一次修改时间 229 / 操作 160 / 齿轮 24。 */
function calcRuleColumns(props: {
  visible(field: string): boolean;
  timezone?: string;
  permission: Permission;
  edit(row: ReviewRecord): void;
}): TableColumnsType<ReviewRecord> {
  const { visible, timezone, permission, edit } = props;
  const widths = { name: 211, description: 211, enabled: 181, createdBy: 201, updatedAt: 229 };
  const render: Record<string, (value: unknown) => ReactNode> = {
    // 规则名原站蓝色；点规则名的行为未取证，不做成入口（编辑走操作列）。
    name: (value) => <span className="review-name-text">{display(value)}</span>,
    enabled: enabledText,
    updatedAt: (value) => dateTime(value, timezone),
  };
  const keys = Object.keys(widths) as (keyof typeof widths)[];
  return [
    ...keys.filter(visible).map((key) => ({
      key,
      dataIndex: key,
      title: cr.columns[key],
      width: widths[key],
      ellipsis: true,
      render: render[key] ?? display,
    })),
    {
      key: 'actions',
      title: tr.actions,
      width: 160,
      render: (_, row) => (
        <Space size={8}>
          {configWritable(row, permission.can) && (
            <Button type="link" onClick={() => edit(row)}>
              {cr.edit}
            </Button>
          )}
          <Button type="link" disabled title={tr.unverified}>
            {row.enabled === false ? tr.enabled : tr.disabled}
          </Button>
          <Button type="link" disabled title={tr.unavailable}>
            {cr.copy}
          </Button>
        </Space>
      ),
    },
    settingsColumn(24),
  ];
}

/**
 * 行编辑基础弹窗（R3cd spec §2.6）：只含规则名、应用说明；公式与输出条件未取证，不进弹窗、不随补丁发送。
 * 保存走表单提交内核：补丁只带改过的字段，If-Match 用记录版本，409 重读核对，回执不前进或网络失败按结果未知锁定。
 */
function CalcRuleForm(props: { record: ReviewRecord; permission: Permission; close(): void; saved(): void }) {
  const { record, permission, close, saved } = props;
  const api = useApiClient();
  // 未确认命令按稳定原单路径存槽（DEC-502① e）；FormCommands 在 TalentReviewPage 根部，切页签后仍锁定。
  const command = useCommandForm(slotKey(COLLECTION, record.id));
  const submission = {
    ...command,
    reload: () => command.reread(readLatest(api, COLLECTION, record.id)),
  };
  const fields = calcRuleFields(permission, record);
  return (
    <FormOverlay
      open
      mode="modal"
      className="review-calc-rule-form"
      recordKey={record.id}
      submission={submission}
      title={cr.edit}
      titleExtra={
        <Space>
          {[cr.translate, cr.configure].map((label) => (
            <Button key={label} size="small" disabled title={tr.unverified}>
              {label}
            </Button>
          ))}
        </Space>
      }
      initialValues={record}
      groups={[{ title: tr.basic, fields }]}
      onClose={() => {
        // 冲突或结果未知时关掉：刷新列表回查，重开仍按原单槽锁定，不另起命令。
        if (command.state && command.state.status !== 'done') saved();
        close();
      }}
      onSubmit={async (values) => {
        const result = await command.submit({
          values,
          baseline: record,
          editableFields: fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name),
          revision: record.revision ?? 0,
          businessId: record.id,
          patchOnly: true,
          send: async (sent) => {
            const receipt = await api.request<ReviewRecord>(`${COLLECTION}/${record.id}`, {
              method: 'PATCH',
              command: { ...sent, body: normalize(sent.body) },
            });
            return checkReceipt(receipt, record.id, sent.revision);
          },
        });
        if (result.status !== 'done') throw result.error ?? new Error(tr.unknown);
        command.clear();
        saved();
      }}
    />
  );
}

/** 名称去首尾空格；清空的应用说明显式发 null（后端 description 可为 null）。 */
function normalize(body: Values) {
  const next = { ...body };
  if (typeof next.name === 'string') next.name = next.name.trim();
  if ('description' in next && !next.description) next.description = null;
  return next;
}

/**
 * 规则名必填、最多 50（后端 trim 后 1～50）；应用说明原站计数 0/200，后端上限 500：
 * 只校验用户改过的值，超过 200 的旧说明未改动时照常放行（不截断、不阻断其他字段保存）。
 */
function calcRuleFields(permission: Permission, record: ReviewRecord): FormField[] {
  const access = (name: string) => permission.field(name);
  const count = { formatter: ({ count }: { count: number }) => `${count}/200` };
  return [
    {
      name: 'name',
      label: cr.columns.name,
      access: access('name'),
      control: <Input maxLength={50} />,
      rules: [
        { required: true, whitespace: true, message: tr.required },
        { max: 50, message: tr.nameRule },
      ],
    },
    {
      name: 'description',
      label: cr.columns.description,
      access: access('description'),
      control: <Input.TextArea rows={4} showCount={count} />,
      rules: [
        {
          validator: (_, value: unknown) =>
            typeof value === 'string' && value.length > 200 && value !== record.description
              ? Promise.reject(new Error(cr.descriptionMax))
              : Promise.resolve(),
        },
      ],
    },
  ];
}
