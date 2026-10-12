import type { ThemeConfig } from 'antd';

// DEC-456④：按本机 UI/INDEX.md 实测表与第 1 批截图复刻色彩、控件高度和密度，不引入原站资源。
export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#146EFF',
    colorInfo: '#146EFF',
    colorLink: '#0054F0',
    colorLinkHover: '#146EFF',
    colorText: '#33383D',
    colorTextSecondary: '#868B8F',
    colorBgLayout: '#F7F9FA',
    colorBorder: '#E6E8EB',
    borderRadius: 5,
    fontSize: 12,
    controlHeight: 32,
    fontFamily: '-apple-system, system-ui, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
  },
  components: {
    Layout: { headerBg: '#ffffff', siderBg: '#ffffff', headerHeight: 50 },
    Menu: { itemSelectedBg: '#146EFF', itemSelectedColor: '#ffffff', itemBorderRadius: 7, itemHeight: 40 },
    Button: { paddingInline: 16, contentFontSize: 14, colorLink: '#0054F0' },
    Table: { headerBg: '#F7F9FA', headerColor: '#33383D', cellPaddingBlock: 9, cellFontSize: 12 },
    Tabs: { horizontalItemGutter: 40, itemSelectedColor: '#0054F0', inkBarColor: '#0054F0' },
  },
};
