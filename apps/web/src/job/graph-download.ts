import { App } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../foundation/index.js';
import { graphText as t } from './messages.js';

const XLSX = 'spreadsheetml.sheet';
class ExportFailure extends Error {}

/** 服务端文件名走 filename*（UTF-8 百分号编码，租户时区导出时刻）；取不到才用兜底名。 */
function fileNameOf(response: Response) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
  try {
    return encoded ? decodeURIComponent(encoded) : 'export.xlsx';
  } catch {
    return 'export.xlsx';
  }
}

/** 只有无快照（409 GRAPH_NOT_GENERATED，设计 U4）给专门提示；其余拒绝一律“导出失败”，不显示服务端原文。 */
async function failureOf(response: Response) {
  if (response.status !== 409) return t.exportFailed;
  const body = (await response.json().catch(() => undefined)) as { error?: { details?: { reason?: string } } };
  return body?.error?.details?.reason === 'GRAPH_NOT_GENERATED' ? t.exportNotGenerated : t.exportFailed;
}

/**
 * 两种导出共用的下载（F-474-7c）：GET 只读、无写命令；只保存服务端返回的 xlsx，错误响应不落盘成假成功。
 * 同一时刻只跑一单；离开页面时中止请求，迟到的结果不再提示、不再保存。
 */
export function useGraphDownload() {
  const session = useSession();
  const { message } = App.useApp();
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  const start = async (path: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const active = new AbortController();
    controller.current = active;
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'x-tenant-id': session.tenantId },
        signal: active.signal,
      });
      if (!response.ok) throw new ExportFailure(await failureOf(response));
      if (!response.headers.get('content-type')?.includes(XLSX)) throw new ExportFailure(t.exportFailed);
      const blob = await response.blob();
      if (active.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileNameOf(response);
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      void message.success(t.exported);
    } catch (failure) {
      if (!active.signal.aborted)
        void message.error(failure instanceof ExportFailure ? failure.message : t.exportFailed);
    } finally {
      if (!active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  return { busy, start };
}
