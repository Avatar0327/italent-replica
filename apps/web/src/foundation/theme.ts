import type { ThemeConfig } from 'antd';

// DEC-456④：按本机 Q-M0-149 与 Q-M0-176 截图复刻色彩、控件高度和密度，不引入原站资源。
export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#1769ff',
    colorInfo: '#1769ff',
    colorText: '#30343b',
    colorTextSecondary: '#838a94',
    colorBgLayout: '#f5f7f9',
    colorBorder: '#e2e5eb',
    borderRadius: 4,
    fontSize: 13,
    controlHeight: 32,
    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: {
    Layout: { headerBg: '#ffffff', siderBg: '#ffffff', headerHeight: 50 },
    Menu: { itemSelectedBg: '#1769ff', itemSelectedColor: '#ffffff', itemBorderRadius: 7, itemHeight: 40 },
    Table: { headerBg: '#f7f7f9', headerColor: '#30343b', cellPaddingBlock: 12 },
    Tabs: { horizontalItemGutter: 32 },
  },
};
