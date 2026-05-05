/**
 * Chrome: chrome.* / Firefox: browser.*
 */
const ext = globalThis.browser ?? globalThis.chrome;

const MENU_ID = "browser-utils-copy-anchor-text";

/**
 * 剪贴板写入在「经 Service Worker 再进页面」的异步链上常失去 user gesture，
 * Clipboard API 会静默失败；优先在触发右键的 frame 里同步 execCommand('copy')。
 */
async function copyLinkText(text, tab, info) {
  const tabId = tab?.id;
  if (tabId == null) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch (e) {
      console.warn("browser-utils: background clipboard failed", e);
    }
    throw new Error("no tab for clipboard");
  }

  const target = { tabId };
  if (typeof info?.frameId === "number") {
    target.frameIds = [info.frameId];
  }

  await ext.scripting.executeScript({
    target,
    func: (t) => {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.setAttribute("readonly", "");
      ta.style.cssText =
        "position:fixed!important;left:-9999px!important;top:0!important;opacity:0!important";
      const root = document.body || document.documentElement;
      root.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, t.length);
      const ok = document.execCommand("copy");
      root.removeChild(ta);
      if (ok) {
        return true;
      }
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(t);
      }
      throw new Error("browser-utils: copy failed in page");
    },
    args: [text],
  });
}

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

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = info.linkText ?? "";
  copyLinkText(text, tab, info).catch((err) => {
    console.error("browser-utils: copy failed", err);
  });
});
