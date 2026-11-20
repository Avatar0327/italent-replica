import { App } from 'antd';
import { useCallback, useLayoutEffect, useRef } from 'react';

interface OpenConfirm {
  readonly destroy: () => void;
  readonly settle: (confirmed: boolean) => void;
}
export interface ConfirmText {
  readonly title: string;
  readonly content: string;
  readonly okText: string;
  readonly cancelText: string;
}

/**
 * 保存前确认框的共用实现（F-504 终止原合同、F-026 超编确认同一套）。走 App 上下文（同 exit/ExitCommands.tsx useAsk，F-352③）。
 * 同一时刻只开一个，连点不叠框；表单卸载时关掉确认框并按“取消”收尾，离开页面后迟到的“确定”不再发请求。
 */
export function useConfirmDialog(text: ConfirmText) {
  const { modal } = App.useApp();
  const open = useRef<OpenConfirm>(undefined);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = open.current;
      pending?.settle(false);
      pending?.destroy();
    };
  }, []);
  return useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (!mounted.current || open.current) return resolve(false);
        const settle = (confirmed: boolean) => {
          if (open.current?.settle !== settle) return;
          open.current = undefined;
          resolve(confirmed);
        };
        const instance = modal.confirm({
          ...text,
          onOk: () => settle(true),
          onCancel: () => settle(false),
        });
        open.current = { destroy: instance.destroy, settle };
      }),
    [modal, text],
  );
}
