import { Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { mountPath, pageRoutes, type ModulePage } from './page-registry.js';
import { MENU_ROUTES, PAGES, SUB_ROUTES, appRoute, legacyTarget, routePath } from './routes.js';
import { PageErrorBoundary, PageState } from './PageState.js';
import { usePermissions } from './Permissions.js';
import { useSession } from './Session.js';
import { ListPage } from './templates.js';
import { ui } from './messages.js';

// 页面由各模块 pages.ts 自带登记（F-125），这里只装配；应用页一律包一层 div，子路由仅 legacy 时包。
function Mounted({ page, legacy }: { page: ModulePage; legacy: boolean }) {
  return legacy ? (
    <div className="legacy-page">
      <page.Component />
    </div>
  ) : (
    <page.Component />
  );
}

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
  const visible = permission.menus.flatMap((menu) => (menu.directory ? (menu.children ?? []) : [menu]));
  if (active && !PAGES.ungated.has(routePath(location.pathname)) && !visible.some((menu) => menu.key === active.id))
    return <PageState kind="forbidden" refresh={permission.refresh} />;
  return (
    <PageErrorBoundary key={`${session.tenantId}/${session.identityKey}/${location.pathname}`}>
      <Suspense fallback={<PageState kind="loading" />}>
        <Routes>
          {pageRoutes(MENU_ROUTES).map((route) => (
            <Route
              key={route.id}
              path={mountPath(route)}
              element={
                route.page ? (
                  <div className={route.legacy ? 'legacy-page' : undefined}>
                    <route.page.Component />
                  </div>
                ) : (
                  <LandingPage title={route.label} />
                )
              }
            />
          ))}
          {SUB_ROUTES.map((route) => (
            <Route key={route.path} path={route.path} element={<Mounted page={route.page} legacy={route.legacy} />} />
          ))}
          <Route path="*" element={<PageState kind="not-found" />} />
        </Routes>
      </Suspense>
    </PageErrorBoundary>
  );
}
