import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { APP_ROUTES, appRoute, legacyTarget } from './routes.js';
import { PageErrorBoundary, PageState } from './PageState.js';
import { usePermissions } from './Permissions.js';
import { useSession } from './Session.js';
import { ListPage } from './templates.js';
import { ui } from './messages.js';

const Account = lazy(() => import('../account/AccountPage.js').then((m) => ({ default: m.AccountPage })));
const Approval = lazy(() => import('../approval/ApprovalPage.js').then((m) => ({ default: m.ApprovalPage })));
const Evaluation = lazy(() => import('../evaluation/EvaluationPage.js').then((m) => ({ default: m.EvaluationPage })));
const Job = lazy(() => import('../job/JobPage.js').then((m) => ({ default: m.JobPage })));
const Manager = lazy(() => import('../self-service/pages/ManagerPage.js').then((m) => ({ default: m.ManagerPage })));
const Org = lazy(() => import('../org/OrgChangePage.js').then((m) => ({ default: m.OrgChangePage })));
const Qualification = lazy(() =>
  import('../qualification/QualificationPage.js').then((m) => ({ default: m.QualificationPage })),
);
const Self = lazy(() => import('../self-service/pages/SelfPage.js').then((m) => ({ default: m.SelfPage })));
const Settings = lazy(() => import('../settings/SettingsPage.js').then((m) => ({ default: m.SettingsPage })));
const Staff = lazy(() => import('../personnel/StaffPage.js').then((m) => ({ default: m.StaffPage })));
const Survey = lazy(() => import('../survey360/SurveyPage.js').then((m) => ({ default: m.SurveyPage })));
const Talent = lazy(() => import('../talent/TalentPage.js').then((m) => ({ default: m.TalentPage })));
const TalentReview = lazy(() =>
  import('../talent-review/TalentReviewPage.js').then((m) => ({ default: m.TalentReviewPage })),
);
const Transfer = lazy(() => import('../transfer/TransferPage.js').then((m) => ({ default: m.TransferPage })));
// 页面与布局同行登记，合并页面片时不再维护另一处路由条件。
const existing = {
  approval: { Page: Approval, legacy: false },
  evaluation: { Page: Evaluation, legacy: false },
  job: { Page: Job, legacy: true },
  manager: { Page: Manager, legacy: false },
  org: { Page: Org, legacy: true },
  qualification: { Page: Qualification, legacy: true },
  self: { Page: Self, legacy: false },
  settings: { Page: Settings, legacy: true },
  staff: { Page: Staff, legacy: false },
  survey360: { Page: Survey, legacy: false },
  talent: { Page: Talent, legacy: true },
  'talent-review': { Page: TalentReview, legacy: true },
  transfer: { Page: Transfer, legacy: false },
};

function LandingPage({ title }: { title: string }) {
  return (
    <ListPage
      title={title}
      data={{ items: [], total: 0 }}
      columns={[{ title: ui.name, dataIndex: 'name' }]}
      rowKey="id"
      page={{ page: 1, pageSize: 15 }}
      onPageChange={() => {}}
    />
  );
}
export function AppPages() {
  const location = useLocation();
  const session = useSession();
  const permission = usePermissions();
  const redirect = legacyTarget(location.pathname, location.search, location.hash);
  if (redirect) return <Navigate replace to={redirect} />;
  if (!session.tenantId) return <PageState kind="login" />;
  if (permission.loading) return <PageState kind="loading" />;
  if (permission.error) return <PageState kind="error" error={permission.error} retry={permission.refresh} />;
  const active = appRoute(location.pathname);
  const isAccount = location.pathname === '/settings/account';
  if (active && !isAccount && !permission.menus.some((menu) => menu.key === active.id))
    return <PageState kind="forbidden" />;
  return (
    <PageErrorBoundary key={`${session.tenantId}/${session.identityKey}/${location.pathname}`}>
      <Suspense fallback={<PageState kind="loading" />}>
        <Routes>
          {APP_ROUTES.map((route) => {
            const page = existing[route.id as keyof typeof existing];
            const Page = page?.Page;
            return (
              <Route
                key={route.id}
                path={route.path}
                element={
                  Page ? (
                    <div className={page.legacy ? 'legacy-page' : undefined}>
                      <Page />
                    </div>
                  ) : (
                    <LandingPage title={route.label} />
                  )
                }
              />
            );
          })}
          <Route
            path="/org/changes"
            element={
              <div className="legacy-page">
                <Org />
              </div>
            }
          />
          <Route
            path="/settings/account"
            element={
              <div className="legacy-page">
                <Account />
              </div>
            }
          />
          <Route path="/settings/menu/:code" element={<Settings />} />
          <Route path="/self/*" element={<Self />} />
          <Route path="/manager/*" element={<Manager />} />
          <Route path="*" element={<PageState kind="not-found" />} />
        </Routes>
      </Suspense>
    </PageErrorBoundary>
  );
}
