const ext = globalThis.browser ?? globalThis.chrome;

const MENU_ID = "copy-link-text";

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

ensureContextMenu().catch(console.error);

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const tabId = tab?.id;
  if (tabId == null) return;

  const text = typeof info.linkText === "string" ? info.linkText : undefined;
  ext.tabs.sendMessage(
    tabId,
    { type: "copy-link-text", text },
    typeof info.frameId === "number" ? { frameId: info.frameId } : undefined,
    () => {
      const err = ext.runtime.lastError;
      if (err) {
        console.error("copy-link-text: copy sendMessage failed", err.message);
      }
    }
  );
});
