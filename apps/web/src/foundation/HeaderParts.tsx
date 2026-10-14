import { Avatar, Button, Drawer, Dropdown, Empty, Input, Tabs } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { usePermissions } from './Permissions.js';
import { useSession } from './Session.js';
import { appRoute } from './routes.js';
import { ui } from './messages.js';
import { MenuIcon } from './ViewHeading.js';

/** 原站顶栏“当前应用 ▾”：点开铺满工作区的全部菜单面板，可按名称搜索，分组可折叠。 */
export function AppSwitch() {
  const { menus } = usePermissions();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [folded, setFolded] = useState<string[]>([]);
  const current = menus.find((menu) => menu.path === appRoute(location.pathname)?.path);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const text = keyword.trim();
  const groups = Object.entries(ui.groups)
    .map(([key, label]) => ({
      key,
      label,
      items: menus.filter((menu) => menu.group === key && (!text || menu.label.includes(text))),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <>
      <Button
        type="text"
        className={open ? 'app-switch is-open' : 'app-switch'}
        aria-label={ui.apps}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <GridIcon />
        <span className="app-switch-label">{open ? ui.closeMenus : (current?.label ?? ui.apps)}</span>
        <span className="app-switch-caret" aria-hidden="true" />
      </Button>
      {open && (
        <div className="all-menus" role="dialog" aria-label={ui.allMenus}>
          <Input
            className="all-menus-search"
            type="search"
            aria-label={ui.searchMenus}
            placeholder={ui.searchMenus}
            value={keyword}
            maxLength={50}
            onChange={(event) => setKeyword(event.target.value)}
          />
          {groups.length === 0 && <Empty description={ui.noMenus} image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          {groups.map((group) => (
            <section key={group.key} className="all-menus-group" aria-label={group.label}>
              <h2>
                <button
                  type="button"
                  aria-expanded={!folded.includes(group.key)}
                  onClick={() =>
                    setFolded(
                      folded.includes(group.key) ? folded.filter((key) => key !== group.key) : [...folded, group.key],
                    )
                  }
                >
                  {group.label}
                </button>
              </h2>
              {!folded.includes(group.key) && (
                <div className="all-menus-items">
                  {group.items.map((menu) => (
                    <Link key={menu.path} to={menu.path}>
                      <MenuIcon />
                      {menu.label}
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
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

/** 原站右上角头像 + 姓名，下拉进入个人设置；其余个人菜单项复刻未提供。 */
export function PersonalMenu() {
  const session = useSession();
  const name = session.displayName || ui.identity;
  return (
    <Dropdown
      trigger={['click']}
      menu={{ items: [{ key: 'account', label: <Link to="/settings/account">{ui.account}</Link> }] }}
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
