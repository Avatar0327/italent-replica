// 签署任务的写命令落定时，发起它的详情 / 弹窗可能已关闭，页面也可能已换入口重挂（电子签与员工自助挂同一组件）。
// 结果通知按任务 ID 发给仍挂着的读取方各自重读，不绑在发起命令的组件上（F-481-S5 返工 P2-1）。
import { useEffect } from 'react';

const listeners = new Set<(ids: readonly string[]) => void>();

export function tasksChanged(ids: readonly string[]) {
  listeners.forEach((listener) => listener(ids));
}

/** 有签署任务的写命令落定时调 refresh；给了 id 时只认这一条任务。 */
export function useTasksChanged(refresh: () => void, id?: string) {
  useEffect(() => {
    const listener = (ids: readonly string[]) => {
      if (id === undefined || ids.includes(id)) refresh();
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [refresh, id]);
}
