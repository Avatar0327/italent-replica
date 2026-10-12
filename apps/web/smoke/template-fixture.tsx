import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Button, Input, Select } from 'antd';
import zhCN from 'antd/es/locale/zh_CN.js';
import { ListPage, DetailPage } from '../src/foundation/templates.js';
import { FilterDrawer } from '../src/foundation/FilterDrawer.js';
import { theme } from '../src/foundation/theme.js';
import '../src/foundation/shell.css';
function Preview() {
  const [detail, setDetail] = useState(false);
  const [filter, setFilter] = useState(false);
  return (
    <ConfigProvider theme={theme} locale={zhCN}>
      <div className="shell-content">
        <ListPage
          title="启用的组织"
          data={{ items: [{ id: 'sample', name: '合成示例组织' }], total: 1 }}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (name: string) => (
                <Button type="link" onClick={() => setDetail(true)}>
                  {name}
                </Button>
              ),
            },
          ]}
          rowKey="id"
          page={{ page: 1, pageSize: 15 }}
          onPageChange={() => {}}
          filters={
            <Button type="link" onClick={() => setFilter(true)}>
              高级筛选
            </Button>
          }
          actions={<Button type="primary">新建</Button>}
        />
        <DetailPage
          title="合成示例组织"
          open={detail}
          onClose={() => setDetail(false)}
          summary="合成组织摘要"
          tabs={[
            { key: 'base', label: '组织单元', children: '组织内容' },
            { key: 'changes', label: '变更记录', children: '合成变更记录' },
          ]}
          sections={[
            { key: 'base', title: '基本信息', children: '合成测试数据，非原站资料' },
            { key: 'parent', title: '上级组织', children: '合成上级' },
          ]}
        />
        <FilterDrawer
          open={filter}
          onClear={() => {}}
          onClose={() => setFilter(false)}
          onApply={() => setFilter(false)}
        >
          <h2 className="form-group-title">自定义搜索</h2>
          <p>组织名称</p>
          <Input placeholder="请输入" />
          <p>状态</p>
          <Select className="full-width-selector" placeholder="请选择" options={[{ value: 'active', label: '启用' }]} />
        </FilterDrawer>
      </div>
    </ConfigProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
