import { Button, Dropdown } from 'antd';
import { createContext, useContext, type ReactNode } from 'react';
import { ui } from './messages.js';

interface Views {
  value: string;
  items: { key: string; label: string }[];
  onChange(key: string): void;
}
const ViewsContext = createContext<Views | undefined>(undefined);

// DEC-456④：页面按自身已授权的视图登记；不修改 ListPage 的既有调用契约。
export function ListViews({ children, ...views }: Views & { children: ReactNode }) {
  return <ViewsContext.Provider value={views}>{children}</ViewsContext.Provider>;
}
export function ListViewTitle({ title }: { title: string }) {
  const views = useContext(ViewsContext);
  const icon = (
    <svg className="list-view-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h6" />
    </svg>
  );
  return (
    <h1 className="list-view-title">
      {views ? (
        <Dropdown
          trigger={['click']}
          menu={{
            items: views.items,
            selectable: true,
            selectedKeys: [views.value],
            onClick: ({ key }) => views.onChange(key),
          }}
        >
          <Button type="text" aria-label={`${ui.switchView}${title}`}>
            {icon}
            <span>{title}</span>
            <span aria-hidden="true">▾</span>
          </Button>
        </Dropdown>
      ) : (
        <>
          {icon}
          <span>{title}</span>
        </>
      )}
    </h1>
  );
}
