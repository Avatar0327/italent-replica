// F-127b 第 2 轮：规则页的自动续签开关与规则单条移序，都走 F-123 内核；第 3 轮起冲突恢复统一走 recovery.tsx。
import { Button, Switch, message } from 'antd';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { useApiClient } from '../foundation/Session.js';
import { slotKey } from '../foundation/forms/slot.js';
import { configFields, configLabels } from './ConfigForms.js';
import { parseSavedReceipt, parseSettingsReceipt } from './forms.js';
import { m } from './messages.js';
import { configAccess, configObjects, contractApi, type Row } from './model.js';
import { RecoveryStatus, useConfigCommand } from './recovery.js';
import { useRead } from './useRead.js';

type Read = ReturnType<typeof useRead<Row>>;

/** 规则页顶部的自动续签开关：读写的是合同设置对象，按该对象的数据操作与字段权限判断。 */
export function RenewalSection() {
  const permission = usePermissions(configObjects.settings);
  const object = permission.snapshot.objects[configObjects.settings];
  const settings = useRead<Row>(object ? contractApi.settings : null);
  const field = permission.field('autoRenew');
  return (
    <>
      <h2>{m.fields.autoRenew}</h2>
      <p>{m.renewalHint}</p>
      <RenewalSwitch
        settings={settings}
        visible={field.visible}
        editable={configAccess(object).update && field.editable}
      />
    </>
  );
}
/** 原站自动续签开关在规则页：按差异 PUT 合同设置 {autoRenew}，确认基线、重读与 If-Match 走 useConfigCommand。 */
function RenewalSwitch({ settings, visible, editable }: { settings: Read; visible: boolean; editable: boolean }) {
  const api = useApiClient();
  const data = settings.data;
  const tenantId = String(data?.tenantId ?? '');
  const { form, baseline, submit } = useConfigCommand(slotKey(contractApi.settings), {
    kind: 'settings',
    id: tenantId || undefined,
    row: data,
    keys: ['autoRenew'],
    action: 'autoRenew',
  });
  const current = baseline.autoRenew;
  const toggle = async (next: boolean) => {
    const result = await submit({
      values: { autoRenew: next },
      editableFields: ['autoRenew'],
      patchOnly: true,
      send: async (command, sent) =>
        parseSettingsReceipt(await api.request<unknown>(contractApi.settings, { method: 'PUT', command }), {
          tenantId,
          revision: sent,
        }),
    });
    if (result.status !== 'done') return;
    form.clear();
    settings.refresh();
  };
  if (settings.error) return <PageState kind="error" error={settings.error} retry={settings.refresh} />;
  if (!visible || typeof current !== 'boolean') return null;
  return (
    <div className="contract-renewal">
      <Switch
        aria-label={m.fields.autoRenew}
        checked={current}
        loading={form.busy}
        disabled={!editable || !tenantId || form.locked}
        onChange={(next) => void toggle(next)}
      />
      <RecoveryStatus form={form} labels={{ autoRenew: m.fields.autoRenew }} />
    </div>
  );
}

type Rank = { id: string; priority: number };
const rank = (row: Row): Rank => ({ id: String(row.id), priority: Number(row.priority) });
const order = (a: Rank, b: Rank) => a.priority - b.priority || a.id.localeCompare(b.id);
/**
 * 单条移序只改本条 priority（后端没有批量重排接口）：取让本条按“优先级、ID”排序后恰好与相邻一条换位的值。
 * 返回 undefined 表示没有相邻一条（不提供按钮）；null 表示本页内无法确认落位或相邻优先级没有空位，需批量重排。
 */
export function movePriority(rows: Row[], index: number, step: -1 | 1, edge: boolean): number | null | undefined {
  const pass = rows[index + step];
  if (!pass) return undefined;
  const beyond = rows[index + 2 * step];
  // 越过的那条之外还有本页以外的规则时，无法确认新值不会越过它。
  if (!beyond && !edge) return null;
  const self = rank(rows[index]!);
  const near = rank(pass);
  const candidates = [near.priority, near.priority + step, ...(beyond ? [rank(beyond).priority] : [])];
  const fits = (priority: number) => {
    const moved = { ...self, priority };
    const after = order(moved, near) * step > 0;
    return after && (!beyond || order(moved, rank(beyond)) * step < 0);
  };
  return candidates.find((priority) => Number.isInteger(priority) && priority >= 0 && fits(priority)) ?? null;
}

/** 上移 / 下移：对本条 PUT 完整请求体，只把 priority 换成算出的值；冲突重读核对后刷新列表重算位置。 */
export function RuleMove({
  row,
  up,
  down,
  onDone,
}: {
  row: Row;
  up?: number | null;
  down?: number | null;
  onDone(): void;
}) {
  const api = useApiClient();
  const id = String(row.id);
  const path = `${contractApi.rules}/${encodeURIComponent(id)}`;
  const keys = configFields.rules;
  const { form, baseline, submit } = useConfigCommand(slotKey(contractApi.rules, id), {
    kind: 'rules',
    id,
    row,
    keys,
    action: 'move',
  });
  const run = async (priority: number | null) => {
    if (priority === null) return void message.warning(m.reorderGap);
    const result = await submit({
      values: { ...baseline, priority },
      editableFields: keys,
      send: async (command, sent) =>
        parseSavedReceipt(await api.request<unknown>(path, { method: 'PUT', command }), { id, revision: sent }),
    });
    if (result.status !== 'done') return;
    form.clear();
    onDone();
  };
  // 核对后按最新列表重算相邻位置（移序目标值依赖整页顺序）。
  const confirm = () => {
    form.confirm();
    onDone();
  };
  const button = (target: number | null | undefined, label: string) =>
    target !== undefined && (
      <Button type="link" disabled={form.locked} onClick={() => void run(target)}>
        {label}
      </Button>
    );
  return (
    <>
      {button(up, m.moveUp)}
      {button(down, m.moveDown)}
      <RecoveryStatus form={{ ...form, confirm }} labels={configLabels.rules} onRefresh={onDone} />
    </>
  );
}
