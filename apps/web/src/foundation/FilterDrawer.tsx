import { Button, Drawer, Space } from 'antd';
import type { ReactNode } from 'react';
import { ui } from './messages.js';

export function FilterDrawer(props: {
  open: boolean;
  children: ReactNode;
  onClear(): void;
  onClose(): void;
  /** 条件由页面维护；校验和应用成功后由页面关闭，取消不触发应用。 */
  onApply(): void;
}) {
  return (
    <Drawer
      open={props.open}
      placement="right"
      closable={{ placement: 'end' }}
      width={500}
      title={ui.advancedFilter}
      onClose={props.onClose}
      rootClassName="filter-drawer"
      footer={
        <div className="filter-footer">
          <Button type="text" onClick={props.onClear}>
            {ui.clear}
          </Button>
          <Space>
            <Button onClick={props.onClose}>{ui.cancel}</Button>
            <Button type="primary" onClick={props.onApply}>
              {ui.confirm}
            </Button>
          </Space>
        </div>
      }
    >
      {props.children}
    </Drawer>
  );
}
