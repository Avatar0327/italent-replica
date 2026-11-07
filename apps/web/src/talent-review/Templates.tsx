import { Button, Input, Popover, Select, Space, type TableColumnsType } from 'antd';
import { useState, type ReactNode } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { ConfigList, dateTime, settingsColumn } from './ConfigList.js';
import { display, matchesFilters, templateWritable, type ReviewFilters } from './model.js';
import { tp, tr } from './messages.js';
import { ProjectOrgFilter } from './ProjectOrgFilter.js';
import { TemplatePage } from './TemplatePage.js';
import { objects, type ReviewRecord } from './types.js';
import { useCollection } from './useCollection.js';

const FLOW_OBJECT = 'TalentReview.Flow';
type Permission = ReturnType<typeof usePermissions>;

/**
 * 盘点模板（R3cd spec §2.6、§3.3）：列表点名称或“编辑”进入整页，不弹窗；整页只有第一步“基本信息”取证过。
 * 停用 / 启用 / 复制 / 删除原站未执行过，保留入口但不开放（DEC-774、DEC-812）。
 */
export function Templates() {
  const permission = usePermissions(objects.templates);
  const result = useCollection('templates', !!permission.snapshot.objects[objects.templates]);
  const [page, setPage] = useState<{ id?: string }>();
  if (page)
    return (
      <TemplatePage
        id={page.id}
        back={() => {
          setPage(undefined);
          result.refresh();
        }}
      />
    );
  return <TemplateList permission={permission} result={result} open={(id) => setPage({ id })} />;
}

function TemplateList({
  permission,
  result,
  open,
}: {
  permission: Permission;
  result: ReturnType<typeof useCollection>;
  open(id?: string): void;
}) {
  const session = useSession();
  const flowPermission = usePermissions(FLOW_OBJECT);
  const flows = useCollection('flows', !!flowPermission.snapshot.objects[FLOW_OBJECT]);
  const [filters, setFilters] = useState<ReviewFilters>({});
  const visible = (field: string) => permission.field(field).visible;
  // 流程目录读不到（无权或失败）时回显流程 ID，不猜名称。
  const flowName = (id: unknown) =>
    typeof id === 'string' ? display(flows.data.items.find((row) => row.id === id)?.name ?? id) : tr.missing;
  const columns = templateColumns({ visible, flowName, timezone: session.timezone, open, permission });
  return (
    <>
      <DecisionNote id="talent-review-templates" />
      <ConfigList
        className="review-template-list"
        title={tr.templates}
        selectable
        hideOnSinglePage
        actions={
          <>
            {permission.can('create', 'list') && (
              <Button type="primary" onClick={() => open()}>
                {tr.create}
              </Button>
            )}
            {[tp.disable, tp.enable].map((label) => (
              <Button key={label} disabled title={tr.unverified}>
                {label}
              </Button>
            ))}
          </>
        }
        filters={<TemplateFilters value={filters} change={setFilters} visible={visible} />}
        columns={columns}
        rows={result.data.items.filter((row) => matchesFilters(row, filters, visible))}
        loading={result.loading}
        error={result.error}
        retry={result.refresh}
        hasDataPermission={result.data.hasDataPermission}
      />
    </>
  );
}

/** 列与列宽按原站（R3cd spec §3.3）：复选 30 / 模板名称 148 / 流程·组织·公开 149 / 状态 119 / 创建人 139 / 创建时间 167。 */
function templateColumns(props: {
  visible(field: string): boolean;
  flowName(id: unknown): string;
  timezone?: string;
  open(id: string): void;
  permission: Permission;
}): TableColumnsType<ReviewRecord> {
  const { visible, flowName, timezone, open, permission } = props;
  const widths = { name: 148, flowId: 149, ownerOrgId: 149, downwardPublic: 149, enabled: 119, createdBy: 139 };
  const render: Record<string, (value: unknown, row: ReviewRecord) => ReactNode> = {
    name: (value, row) => (
      <Button type="link" onClick={() => open(row.id)}>
        {display(value)}
      </Button>
    ),
    flowId: flowName,
    enabled: (value) => (typeof value === 'boolean' ? (value ? tr.enabled : tr.disabled) : tr.missing),
    createdAt: (value) => dateTime(value, timezone),
  };
  const keys = [...Object.keys(widths), 'createdAt'] as (keyof typeof tp.columns)[];
  return [
    ...keys.filter(visible).map((key) => ({
      key,
      dataIndex: key,
      title: tp.columns[key],
      width: key === 'createdAt' ? 167 : widths[key as keyof typeof widths],
      ellipsis: true,
      render: render[key] ?? display,
      ...(key === 'name'
        ? { sorter: (a: ReviewRecord, b: ReviewRecord) => display(a.name).localeCompare(display(b.name), 'zh-CN') }
        : {}),
    })),
    {
      key: 'actions',
      title: tr.actions,
      width: 160,
      render: (_, row) => (
        <Space size={8}>
          <Button type="link" disabled title={tr.unverified}>
            {tp.copy}
          </Button>
          {templateWritable(row, permission.can) && (
            <Button type="link" onClick={() => open(row.id)}>
              {tr.update}
            </Button>
          )}
          <Button type="link" disabled title={tr.unverified}>
            {tp.remove}
          </Button>
        </Space>
      ),
    },
    settingsColumn(26),
  ];
}

function TemplateFilters({
  value,
  change,
  visible,
}: {
  value: ReviewFilters;
  change(value: ReviewFilters): void;
  visible(field: string): boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value.name);
  return (
    <Space size={12} wrap>
      {visible('name') && (
        <Popover
          trigger="click"
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            setDraft(value.name);
          }}
          content={
            <Space direction="vertical">
              <Input
                aria-label={tr.search}
                placeholder={tr.search}
                value={draft}
                allowClear
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button
                type="primary"
                onClick={() => {
                  change({ ...value, name: draft });
                  setOpen(false);
                }}
              >
                {tr.confirm}
              </Button>
            </Space>
          }
        >
          <Button size="small" type="text">
            {tr.fields.name} ▾
          </Button>
        </Popover>
      )}
      {visible('ownerOrgId') && (
        <ProjectOrgFilter
          value={value.ownerOrgIds ?? []}
          onChange={(ownerOrgIds) => change({ ...value, ownerOrgIds })}
        />
      )}
      {visible('enabled') && (
        <Select
          size="small"
          variant="borderless"
          allowClear
          className="review-filter-select"
          placeholder={tp.columns.enabled}
          value={value.enabled}
          onChange={(enabled?: boolean) => change({ ...value, enabled })}
          options={[
            { value: true, label: tr.enabled },
            { value: false, label: tr.disabled },
          ]}
        />
      )}
    </Space>
  );
}
