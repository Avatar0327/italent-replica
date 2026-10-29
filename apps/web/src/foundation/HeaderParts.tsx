import { Avatar, Button, Drawer, Dropdown, Empty, Input, Tabs } from 'antd';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { usePermissions } from './Permissions.js';
import { useSession } from './Session.js';
import { appRoute } from './routes.js';
import { currentApp, searchMenus, type MenuHit } from './menu-nav.js';
import type { MenuNode } from './permission-snapshot.js';
import { CONFIGURATION_ROOT } from './configuration-registry.js';
import { ui } from './messages.js';
import { MenuIcon } from './ViewHeading.js';

/** 原站顶栏“当前应用 ▾”：显示当前所在应用名，点开铺满工作区的全部菜单面板，可搜索各级菜单，分组可折叠。 */
export function AppSwitch() {
  const { menus } = usePermissions();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const app = currentApp(menus, appRoute(location.pathname)?.path, ui.groups);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => event.key === 'Escape' && close();
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [open, close]);
  return (
    <>
      <Button
        ref={trigger}
        type="text"
        className={open ? 'app-switch is-open' : 'app-switch'}
        aria-label={ui.apps}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <GridIcon />
        <span className="app-switch-label">{open ? ui.closeMenus : (app?.label ?? ui.apps)}</span>
        <span className="app-switch-caret" aria-hidden="true" />
      </Button>
      {open && <AllMenus menus={menus} onNavigate={close} />}
    </>
  );
}

/** 面板打开时焦点留在面板内：Tab / Shift+Tab 在首尾之间循环（原站为整屏面板，背后内容不可操作）。 */
function keepFocusInside(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button, a[href]')];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function AllMenus({ menus, onNavigate }: { menus: MenuNode[]; onNavigate: () => void }) {
  const [keyword, setKeyword] = useState('');
  const text = keyword.trim();
  return (
    <div className="all-menus" role="dialog" aria-modal="true" aria-label={ui.allMenus} onKeyDown={keepFocusInside}>
      <Input
        className="all-menus-search"
        type="search"
        autoFocus
        aria-label={ui.searchMenus}
        placeholder={ui.searchMenus}
        value={keyword}
        maxLength={50}
        onChange={(event) => setKeyword(event.target.value)}
      />
      {text ? (
        <MenuSearchResults hits={searchMenus(menus, text, ui.groups)} keyword={text} onNavigate={onNavigate} />
      ) : (
        <MenuGroups menus={menus} onNavigate={onNavigate} />
      )}
    </div>
  );
}

/** 原站搜索结果平铺：标题“搜索结果 N”，每行菜单名（命中部分高亮）与右侧灰字路径。 */
type SearchResultsProps = { hits: MenuHit[]; keyword: string; onNavigate: () => void };
function MenuSearchResults({ hits, keyword, onNavigate }: SearchResultsProps) {
  if (!hits.length) return <Empty description={ui.noMenus} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return (
    <section className="all-menus-results" aria-label={ui.searchResults(hits.length)}>
      <h2>{ui.searchResults(hits.length)}</h2>
      {hits.map((hit) => (
        <Link key={hit.key} to={hit.path} aria-label={hit.label} onClick={onNavigate}>
          <MenuIcon />
          <Highlight text={hit.label} keyword={keyword} />
          <span className="all-menus-trail">{hit.trail.join(' > ')}</span>
        </Link>
      ))}
    </section>
  );
}

function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const at = text.indexOf(keyword);
  if (at < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, at)}
      <mark>{keyword}</mark>
      {text.slice(at + keyword.length)}
    </span>
  );
}

function MenuGroups({ menus, onNavigate }: { menus: MenuNode[]; onNavigate: () => void }) {
  const [folded, setFolded] = useState<string[]>([]);
  const toggle = (key: string) =>
    setFolded(folded.includes(key) ? folded.filter((item) => item !== key) : [...folded, key]);
  const groups = Object.entries(ui.groups)
    .map(([key, label]) => ({ key, label, items: menus.filter((menu) => menu.group === key) }))
    .filter((group) => group.items.length > 0);
  if (!groups.length) return <Empty description={ui.noMenus} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return groups.map((group) => (
    <section key={group.key} className="all-menus-group" aria-label={group.label}>
      <h2>
        <button type="button" aria-expanded={!folded.includes(group.key)} onClick={() => toggle(group.key)}>
          {group.label}
        </button>
      </h2>
      {!folded.includes(group.key) && (
        <div className="all-menus-items">
          {group.items.map((menu) => (
            <Link key={menu.path} to={menu.path} onClick={onNavigate}>
              <MenuIcon />
              {menu.label}
            </Link>
          ))}
        </div>
      )}
    </section>
  ));
}

/** 原站消息为信封图标，从右侧打开抽屉，分“通知”“@和回复我的”；复刻暂无消息接口（见后端缺口）。 */
export function MessageCenter() {
  const [open, setOpen] = useState(false);
  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={ui.noMessages} />;
  return (
    <>
      <Button
        type="text"
        className="header-icon"
        aria-label={ui.messages}
        icon={<MailIcon />}
        onClick={() => setOpen(true)}
      />
      <Drawer
        open={open}
        width={500}
        title={ui.messages}
        rootClassName="message-drawer"
        onClose={() => setOpen(false)}
        closable={{ placement: 'end' }}
      >
        <Tabs
          items={[
            { key: 'notice', label: ui.notices, children: empty },
            { key: 'mention', label: ui.mentions, children: empty },
          ]}
        />
      </Drawer>
    </>
  );
}

/** 头像入口与配置中心路由共用服务端快照计算的可见页集合。 */
export function PersonalMenu() {
  const { snapshot, loading, error } = usePermissions();
  const hasConfiguration = !loading && !error && !!snapshot.configurationPages?.length;
  const session = useSession();
  const name = session.displayName || ui.identity;
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [
          { key: 'account', label: <Link to="/settings/account">{ui.account}</Link> },
          ...(hasConfiguration
            ? [{ key: 'configuration', label: <Link to={CONFIGURATION_ROOT}>{ui.applicationConfiguration}</Link> }]
            : []),
        ],
      }}
    >
      <Button type="text" className="personal-menu" aria-label={ui.personalMenu}>
        <Avatar size={24}>{name.slice(0, 1)}</Avatar>
        <span>{name}</span>
        <span className="app-switch-caret" aria-hidden="true" />
      </Button>
    </Dropdown>
  );
}

function GridIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="1" width="5" height="5" rx="1" />
      <rect x="8" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="8" width="5" height="5" rx="1" />
      <rect x="8" y="8" width="5" height="5" rx="1" />
    </svg>
  );
}
function MailIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor">
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" strokeWidth="1.4" />
      <path d="M3 5.5l7 5.5 7-5.5" strokeWidth="1.4" />
    </svg>
  );
}
