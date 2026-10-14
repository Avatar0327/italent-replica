import { ConfigProvider } from 'antd';
import { cloneElement, createContext, isValidElement, useContext, useRef, type ReactNode } from 'react';

const LockContext = createContext(false);
/** DEC-431①：表单入口统一下发提交锁；子控件不能以 disabled=false 覆盖它。 */
export function FormLock({ locked, children }: { locked: boolean; children: ReactNode }) {
  const inherited = useContext(LockContext);
  return <LockContext.Provider value={inherited || locked}>{children}</LockContext.Provider>;
}
export function useFormLock(disabled = false, readOnly = false) {
  const submitting = useContext(LockContext);
  const { componentDisabled } = ConfigProvider.useConfig();
  const locked = !!(submitting || componentDisabled || disabled || readOnly);
  const current = useRef(locked);
  current.current = locked;
  return {
    disabled: locked,
    guard:
      <Args extends unknown[]>(change?: (...args: Args) => void) =>
      (...args: Args) => {
        // 已打开的浮层或异步子控件可能保留旧回调，执行时仍须检查当前锁。
        if (!current.current) change?.(...args);
      },
  };
}
interface ControlProps {
  disabled?: boolean;
  readOnly?: boolean;
  onChange?: (...args: unknown[]) => void;
  [key: string]: unknown;
}
/** 放在 Form.Item 内，转交其注入的 value/id/onChange，保护普通控件及自定义内容的最终变更入口。 */
export function LockedField({ children, ...injected }: ControlProps & { children: ReactNode }) {
  const child = isValidElement<ControlProps>(children) ? children : undefined;
  const props = { ...child?.props, ...injected };
  const lock = useFormLock(child?.props.disabled || injected.disabled, child?.props.readOnly || injected.readOnly);
  const change = lock.guard((...args: unknown[]) => {
    injected.onChange?.(...args);
    if (child?.props.onChange !== injected.onChange) child?.props.onChange?.(...args);
  });
  return child ? cloneElement(child, { ...props, disabled: lock.disabled, onChange: change }) : children;
}
