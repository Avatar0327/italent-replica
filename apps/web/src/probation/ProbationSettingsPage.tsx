// FE-R2c1b 试用设置页：试用结果字典（DEC-361）、自动转正（B57）、自动发起考核（B58）、考核并行规则（B59）。
// 只出有后端接口的设置项；页签与路由一一对应（/probation-settings/<tab>）。
import { Tabs } from 'antd';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { s } from './settings-messages.js';
import { TABS, isTab, type Tab } from './settings-model.js';
import { ResultsTab } from './settings-results.js';
import { RulesTab } from './settings-rules.js';
import { settingsStore } from './settings-store.js';
import { ParallelTab } from './settings-switch.js';
import './settings.css';

export function ProbationSettingsPage() {
  // 命令存储在模块级：切换页签会重建页面，结果未知的命令不能随之丢失。
  return (
    <FormCommands store={settingsStore}>
      <div className="probation-settings">
        <DecisionNote id="probation-settings" />
        <Routes>
          <Route index element={<Navigate to={TABS[0]} replace />} />
          <Route path=":tab" element={<SettingTabs />} />
          <Route path="*" element={<PageState kind="not-found" />} />
        </Routes>
      </div>
    </FormCommands>
  );
}

const CONTENT: Record<Tab, () => ReactElement> = {
  results: () => <ResultsTab />,
  'auto-regularization': () => <RulesTab kind="regularization" />,
  'auto-assessment': () => <RulesTab kind="assessment" />,
  parallel: () => <ParallelTab />,
};

function SettingTabs() {
  const { tab } = useParams();
  const navigate = useNavigate();
  if (!isTab(tab)) return <PageState kind="not-found" />;
  const Content = CONTENT[tab];
  return (
    <section className="probation-settings-card">
      <Tabs
        activeKey={tab}
        // 相对当前页签切换，不写死入口路径（入口 id 由 pages.ts 登记）。
        onChange={(key) => void navigate(`../${key}`, { relative: 'path' })}
        items={TABS.map((key) => ({ key, label: s.tabs[key] }))}
      />
      <Content key={tab} />
    </section>
  );
}
