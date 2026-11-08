import type { AttachmentPurpose } from '@italent/domain';
import { Button, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiClient } from '../Session.js';
import { ApiError, newCommand, type Command } from '../client.js';
import { attachmentApi, isAbort, isUncertain, purposeConfig, type AttachmentView } from './api.js';
import { AttachmentList } from './AttachmentList.js';
import { temporaryContentPath } from './blob.js';
import { attachmentText as text } from './messages.js';
import { useUploadQueue, type UploadTask } from './upload-queue.js';

export interface ImageAttachmentsProps {
  readonly purpose: AttachmentPurpose;
  readonly value: readonly AttachmentView[];
  readonly onChange: (next: AttachmentView[]) => void;
  readonly disabled?: boolean;
  readonly readonly?: boolean;
  /** 已绑定文件的内容地址（所在载体的下载路由）；临时文件固定走 `/attachments/:id/content`。 */
  readonly contentPath?: (item: AttachmentView) => string | undefined;
  /** 有排队或在传的文件时为 true：宿主据此禁用保存 / 提交（设计 §5.1“并发”）。 */
  readonly onBusyChange?: (busy: boolean) => void;
}

/** 通用图片附件控件（设计 §5.1）。受控：value 由宿主从服务端读回，控件只追加上传成功的临时文件或移除项。 */
export function ImageAttachments(props: ImageAttachmentsProps) {
  const config = purposeConfig(props.purpose);
  const latestValue = useRef(props.value);
  latestValue.current = props.value;
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const commit = useCallback((next: AttachmentView[]) => {
    latestValue.current = next;
    onChange.current(next);
  }, []);
  const latest = useCallback(() => latestValue.current, []);
  const queue = useUploadQueue({ purpose: props.purpose, commit, latest });
  const removal = useTemporaryRemoval(commit, latest);
  useBusy(queue.busy, props.onBusyChange);
  const input = useRef<HTMLInputElement>(null);
  const editable = !props.readonly && !props.disabled;
  const full = props.value.length + queue.tasks.length >= config.maxFiles;
  const pathOf = (item: AttachmentView) => (item.temporary ? temporaryContentPath(item.id) : props.contentPath?.(item));
  return (
    <div className="image-attachments">
      {!props.readonly && (
        <div className="attachment-toolbar">
          <Button disabled={!editable || full} onClick={() => input.current?.click()}>
            {text.upload}
          </Button>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept={config.extensions.map((extension) => `.${extension}`).join(',')}
            disabled={!editable || full}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              queue.choose(files);
            }}
          />
          {queue.busy && <Typography.Text type="secondary">{text.uploading}</Typography.Text>}
        </div>
      )}
      {queue.notices.length > 0 && (
        <div className="attachment-notices" role="alert">
          {queue.notices.map((notice, index) => (
            <Typography.Text key={index} type="danger">
              {notice}
            </Typography.Text>
          ))}
        </div>
      )}
      <AttachmentList
        items={props.value}
        pathOf={pathOf}
        types={config.types}
        onRemove={editable ? removal.remove : undefined}
        removing={(item) => removal.notes[item.id] === pending}
        note={(item) => (removal.notes[item.id] === pending ? undefined : removal.notes[item.id])}
      />
      <TaskList tasks={queue.tasks} editable={editable} onRetry={queue.retry} onDiscard={queue.discard} />
    </div>
  );
}

function useBusy(busy: boolean, onBusyChange?: (busy: boolean) => void) {
  const notify = useRef(onBusyChange);
  notify.current = onBusyChange;
  const last = useRef(false);
  useEffect(() => {
    if (last.current === busy) return;
    last.current = busy;
    notify.current?.(busy);
  }, [busy]);
  // 卸载时若仍忙，告知宿主解除禁用，避免控件被切走后保存按钮一直置灰
  useEffect(
    () => () => {
      if (last.current) notify.current?.(false);
      last.current = false;
    },
    [],
  );
}

const pending = '__pending__';

/**
 * 删除临时文件：点删除立即 `DELETE /attachments/:id`（Q-9），带 If-Match；结果未知时保留原命令，再点按原键重提。
 * 已绑定文件只从值里移除，保存草稿时由后端分流（§2.2）。卸载后迟到回调不写状态。
 */
function useTemporaryRemoval(commit: (next: AttachmentView[]) => void, latest: () => readonly AttachmentView[]) {
  const client = useApiClient();
  const api = useMemo(() => attachmentApi(client), [client]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const live = useRef({ mounted: true, commands: new Map<string, Command<undefined>>() });
  useEffect(() => {
    const current = live.current;
    current.mounted = true;
    return () => void (current.mounted = false);
  }, []);
  const note = (id: string, message?: string) =>
    setNotes(({ [id]: _old, ...rest }) => (message ? { ...rest, [id]: message } : rest));
  const drop = (id: string) => commit(latest().filter((item) => item.id !== id));
  const remove = async (item: AttachmentView) => {
    if (!item.temporary) return drop(item.id);
    const current = live.current;
    const command = current.commands.get(item.id) ?? newCommand(undefined, item.temporary.revision);
    current.commands.set(item.id, command);
    note(item.id, pending);
    try {
      await api.remove(item.id, command);
      if (!current.mounted) return;
      current.commands.delete(item.id);
      note(item.id);
      drop(item.id);
    } catch (error) {
      if (!current.mounted || isAbort(error)) return;
      if (isUncertain(error)) return note(item.id, text.deleteUnknown);
      current.commands.delete(item.id);
      // 404：文件已不在（过期清理或此前的删除其实已成功），按删除成功从列表移除
      if (error instanceof ApiError && error.status === 404) {
        note(item.id);
        return drop(item.id);
      }
      note(item.id, text.deleteFailed);
    }
  };
  return { notes, remove: (item: AttachmentView) => void remove(item) };
}

interface TaskListProps {
  readonly tasks: readonly UploadTask[];
  readonly editable: boolean;
  readonly onRetry: (key: string) => void;
  readonly onDiscard: (key: string) => void;
}

function TaskList({ tasks, editable, onRetry, onDiscard }: TaskListProps) {
  if (!tasks.length) return null;
  return (
    <ul className="attachment-list">
      {tasks.map((task) => {
        const settled = task.phase === 'failed' || task.phase === 'uncertain';
        const waiting = (task.retryAt ?? 0) > Date.now();
        return (
          <li key={task.key} className="attachment-item" data-task={task.key}>
            <span className="attachment-thumb attachment-blank">{settled ? '' : text.loading}</span>
            <div className="attachment-meta">
              <Typography.Text className="attachment-name">{task.filename}</Typography.Text>
              <Typography.Text type={settled ? 'danger' : 'secondary'}>
                {task.message ?? (task.phase === 'queued' ? text.queued : text.uploading)}
              </Typography.Text>
            </div>
            {settled && (
              <Button size="small" disabled={!editable || waiting} onClick={() => onRetry(task.key)}>
                {text.retry}
              </Button>
            )}
            {settled && editable && (
              <Button size="small" className="remove" onClick={() => onDiscard(task.key)}>
                {text.remove}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
