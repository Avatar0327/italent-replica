import { App } from 'antd';
import { useCallback, useEffect, useRef } from 'react';
import { hrFormText as h } from './messages.js';

interface OpenConfirm {
  readonly destroy: () => void;
  readonly settle: (confirmed: boolean) => void;
}

/**
 * F-504“继续保存将终止原合同”确认框。走 App 上下文（同 exit/ExitCommands.tsx useAsk，F-352③）。
 * 同一时刻只开一个，连点不叠框；表单卸载时关掉确认框并按“取消”收尾，离开页面后迟到的“确定”不再发请求。
 */
export function useTerminateConfirm() {
  const { modal } = App.useApp();
  const open = useRef<OpenConfirm>(undefined);
  useEffect(
    () => () => {
      open.current?.destroy();
      open.current?.settle(false);
    },
    [],
  );
  return useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (open.current) return resolve(false);
        const settle = (confirmed: boolean) => {
          open.current = undefined;
          resolve(confirmed);
        };
        const instance = modal.confirm({
          title: h.terminateTitle,
          content: h.terminateContent,
          okText: h.confirm,
          cancelText: h.cancel,
          onOk: () => settle(true),
          onCancel: () => settle(false),
        });
        open.current = { destroy: instance.destroy, settle };
      }),
    [modal],
  );
}
