import { Alert, Button, Empty, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { ImportFileDownload } from '../exit/ImportFileDownload.js';
import { useApiClient, useSession } from './Session.js';
import { ui } from './messages.js';
import './notifications.css';

type Notice = {
  id: string;
  channel: string;
  title: string | null;
  body: string | null;
  sender: string | null;
  template: string | null;
  businessId: string | null;
  createdAt: string | null;
};
type NoticePage = { items: Notice[]; page: number; pageSize: number };

// OFFSET 翻页期间插入通知会使后页重叠，保留每个 ID 首次出现的位置与内容。
function uniqueNotices(items: Notice[]): Notice[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** 抽屉每次打开重新挂载；关闭时销毁票据，分页响应只由当前请求落地。 */
export function Notifications() {
  const api = useApiClient();
  const { timezone } = useSession();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<Notice[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const ticket = ++sequence.current;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    const load = async () => {
      // StrictMode 的试挂载在这一微任务前清理，真正打开只发一次请求。
      await Promise.resolve();
      if (controller.signal.aborted) return;
      try {
        const result = await api.request<NoticePage>(`/api/tenant/approval/notifications?page=${page}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || ticket !== sequence.current) return;
        const visible = result.items.filter((item) => item.channel === 'inbox' && item.body);
        setItems((previous) => uniqueNotices(page === 1 ? visible : [...previous, ...visible]));
        // 真实接口没有 hasNext，过滤前的条数决定下一页，避免非站内消息占满一页后截断。
        setMore(result.items.length === result.pageSize);
      } catch {
        if (!controller.signal.aborted && ticket === sequence.current) setFailed(true);
      } finally {
        if (!controller.signal.aborted && ticket === sequence.current) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [api, page, attempt]);
  const instant = (value: string | null) =>
    value &&
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  return (
    <div className="notification-list">
      {items.map((item) => (
        <article key={item.id}>
          <h3>{item.title}</h3>
          {item.sender !== null && <p>{ui.noticeSender(item.sender)}</p>}
          <p className="notification-body">{item.body}</p>
          {item.template === 'exit_import_finished' && item.businessId && (
            <ImportFileDownload businessId={item.businessId}>{ui.noticeDetails}</ImportFileDownload>
          )}
          <time dateTime={item.createdAt ?? undefined}>{instant(item.createdAt)}</time>
        </article>
      ))}
      {!items.length && !loading && !failed && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={ui.noMessages} />
      )}
      {loading && <Spin />}
      {failed && (
        <Alert
          type="error"
          showIcon
          message={ui.noticeFailed}
          action={<Button onClick={() => setAttempt((value) => value + 1)}>{ui.noticeRetry}</Button>}
        />
      )}
      {more && !failed && (
        <Button disabled={loading} onClick={() => setPage((value) => value + 1)}>
          {ui.noticeMore}
        </Button>
      )}
    </div>
  );
}
