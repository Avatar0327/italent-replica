import { Button, Input, Popconfirm, Space, Typography } from 'antd';
import { useState } from 'react';
import { IDP_API, type Command } from './api.js';
import { t } from './messages.js';
import { period, type TaskAction } from './model.js';
import type { GoalTask, PlanDetail, PlanGoal } from './types.js';

export interface TaskWriter {
  command: Command;
  plan: PlanDetail;
  /** 写入完成后重读计划：任务接口以计划 revision 做并发校验，必须换成新代次。 */
  saved(): void;
}
type Editing = { kind: 'add' } | { kind: 'edit'; task: GoalTask } | undefined;

/**
 * 目标下的任务（原站 B2_05 / B2_06）：“添加任务”后行内输入，回车保存、Esc 取消；
 * 编辑 / 删除同样行内完成。按钮只在 actions 给出时出现（taskActions：服务端节点按钮 ∩ 进行中）。
 */
export function GoalTasks({ goal, writer, actions }: { goal: PlanGoal; writer: TaskWriter; actions: TaskAction[] }) {
  const [editing, setEditing] = useState<Editing>();
  const { command, plan, saved } = writer;
  const base = `${IDP_API}/plans/${plan.id}/goals/${goal.id}/tasks`;
  const write = async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>) => {
    if (plan.revision === undefined) return;
    if (!(await command.run(path, method, body, plan.revision))) return;
    command.clear();
    setEditing(undefined);
    saved();
  };
  const submit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || !editing) return;
    if (editing.kind === 'add') return void write(base, 'POST', { name: trimmed });
    if (trimmed !== editing.task.name) return void write(`${base}/${editing.task.id}`, 'PATCH', { name: trimmed });
    setEditing(undefined);
  };
  const input = (initial?: string) => (
    <Input
      autoFocus
      aria-label={t.task.name}
      maxLength={200}
      defaultValue={initial}
      placeholder={t.task.hint}
      disabled={command.locked}
      onPressEnter={(event) => submit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setEditing(undefined);
      }}
    />
  );
  const tasks = goal.tasks ?? [];
  return (
    <div className="idp-tasks">
      {tasks.map((task, index) => (
        <div key={task.id} className="idp-task">
          <Typography.Text type="secondary">{t.task.item(index + 1)}</Typography.Text>
          {editing?.kind === 'edit' && editing.task.id === task.id ? (
            input(task.name)
          ) : (
            <TaskLine
              task={task}
              actions={actions}
              locked={command.locked}
              edit={() => setEditing({ kind: 'edit', task })}
              remove={() => void write(`${base}/${task.id}`, 'DELETE', {})}
            />
          )}
        </div>
      ))}
      {editing?.kind === 'add' && <div className="idp-task">{input()}</div>}
      {actions.includes('add') && editing?.kind !== 'add' && (
        <Button
          type="link"
          className="idp-task-add"
          disabled={command.locked}
          onClick={() => setEditing({ kind: 'add' })}
        >
          {t.task.add}
        </Button>
      )}
    </div>
  );
}

function TaskLine(props: { task: GoalTask; actions: TaskAction[]; locked: boolean; edit(): void; remove(): void }) {
  const { task, actions, locked, edit, remove } = props;
  const name = task.name ?? t.noValue;
  return (
    <Space className="idp-task-line">
      <span>{name}</span>
      <Typography.Text type="secondary">
        {period(task.startDate ?? undefined, task.endDate ?? undefined)}
      </Typography.Text>
      {actions.includes('edit') && (
        <Button type="link" size="small" aria-label={t.task.edit(name)} disabled={locked} onClick={edit}>
          {t.actions.edit}
        </Button>
      )}
      {actions.includes('delete') && (
        <Popconfirm title={t.task.confirmDelete} okText={t.actions.ok} cancelText={t.actions.back} onConfirm={remove}>
          <Button type="link" size="small" danger aria-label={t.task.delete(name)} disabled={locked}>
            {t.actions.delete}
          </Button>
        </Popconfirm>
      )}
    </Space>
  );
}
