import { Button, Input, Popconfirm, Space, Typography } from 'antd';
import { useState, type KeyboardEvent } from 'react';
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
type Draft = { name: string; description: string };

/** 新增只带填写了的字段；编辑只提交改动的字段，清空描述按 null 提交（plan-input 任务 patch 口径）。 */
function taskBody(draft: Draft, task?: GoalTask): Record<string, unknown> {
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (!task) return description ? { name, description } : { name };
  const body: Record<string, unknown> = {};
  if (name !== task.name) body.name = name;
  if (description !== (task.description ?? '')) body.description = description || null;
  return body;
}

/**
 * 目标下的任务（原站 B2_05 / B2_06）：“添加任务”后行内输入任务名称与任务描述，名称框回车保存、Esc 取消；
 * 编辑 / 删除同样行内完成。按钮只在 actions 给出时出现（taskActions 经统一入口 operationAccess 判定）。
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
  const submit = (draft: Draft) => {
    if (!draft.name.trim() || !editing) return;
    if (editing.kind === 'add') return void write(base, 'POST', taskBody(draft));
    const body = taskBody(draft, editing.task);
    if (Object.keys(body).length) return void write(`${base}/${editing.task.id}`, 'PATCH', body);
    setEditing(undefined);
  };
  const editor = (task?: GoalTask) => (
    <TaskEditor task={task} locked={command.locked} submit={submit} cancel={() => setEditing(undefined)} />
  );
  const tasks = goal.tasks ?? [];
  return (
    <div className="idp-tasks">
      {tasks.map((task, index) => (
        <div key={task.id} className="idp-task">
          <Typography.Text type="secondary">{t.task.item(index + 1)}</Typography.Text>
          {editing?.kind === 'edit' && editing.task.id === task.id ? (
            editor(task)
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
      {editing?.kind === 'add' && <div className="idp-task">{editor()}</div>}
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

/** 任务名称（回车发布，原站提示语）与任务描述；原站描述为富文本编辑器，此处用多行文本（已列缺口）。 */
function TaskEditor(props: { task?: GoalTask; locked: boolean; submit(draft: Draft): void; cancel(): void }) {
  const { task, locked, submit, cancel } = props;
  // 已有任务的描述被裁剪（接口没返回该键）时只读：描述框空着提交不会改它，填写却会覆盖看不到的原值
  const hidden = !!task && task.description === undefined;
  const [draft, setDraft] = useState<Draft>({ name: task?.name ?? '', description: task?.description ?? '' });
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cancel();
  };
  return (
    <div className="idp-task-editor">
      <Input
        autoFocus
        aria-label={t.task.name}
        maxLength={200}
        value={draft.name}
        placeholder={t.task.hint}
        disabled={locked}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        onPressEnter={() => submit(draft)}
        onKeyDown={escape}
      />
      <Input.TextArea
        aria-label={t.task.description}
        maxLength={2000}
        autoSize={{ minRows: 2, maxRows: 6 }}
        value={draft.description}
        placeholder={t.task.descriptionHint}
        disabled={locked || hidden}
        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        onKeyDown={escape}
      />
    </div>
  );
}

function TaskLine(props: { task: GoalTask; actions: TaskAction[]; locked: boolean; edit(): void; remove(): void }) {
  const { task, actions, locked, edit, remove } = props;
  const name = task.name ?? t.noValue;
  return (
    <Space className="idp-task-line" align="start">
      <div>
        <span>{name}</span>
        {task.description && (
          <Typography.Paragraph type="secondary" className="idp-task-description">
            {task.description}
          </Typography.Paragraph>
        )}
      </div>
      <Typography.Text type="secondary">
        {period(task.startDate ?? undefined, task.endDate ?? undefined)}
      </Typography.Text>
      {/* 名称被裁剪时编辑框只能空着重填，会覆盖看不到的原值，不开放编辑（失败即拒绝） */}
      {actions.includes('edit') && task.name !== undefined && (
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
