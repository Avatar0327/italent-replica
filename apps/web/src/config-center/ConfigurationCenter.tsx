import { APP_IDS, type AppId } from '@italent/domain';
import { Empty } from 'antd';
import { useState } from 'react';
import { Link, Navigate, Route, Routes, matchRoutes, useLocation } from 'react-router';
import {
  CONFIGURATION_ROOT,
  CONFIGURATION_SECTIONS,
  configurationSectionPath,
  type ConfigurationRoute,
  type ConfigurationSection,
} from '../foundation/configuration-registry.js';
import { PageState } from '../foundation/PageState.js';
import { PermissionObject, usePermissions } from '../foundation/Permissions.js';
import { PAGES } from '../foundation/routes.js';
import { configurationUi as text } from './messages.js';
import './configuration.css';

function Placeholder({ label }: { label: string }) {
  return (
    <section className="configuration-placeholder" aria-label={label}>
      <h2>{label}</h2>
      <div className="configuration-empty">
        <Empty description={text.pending} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        <p>{text.pendingHint}</p>
      </div>
    </section>
  );
}

function ConfigurationPage({
  route,
  allowed,
  refresh,
}: {
  route: ConfigurationRoute;
  allowed: boolean;
  refresh: () => void;
}) {
  if (!allowed) return <PageState kind="forbidden" refresh={refresh} />;
  if (!route.page) return <Placeholder label={route.label} />;
  return (
    <PermissionObject object={'app' in route.access ? route.access.objectCode : undefined}>
      <route.page.Component />
    </PermissionObject>
  );
}

interface ApplicationConfigurations {
  app: AppId;
  routes: readonly ConfigurationRoute[];
}

function ApplicationNavigation({
  app,
  routes,
  activeSection,
  activePath,
}: ApplicationConfigurations & { activeSection?: ConfigurationSection; activePath?: string }) {
  const [expanded, setExpanded] = useState(true);
  const [sections, setSections] = useState<string[]>(activeSection ? [activeSection] : []);
  const toggle = (section: string) =>
    setSections((current) =>
      current.includes(section) ? current.filter((item) => item !== section) : [...current, section],
    );
  return (
    <>
      <button
        type="button"
        className="configuration-application"
        aria-expanded={expanded}
        aria-controls={`configuration-sections-${app}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{' '}
        {app === 'staff' ? text.application : PAGES.apps.find((entry) => entry.id === app)?.label}
      </button>
      <ul id={`configuration-sections-${app}`} hidden={!expanded}>
        {CONFIGURATION_SECTIONS.map((section) => {
          const children = routes.filter((route) => route.section === section);
          const path = configurationSectionPath(app, section);
          return (
            <li key={section}>
              {children.length ? (
                <>
                  <button
                    type="button"
                    aria-expanded={sections.includes(section)}
                    aria-controls={`configuration-${app}-${section}`}
                    onClick={() => toggle(section)}
                  >
                    <span aria-hidden="true">{sections.includes(section) ? '▾' : '▸'}</span> {text.sections[section]}
                  </button>
                  <ul id={`configuration-${app}-${section}`} hidden={!sections.includes(section)}>
                    {children.map((route) => (
                      <li key={route.id}>
                        <Link to={route.path} aria-current={activePath === route.path ? 'page' : undefined}>
                          {route.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Link to={path} aria-current={activePath === path ? 'page' : undefined}>
                  {text.sections[section]}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function GlobalNavigation({ routes, activePath }: { routes: readonly ConfigurationRoute[]; activePath?: string }) {
  if (!routes.length) return null;
  return (
    <section aria-label={text.global}>
      <h2 className="configuration-global">{text.global}</h2>
      <ul>
        {routes.map((route) => (
          <li key={route.id}>
            <Link to={route.path} aria-current={activePath === route.path ? 'page' : undefined}>
              {route.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 配置中心只管理导航和挂载；业务页面继续负责自己的字段/按钮权限与写入契约。 */
export function ConfigurationCenter() {
  const { snapshot, refresh } = usePermissions();
  const location = useLocation();
  const visible = PAGES.configurations.filter((route) => snapshot.configurationPages?.includes(route.id));
  if (!visible.length) return <PageState kind="forbidden" refresh={refresh} />;
  const globals = visible.filter((route) => route.placement.kind === 'global');
  const applications = APP_IDS.map((app) => ({
    app,
    routes: visible.filter((route) => route.placement.kind === 'app' && route.placement.app === app),
  })).filter(({ routes }) => routes.length);
  const sections = applications.flatMap(({ app, routes }) =>
    CONFIGURATION_SECTIONS.map((section) => ({
      app,
      section,
      path: configurationSectionPath(app, section),
      first: routes.find((route) => route.section === section),
    })),
  );
  const matched = matchRoutes(
    [
      ...visible.map((route) => ({
        path: `${route.path}${route.page ? '/*' : ''}`,
        handle: {
          app: route.placement.kind === 'app' ? route.placement.app : undefined,
          section: route.section,
          path: route.path,
        },
      })),
      ...sections.map(({ app, section, path }) => ({ path, handle: { app, section, path } })),
    ],
    location.pathname,
  )?.[0]?.route.handle;
  return (
    <section className="configuration-center">
      <header className="configuration-heading">
        <h1>{text.title}</h1>
      </header>
      <div className="configuration-body">
        <nav className="configuration-navigation" aria-label={text.navigation}>
          <GlobalNavigation routes={globals} activePath={matched?.path} />
          {applications.map((application) => (
            <ApplicationNavigation
              key={`${application.app}/${matched?.app}/${matched?.section}`}
              {...application}
              activeSection={matched?.app === application.app ? matched.section : undefined}
              activePath={matched?.path}
            />
          ))}
        </nav>
        <div className="configuration-content">
          <Routes>
            <Route index element={<Navigate replace to={visible[0]!.path} />} />
            {sections.map(({ section, path, first }) => (
              <Route
                key={path}
                path={path.slice(CONFIGURATION_ROOT.length + 1)}
                element={first ? <Navigate replace to={first.path} /> : <Placeholder label={text.sections[section]} />}
              />
            ))}
            {PAGES.configurations.map((route) => (
              <Route
                key={route.id}
                path={`${route.path.slice(CONFIGURATION_ROOT.length + 1)}${route.page ? '/*' : ''}`}
                element={<ConfigurationPage route={route} allowed={visible.includes(route)} refresh={refresh} />}
              />
            ))}
            <Route path="*" element={<PageState kind="not-found" />} />
          </Routes>
        </div>
      </div>
    </section>
  );
}
