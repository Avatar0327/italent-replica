import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { APP_ROUTES, appRoute, legacyTarget } from './routes.js';
import { PageErrorBoundary, PageState } from './PageState.js';
import { usePermissions } from './Permissions.js';
import { useSession } from './Session.js';
import { ListPage } from './templates.js';
import { ui } from './messages.js';

const Org = lazy(() => import('../org/OrgChangePage.js').then((m) => ({ default: m.OrgChangePage })));
const Job = lazy(() => import('../job/JobPage.js').then((m) => ({ default: m.JobPage })));
const Transfer = lazy(() => import('../transfer/TransferPage.js').then((m) => ({ default: m.TransferPage })));
const Self = lazy(() => import('../self-service/pages/SelfPage.js').then((m) => ({ default: m.SelfPage })));
const Manager = lazy(() => import('../self-service/pages/ManagerPage.js').then((m) => ({ default: m.ManagerPage })));
const Talent = lazy(() => import('../talent/TalentPage.js').then((m) => ({ default: m.TalentPage })));
const Account = lazy(() => import('../account/AccountPage.js').then((m) => ({ default: m.AccountPage })));
const existing = { org: Org, job: Job, transfer: Transfer, self: Self, manager: Manager, talent: Talent };

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
            const Page = existing[route.id as keyof typeof existing];
            return (
              <Route
                key={route.id}
                path={route.path}
                element={
                  Page ? (
                    <div className={['self', 'manager'].includes(route.id) ? undefined : 'legacy-page'}>
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
          <Route path="/settings/menu/:code" element={<LandingPage title={ui.routes.settings} />} />
          <Route path="/self/*" element={<Self />} />
          <Route path="/manager/*" element={<Manager />} />
          <Route path="*" element={<PageState kind="not-found" />} />
        </Routes>
      </Suspense>
    </PageErrorBoundary>
  );
}
