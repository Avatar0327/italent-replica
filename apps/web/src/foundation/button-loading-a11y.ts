import { useLayoutEffect } from 'react';

/**
 * F-582：antd 5 Button 的默认 loading 图标（DefaultLoadingIcon，rc-motion removeOnLeave）在 loading 结束后
 * 要等离场动画 transitionend 才移出 DOM；其间宽 0、透明，但内部 role="img" aria-label="loading" 仍计入按钮
 * 可访问名，读屏读作「loading 保 存」。antd 不开放这个图标的属性，ConfigProvider 也配不到，所以在页面根上
 * 统一处理：按钮已退出加载态（没有 ant-btn-loading）而图标还在时设 aria-hidden，视觉不变；加载中的图标
 * 不动，可访问名与现状一致（冒烟 AC-FE-R1c / R2b2 按 img「loading」断言加载态）。
 * 选择器跟 antd 默认前缀 ant 走（App.tsx / PortalApp.tsx 的 ConfigProvider 都未改 prefixCls）。
 */
const BUTTON = 'ant-btn';
const BUTTON_LOADING = 'ant-btn-loading';
const LOADING_ICON = 'ant-btn-loading-icon';

function syncIcon(icon: Element) {
  const button = icon.closest(`.${BUTTON}`);
  const leaving = !!button && !button.classList.contains(BUTTON_LOADING);
  if (leaving === (icon.getAttribute('aria-hidden') === 'true')) return;
  // 离场中又回到加载态时 rc-motion 复用同一节点，这里随之撤掉 aria-hidden。
  if (leaving) icon.setAttribute('aria-hidden', 'true');
  else icon.removeAttribute('aria-hidden');
}
function syncWithin(node: Element) {
  if (node.classList.contains(LOADING_ICON)) syncIcon(node);
  else if (node.classList.contains(BUTTON)) node.querySelectorAll(`.${LOADING_ICON}`).forEach(syncIcon);
}

/** 监听 root 下按钮与图标的 class 变化；弹窗、抽屉挂在 body 上，传 document.body 即覆盖全部入口。 */
export function hideLeavingLoadingIcons(root: Element): () => void {
  root.querySelectorAll(`.${LOADING_ICON}`).forEach(syncIcon);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof Element) syncWithin(record.target);
      } else {
        record.addedNodes.forEach((node) => node instanceof Element && syncWithin(node));
      }
    }
  });
  // 只看 class：自己写的 aria-hidden 不会再触发回调。
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** 应用根组件调用一次；主应用与 360 门户共用 App 入口，两边都覆盖。 */
export function useButtonLoadingA11y() {
  useLayoutEffect(() => hideLeavingLoadingIcons(document.body), []);
}
