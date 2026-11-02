// FE-R2c1b 立即执行（DEC-539①）：按已启用规则扫描一批并发起，回执显示业务日期、已发起 / 未发起明细；
// 有 nextCursor 时可“继续执行”。走 F-123 内核：恢复槽是执行路径，结果未知时锁定、不重放（切页签回来仍锁）。
import { Button, Popconfirm, Space, Table, message } from 'antd';
import { useState, type ReactNode } from 'react';
import { RefLabels, refPaths } from '../contracts/references.js';
import { rejectionMessage } from '../foundation/client.js';
import { useApiClient } from '../foundation/Session.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import type { Values } from '../foundation/forms/store.js';
import { s } from './settings-messages.js';
import { RULES, parseRunReceipt, type RuleKind, type RunReceipt } from './settings-model.js';

export function RunPanel({ kind, ruleNames }: { kind: RuleKind; ruleNames: Record<string, string> }) {
  const api = useApiClient();
  const path = RULES[kind].run;
  const writer = useConflictCommand(path, { revision: 0, values: {} }, undefined, { action: 'run' });
  const [receipt, setReceipt] = useState<RunReceipt>();
  const locked = writer.form.locked;
  const busy = writer.form.busy;

  const run = async (values: Values) => {
    try {
      await writer.run({
        values,
        editableFields: Object.keys(values),
        send: async ({ command }) => {
          const result = parseRunReceipt(kind, await api.request<unknown>(path, { method: 'POST', command }));
          setReceipt(result);
          // 执行不产生单一业务对象：以业务日期作回执标识（内核只要求非空）。
          return { id: result.businessDate };
        },
      });
    } catch (error) {
      // 结果未知：可能已发起，保持锁定，等刷新回查（DEC-067）；明确拒绝（如开关未开启）提示原因后解锁。
      if (writer.form.peek()?.status === 'unknown') return;
      void message.error(rejectionMessage(error));
      writer.form.clear();
    }
  };

  return (
    <div className="probation-settings-block">
      <Space wrap>
        <Popconfirm
          title={s.runConfirm}
          okText={s.confirm}
          cancelText={s.cancel}
          disabled={locked}
          onConfirm={() => void run({})}
        >
          <Button loading={busy} disabled={locked}>
            {s.run}
          </Button>
        </Popconfirm>
        {locked && !busy && <span className="probation-settings-hint">{s.runLocked}</span>}
      </Space>
      {receipt && (
        <RunResult
          receipt={receipt}
          ruleNames={ruleNames}
          more={
            <Button disabled={locked} loading={busy} onClick={() => void run({ cursor: receipt.nextCursor })}>
              {s.runMore}
            </Button>
          }
        />
      )}
    </div>
  );
}

const Employee = ({ id }: { id: string }) => <RefLabels path={refPaths.employeeId} ids={[id]} />;

/** 回执：业务日期、已发起 / 未发起人数与明细；还有下一批时给“继续执行”。 */
function RunResult(props: { receipt: RunReceipt; ruleNames: Record<string, string>; more: ReactNode }) {
  const { receipt, ruleNames } = props;
  const rule = (id: string) => ruleNames[id] ?? id;
  return (
    <section aria-label={s.runTitle}>
      <h2>{s.runTitle}</h2>
      <Space size={16} wrap>
        <span>
          {s.runDate}：{receipt.businessDate}
        </span>
        <span>{s.runLaunched(receipt.launched.length)}</span>
        <span>{s.runFailed(receipt.failed.length)}</span>
      </Space>
      {receipt.launched.length > 0 && (
        <Table
          size="small"
          rowKey={(row) => `${row.employeeId}:${row.businessRef}`}
          dataSource={receipt.launched}
          pagination={false}
          columns={[
            { key: 'employee', title: s.runEmployee, render: (_, row) => <Employee id={row.employeeId} /> },
            { key: 'rule', title: s.runRule, render: (_, row) => rule(row.ruleId) },
            { key: 'business', title: s.runBusiness, dataIndex: 'businessRef' },
          ]}
        />
      )}
      {receipt.failed.length > 0 && (
        <Table
          size="small"
          rowKey={(row) => `${row.employeeId}:${row.ruleId}`}
          dataSource={receipt.failed}
          pagination={false}
          columns={[
            { key: 'employee', title: s.runEmployee, render: (_, row) => <Employee id={row.employeeId} /> },
            { key: 'rule', title: s.runRule, render: (_, row) => rule(row.ruleId) },
            { key: 'reason', title: s.runReason, dataIndex: 'reason' },
          ]}
        />
      )}
      {receipt.nextCursor ? (
        <Space>
          <span>{s.runHasMore}</span>
          {props.more}
        </Space>
      ) : (
        <p>{s.runDone}</p>
      )}
    </section>
  );
}
