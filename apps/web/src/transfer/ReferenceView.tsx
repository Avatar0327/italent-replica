import { Button, ConfigProvider, Dropdown, type ThemeConfig } from 'antd';
import type { ReactNode } from 'react';
import './reference-view.css';

// DEC-456④⑧：本机 INDEX 实测值；FE-0 上移前的页面片适配，不改变公共模板接口。
const referenceTheme: ThemeConfig = {
  token: {
    colorPrimary: '#146eff',
    colorInfo: '#146eff',
    colorLink: '#0054f0',
    colorText: '#33383d',
    colorTextSecondary: '#5e6266',
    colorBorder: '#e6e8eb',
    colorBgLayout: '#f7f9fa',
    fontSize: 12,
    borderRadius: 5,
    controlHeight: 32,
    fontFamily: '-apple-system, system-ui, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
  },
  components: {
    Button: { paddingInline: 16, contentFontSize: 14 },
    Table: { headerBg: '#f7f9fa', headerColor: '#33383d', cellPaddingBlock: 9, cellPaddingInline: 12 },
    Tabs: { itemSelectedColor: '#0054f0', inkBarColor: '#0054f0', horizontalItemGutter: 40 },
  },
};
export function ReferenceTheme({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={referenceTheme}>
      <div className="r1c-reference">{children}</div>
    </ConfigProvider>
  );
}
export function ReferenceView({
  title,
  choices,
  onChange,
  actions,
}: {
  title: string;
  choices?: { key: string; label: string }[];
  onChange?(key: string): void;
  actions?: ReactNode;
}) {
  return (
    <header className="r1c-view-heading">
      <span className="r1c-view-icon" aria-hidden>
        ↔
      </span>
      <h1>
        {choices && onChange ? (
          <Dropdown trigger={['click']} menu={{ items: choices, onClick: ({ key }) => onChange(key) }}>
            <Button type="text" className="r1c-view-title">
              {title}
              <span aria-hidden>▾</span>
            </Button>
          </Dropdown>
        ) : (
          title
        )}
      </h1>
      <div className="r1c-view-actions">{actions}</div>
    </header>
  );
}
