/**
 * Chrome: chrome.* / Firefox: browser.*
 */
const ext = globalThis.browser ?? globalThis.chrome;

const MENU_ID = "browser-utils-copy-anchor-text";

async function ensureContextMenu() {
  await ext.contextMenus.removeAll();
  await ext.contextMenus.create({
    id: MENU_ID,
    title: "复制链接文本",
    contexts: ["link"],
  });
}

ext.runtime.onInstalled.addListener(() => {
  ensureContextMenu().catch(console.error);
});

// MV3 后台可能被回收后重启，需重新注册菜单
ensureContextMenu().catch(console.error);

ext.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = info.linkText ?? "";
  navigator.clipboard.writeText(text).catch((err) => {
    console.error("browser-utils: copy failed", err);
  });
});
