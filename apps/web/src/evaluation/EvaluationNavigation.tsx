import { Menu } from 'antd';
import { useSearchParams } from 'react-router';
import type { ReactNode } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { StaffPage } from './StaffPage.js';
import { SettingsPage } from './SettingsPage.js';
import { evUi } from './alignment.js';
import { m } from './messages.js';

export function EvaluationNavigation({ activities }: { activities: ReactNode }) {
  const [query, setQuery] = useSearchParams();
  const permission = usePermissions();
  usePermissions('TEvaluation.StaffEvaluationData');
  usePermissions('TEvaluation.EvaluationForm');
  usePermissions('TEvaluation.ReviewGroup');
  const entries = [
    ['process', m.process, 'StaffEvaluationData'],
    ['records', evUi.records, 'StaffEvaluationData'],
    ['activities', m.title, 'EvaluationActivity'],
    ['forms', evUi.forms, 'EvaluationForm'],
    ['groups', evUi.groups, 'ReviewGroup'],
  ];
  const allowed = entries.filter(([, , object]) => permission.snapshot.objects[`TEvaluation.${object}`]);
  const view = query.get('view') ?? 'activities';
  return (
    <div className="evaluation-layout">
      <Menu
        mode="inline"
        selectedKeys={[view]}
        items={allowed.map(([key, label]) => ({ key: key!, label }))}
        onClick={({ key }) => setQuery({ view: key })}
      />
      <main className="evaluation-content">
        {!allowed.some(([key]) => key === view) ? (
          <PageState kind={permission.loading ? 'loading' : 'forbidden'} />
        ) : view === 'activities' ? (
          activities
        ) : ['forms', 'groups'].includes(view) ? (
          <SettingsPage key={view} kind={view as 'forms' | 'groups'} />
        ) : (
          <StaffPage key={view} process={view === 'process'} />
        )}
      </main>
    </div>
  );
}
