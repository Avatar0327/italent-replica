import { Button, Dropdown } from 'antd';
import type { ReactNode } from 'react';
import { ui } from './messages.js';

export interface ListView {
  value: string;
  options: { key: string; label: string }[];
  onChange(value: string): void;
}
// 用基本几何图形表达文档，不复用原站图标文件。
export function MenuIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
export function ViewHeading({ title, view, icon }: { title: string; view?: ListView; icon?: ReactNode }) {
  const options = view?.options ?? [{ key: 'current', label: title }];
  const value = view?.value ?? 'current';
  const label = options.find((option) => option.key === value)?.label ?? title;
  return (
    <h1 className="page-view-heading" aria-label={label}>
      <span className="page-view-icon">{icon ?? <MenuIcon />}</span>
      <Dropdown
        trigger={['click']}
        menu={{ items: options, selectedKeys: [value], onClick: ({ key }) => view?.onChange(key) }}
      >
        <Button className="page-view-trigger" type="text" aria-label={ui.switchView}>
          {label}
          <span aria-hidden="true" className="view-caret" />
        </Button>
      </Dropdown>
    </h1>
  );
}
