"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

const WINNAME_PREFIX = "eon_winname_";
const POPUP_INIT_KEY = "eon_popup_init";
const LABEL_TAB_SUFFIX = "/label.html";
const HOLD_TAB_SUFFIX = "/hold.html";
const MAX_TAB_LABEL_CHARS = 6;
const ACTION_BADGE_COLOR = "#0060df";

const POPUP_TARGET_KEY = "eon_popup_target_window";

let popupTargetWindowIdMemory = null;
let initPromise = null;
let isResetting = false;
let isInitializing = false;

/** 内存缓存：避免 keeper 逻辑里 await storage */
const namedWindowIds = new Set();
const keeperTabByWindow = new Map();
const KEEPER_TAB_URL = "about:blank";
const syncPendingWindowIds = new Set();
let syncFlushScheduled = false;

async function getWindowName(windowId) {
    const key = WINNAME_PREFIX + windowId;
    const result = await ext.storage.local.get(key);
    return result[key] || "";
}

async function setWindowName(windowId, name) {
    const key = WINNAME_PREFIX + windowId;
    await ext.storage.local.set({ [key]: name });
    syncNamedWindowCache(windowId, name);
    if (name.trim()) {
        scheduleNamedWindowSync(windowId);
    } else {
        await removeKeeperTab(windowId);
    }
}

async function removeWindowName(windowId) {
    const key = WINNAME_PREFIX + windowId;
    await ext.storage.local.remove(key);
    namedWindowIds.delete(windowId);
}

function syncNamedWindowCache(windowId, name) {
    const wid = normalizeWindowId(windowId);
    if (!wid) return;
    if (name.trim()) {
        namedWindowIds.add(wid);
    } else {
        namedWindowIds.delete(wid);
    }
}

async function refreshNamedWindowCache() {
    namedWindowIds.clear();
    const names = await getAllWindowNames();
    for (const [id, name] of Object.entries(names)) {
        if (name.trim()) {
            namedWindowIds.add(Number(id));
        }
    }
}

function findKeeperTab(tabs, windowId) {
    const wid = normalizeWindowId(windowId);
    if (!wid) return null;
    const trackedId = keeperTabByWindow.get(wid);
    if (!trackedId) return null;
    const tracked = tabs.find((tab) => tab.id === trackedId);
    if (tracked) return tracked;
    keeperTabByWindow.delete(wid);
    return null;
}

async function createPinnedKeeperTab(windowId) {
    const wid = normalizeWindowId(windowId);
    const created = await ext.tabs.create({
        windowId: wid,
        index: 0,
        pinned: true,
        active: false,
        url: KEEPER_TAB_URL,
    });
    keeperTabByWindow.set(wid, created.id);
    return created;
}

async function removeKeeperTab(windowId) {
    const wid = normalizeWindowId(windowId);
    if (!wid) return;
    const tabs = await ext.tabs.query({ windowId: wid });
    const keeper = findKeeperTab(tabs, wid);
    keeperTabByWindow.delete(wid);
    if (keeper) {
        const otherTabs = tabs.filter(t => t.id !== keeper.id);
        if (otherTabs.length === 0) return;
        await ext.tabs.remove(keeper.id).catch(() => {});
    }
}

function getUserTabs(tabs, keeper) {
    if (!keeper) return tabs;
    return tabs.filter((tab) => tab.id !== keeper.id);
}

async function syncNamedWindowTabs(windowId) {
    const wid = normalizeWindowId(windowId);
    if (!wid || isInitializing || isResetting) return;

    if (!namedWindowIds.has(wid)) {
        await removeKeeperTab(wid);
        return;
    }

    const win = await ext.windows.get(wid, { populate: true }).catch(() => null);
    if (!win || win.type !== "normal") return;

    const tabs = win.tabs ?? [];
    const keeper = findKeeperTab(tabs, wid);
    const userTabs = getUserTabs(tabs, keeper);

    // 只剩 keeper：自动打开普通新标签页
    if (userTabs.length === 0 && keeper) {
        await ext.tabs.create({ windowId: wid, active: true });
        return;
    }

    // 命名窗口始终保留 pinned 占位标签，避免被浏览器关闭
    if (!keeper && userTabs.length > 0) {
        await createPinnedKeeperTab(wid);
        return;
    }

    // 避免焦点落到占位标签
    if (keeper?.active && userTabs.length > 0) {
        const activeUser = userTabs.find((tab) => tab.active) ?? userTabs[userTabs.length - 1];
        if (activeUser) {
            await ext.tabs.update(activeUser.id, { active: true }).catch(() => {});
        }
    }
}

function scheduleNamedWindowSync(windowId) {
    const wid = normalizeWindowId(windowId);
    if (!wid || isInitializing || isResetting) return;
    syncPendingWindowIds.add(wid);
    if (syncFlushScheduled) return;
    syncFlushScheduled = true;
    queueMicrotask(async () => {
        syncFlushScheduled = false;
        const windowIds = [...syncPendingWindowIds];
        syncPendingWindowIds.clear();
        for (const id of windowIds) {
            try {
                await syncNamedWindowTabs(id);
            } catch (err) {
                console.warn("syncNamedWindowTabs failed", err);
            }
        }
    });
}

async function syncAllNamedWindows() {
    for (const wid of namedWindowIds) {
        try {
            await syncNamedWindowTabs(wid);
        } catch (err) {
            console.warn("syncNamedWindowTabs failed", err);
        }
    }
}

async function getAllWindowNames() {
    const all = await ext.storage.local.get(null);
    const names = {};
    for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(WINNAME_PREFIX)) {
            const id = parseInt(key.slice(WINNAME_PREFIX.length));
            names[id] = value;
        }
    }
    return names;
}

async function getAllWindows() {
    const windows = await ext.windows.getAll({ populate: true });
    const names = await getAllWindowNames();
    let currentId = await resolvePopupTargetWindowId();
    if (!currentId) {
        try {
            currentId = (await ext.windows.getLastFocused({ windowTypes: ["normal"] })).id;
        } catch {
            currentId = null;
        }
    }

    const result = [];
    for (const w of windows) {
        result.push({
            id: w.id,
            name: names[w.id] || "",
            tabCount: w.tabs ? w.tabs.length : 0,
            focused: w.focused,
            isCurrent: w.id === currentId,
            state: w.state,
            type: w.type,
        });
    }

    result.sort((a, b) => {
        if (a.isCurrent) return -1;
        if (b.isCurrent) return 1;
        return (a.name || "").localeCompare(b.name || "");
    });

    return result;
}

async function switchToWindow(windowId) {
    const win = await ext.windows.get(windowId).catch(() => null);
    if (!win) return;
    await ext.windows.update(windowId, { focused: true });
}

async function getSwitchDestination(direction) {
    const windows = await ext.windows.getAll();
    const normalIds = windows.filter(w => w.type === "normal").map(w => w.id);
    const current = await ext.windows.getCurrent();
    const idx = normalIds.indexOf(current.id);
    if (idx < 0) return null;

    const nextIdx = (idx + direction + normalIds.length) % normalIds.length;
    return normalIds[nextIdx];
}

async function moveTabToWindow(tabId, targetWindowId) {
    await ext.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
    await ext.windows.update(targetWindowId, { focused: true });
}

async function rememberPopupTargetWindow(windowId) {
    if (!windowId || windowId <= 0) return;
    const win = await ext.windows.get(windowId).catch(() => null);
    if (win?.type !== "normal") return;
    popupTargetWindowIdMemory = windowId;
    await ext.storage.session.set({ [POPUP_TARGET_KEY]: windowId });
}

async function resolvePopupTargetWindowId() {
    if (popupTargetWindowIdMemory) {
        const win = await ext.windows.get(popupTargetWindowIdMemory).catch(() => null);
        if (win?.type === "normal") return popupTargetWindowIdMemory;
        popupTargetWindowIdMemory = null;
    }

    const stored = await ext.storage.session.get(POPUP_TARGET_KEY);
    const storedId = stored[POPUP_TARGET_KEY];
    if (storedId) {
        const win = await ext.windows.get(storedId).catch(() => null);
        if (win?.type === "normal") {
            popupTargetWindowIdMemory = storedId;
            return storedId;
        }
    }
    try {
        const win = await ext.windows.getLastFocused({ windowTypes: ["normal"] });
        if (win?.type === "normal") {
            popupTargetWindowIdMemory = win.id;
            return win.id;
        }
    } catch {
        // ignore
    }
    return null;
}

async function openPopupWithInput(input, windowId) {
    await rememberPopupTargetWindow(windowId);
    if (!windowId) {
        try {
            const win = await ext.windows.getLastFocused({ windowTypes: ["normal"] });
            await rememberPopupTargetWindow(win.id);
        } catch {
            // ignore
        }
    }
    await ext.storage.session.set({ [POPUP_INIT_KEY]: input });
    const action = ext.action ?? ext.browserAction;
    if (action?.openPopup) {
        await action.openPopup();
    }
}

function normalizeWindowId(windowId) {
    const id = Number(windowId);
    return Number.isFinite(id) && id > 0 ? id : 0;
}

function isKeeperLikeTab(tab) {
    if (tab.url !== KEEPER_TAB_URL) return false;
    return tab.pinned || tab.hidden;
}

function isStaleExtensionTab(tab) {
    const url = tab.url;
    if (typeof url !== "string") return false;
    if (!url.startsWith("moz-extension://") && !url.startsWith("chrome-extension://")) {
        return false;
    }
    return url.endsWith(LABEL_TAB_SUFFIX)
        || url.endsWith(HOLD_TAB_SUFFIX)
        || url.endsWith("/workspace.html")
        || url.endsWith("/anchor.html");
}

function truncateLabel(label, max = MAX_TAB_LABEL_CHARS) {
    const chars = [...label];
    if (chars.length <= max) return label;
    return chars.slice(0, max).join("");
}

function formatTabLabel(name, windowId) {
    const trimmed = name.trim();
    return truncateLabel(trimmed || `窗${windowId}`);
}

async function updateActionLabel(windowId) {
    const wid = normalizeWindowId(windowId);
    if (isInitializing || isResetting || !wid) return;

    const win = await ext.windows.get(wid).catch(() => null);
    if (!win || win.type !== "normal") return;

    const name = await getWindowName(wid);
    const badge = formatTabLabel(name, wid);
    const fullLabel = name.trim() || `Window ${wid}`;
    const action = ext.action ?? ext.browserAction;
    if (!action) return;

    const opts = { windowId: wid };
    try {
        await action.setTitle({ title: `${fullLabel} — Eon Workspace`, ...opts });
        await action.setBadgeText({ text: badge, ...opts });
        if (action.setBadgeBackgroundColor) {
            await action.setBadgeBackgroundColor({ color: ACTION_BADGE_COLOR, ...opts });
        }
    } catch (err) {
        console.warn("updateActionLabel failed", err);
        await action.setTitle({ title: `${fullLabel} — Eon Workspace` });
        await action.setBadgeText({ text: badge });
    }
}

async function removeStaleLabelTabs() {
    const tabs = await ext.tabs.query({});
    const removeIds = tabs.filter(isStaleExtensionTab).map(tab => tab.id);
    if (removeIds.length > 0) {
        await ext.tabs.remove(removeIds);
    }
}

async function removeAllKeeperTabs() {
    keeperTabByWindow.clear();
    const tabs = await ext.tabs.query({});
    const keeperTabs = tabs.filter(isKeeperLikeTab);
    if (keeperTabs.length === 0) return;

    const tabsByWindow = new Map();
    for (const tab of tabs) {
        if (!tabsByWindow.has(tab.windowId)) tabsByWindow.set(tab.windowId, []);
        tabsByWindow.get(tab.windowId).push(tab);
    }

    const safeToRemove = [];
    for (const keeper of keeperTabs) {
        const winTabs = tabsByWindow.get(keeper.windowId) || [];
        const otherTabs = winTabs.filter(t => t.id !== keeper.id);
        if (otherTabs.length > 0) {
            safeToRemove.push(keeper.id);
        }
    }

    if (safeToRemove.length > 0) {
        await ext.tabs.remove(safeToRemove).catch(() => {});
    }
}

async function cleanupOrphanWindowNames() {
    const all = await ext.storage.local.get(null);
    const windows = await ext.windows.getAll();
    const liveIds = new Set(windows.map((w) => w.id));
    const keysToRemove = [];
    for (const key of Object.keys(all)) {
        if (!key.startsWith(WINNAME_PREFIX)) continue;
        const id = parseInt(key.slice(WINNAME_PREFIX.length), 10);
        if (!liveIds.has(id)) {
            keysToRemove.push(key);
            namedWindowIds.delete(id);
        }
    }
    if (keysToRemove.length > 0) {
        await ext.storage.local.remove(keysToRemove);
    }
}

async function cleanupExtensionState() {
    isResetting = true;
    try {
        await removeStaleLabelTabs();
        await removeAllKeeperTabs();
        await cleanupOrphanWindowNames();
        popupTargetWindowIdMemory = null;
        await ext.storage.session.clear();
    } finally {
        isResetting = false;
    }
}

async function rebuildNamedWindowState() {
    await refreshNamedWindowCache();
    await syncAllNamedWindows();
    await ensureAllActionLabels();
}

async function ensureAllActionLabels() {
    const windows = await ext.windows.getAll();
    for (const w of windows) {
        if (w.type === "normal") {
            await updateActionLabel(w.id);
        }
    }
}

async function doInit() {
    isInitializing = true;
    try {
        buildContextMenu();
        await cleanupExtensionState();
    } finally {
        // cleanupExtensionState 内部用 isResetting 阻止事件回调，
        // 此处 finally 仅确保即使 cleanup 抛错也不死锁 isInitializing
    }

    // 重建阶段放开 isInitializing，使 syncNamedWindowTabs 和
    // updateActionLabel 能正常执行，避免 keeper 标签被清除后无法重建
    isInitializing = false;
    try {
        await rebuildNamedWindowState();
    } catch (e) {
        console.warn("rebuildNamedWindowState failed", e);
    }
}

function init() {
    if (initPromise) return initPromise;
    initPromise = doInit().finally(() => {
        initPromise = null;
    });
    return initPromise;
}
function buildContextMenu() {
    ext.contextMenus.removeAll().then(() => {
        ext.contextMenus.create({
            id: "eon-send-tab",
            title: "Send Tab to Window",
            contexts: ["tab"]
        });
    });
}

async function updateSendTabSubmenu(currentWindowId) {
    await ext.contextMenus.removeAll();

    let currentWindow = null;
    if (currentWindowId) {
        currentWindow = await ext.windows.get(currentWindowId).catch(() => null);
    }
    if (!currentWindow) {
        try {
            currentWindow = await ext.windows.getLastFocused({ windowTypes: ["normal"] });
        } catch {
            return;
        }
    }

    const windows = await ext.windows.getAll({ populate: true });
    const names = await getAllWindowNames();

    const otherWindows = windows.filter(w => w.id !== currentWindow.id && w.type === "normal");
    if (otherWindows.length === 0) return;

    ext.contextMenus.create({
        id: "eon-send-tab",
        title: "Send Tab to Window",
        contexts: ["tab"]
    });

    for (const w of otherWindows) {
        const name = names[w.id] || `Window ${w.id}`;
        const tabCount = w.tabs ? w.tabs.length : 0;
        ext.contextMenus.create({
            id: `eon-send-${w.id}`,
            parentId: "eon-send-tab",
            title: `${name} (${tabCount} tab${tabCount !== 1 ? "s" : ""})`,
            contexts: ["tab"]
        });
    }

    ext.contextMenus.create({
        id: "eon-separator",
        type: "separator",
        contexts: ["tab"]
    });

    ext.contextMenus.create({
        id: "eon-rename-window",
        title: "Name This Window...",
        contexts: ["tab"]
    });
}

ext.runtime.onInstalled.addListener(init);
ext.runtime.onStartup.addListener(init);
init();

ext.windows.onFocusChanged.addListener(async (windowId) => {
    if (isInitializing || isResetting || windowId <= 0) return;
    const win = await ext.windows.get(windowId).catch(() => null);
    if (win?.type !== "normal") return;
    await rememberPopupTargetWindow(windowId);
    updateSendTabSubmenu(windowId);
    await updateActionLabel(windowId);
});

ext.windows.onCreated.addListener(async (win) => {
    if (isInitializing || isResetting || win.type !== "normal") return;
    await updateActionLabel(win.id);
    updateSendTabSubmenu();
});

function onNamedWindowTabEvent(windowId) {
    if (isInitializing || isResetting) return;
    scheduleNamedWindowSync(windowId);
}

ext.windows.onRemoved.addListener(async (windowId) => {
    const wid = normalizeWindowId(windowId);
    removeWindowName(wid);
    keeperTabByWindow.delete(wid);
    updateSendTabSubmenu();
});

ext.tabs.onCreated.addListener((tab) => {
    onNamedWindowTabEvent(tab.windowId);
});

ext.tabs.onRemoved.addListener((tabId, removeInfo) => {
    for (const [wid, keeperId] of keeperTabByWindow) {
        if (keeperId === tabId) {
            keeperTabByWindow.delete(wid);
            break;
        }
    }
    if (isInitializing || isResetting || removeInfo.isWindowClosing) return;
    onNamedWindowTabEvent(removeInfo.windowId);
});

ext.tabs.onMoved.addListener((_tabId, moveInfo) => {
    onNamedWindowTabEvent(moveInfo.windowId);
});

ext.tabs.onActivated.addListener(async ({ windowId }) => {
    if (isInitializing || isResetting) return;
    const wid = normalizeWindowId(windowId);
    await rememberPopupTargetWindow(wid);
});

ext.tabs.onAttached.addListener(async (_tabId, attachInfo) => {
    if (isInitializing || isResetting || !attachInfo.newWindowId) return;
    onNamedWindowTabEvent(attachInfo.newWindowId);
    await updateActionLabel(attachInfo.newWindowId);
    updateSendTabSubmenu();
});

ext.tabs.onDetached.addListener((_tabId, detachInfo) => {
    if (isInitializing || isResetting) return;
    onNamedWindowTabEvent(detachInfo.oldWindowId);
    updateSendTabSubmenu();
});

ext.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "eon-rename-window") {
        const name = prompt("Enter window name:");
        if (name !== null) {
            await setWindowName(tab.windowId, name.trim());
            updateSendTabSubmenu();
            updateActionLabel(tab.windowId);
        }
        return;
    }

    if (info.menuItemId.startsWith("eon-send-")) {
        const targetId = parseInt(info.menuItemId.slice("eon-send-".length));
        await moveTabToWindow(tab.id, targetId);
    }
});

ext.commands.onCommand.addListener(async (command) => {
    if (command === "switch-next") {
        const dest = await getSwitchDestination(1);
        if (dest !== null) switchToWindow(dest);
    } else if (command === "switch-previous") {
        const dest = await getSwitchDestination(-1);
        if (dest !== null) switchToWindow(dest);
    } else if (command === "send-tab") {
        await openPopupWithInput("/send ");
    } else if (command === "_execute_action") {
        try {
            const win = await ext.windows.getLastFocused({ windowTypes: ["normal"] });
            await rememberPopupTargetWindow(win.id);
        } catch {
            // ignore
        }
    }
});

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
        case "eon-getAllWindows": {
            getAllWindows().then(sendResponse);
            return true;
        }
        case "eon-getTargetWindowId": {
            resolvePopupTargetWindowId().then(sendResponse);
            return true;
        }
        case "eon-getPopupContext": {
            (async () => {
                let targetWindowId = await resolvePopupTargetWindowId();
                const windows = await getAllWindows();
                if (!targetWindowId) {
                    const focused = windows.find(w => w.focused && w.type === "normal");
                    if (focused) {
                        targetWindowId = focused.id;
                        await rememberPopupTargetWindow(targetWindowId);
                    }
                }
                if (targetWindowId) {
                    for (const w of windows) {
                        w.isCurrent = w.id === targetWindowId;
                    }
                    windows.sort((a, b) => {
                        if (a.isCurrent) return -1;
                        if (b.isCurrent) return 1;
                        return (a.name || "").localeCompare(b.name || "");
                    });
                }
                sendResponse({ targetWindowId, windows });
            })();
            return true;
        }
        case "eon-switchToWindow": {
            switchToWindow(msg.windowId);
            sendResponse(true);
            break;
        }
        case "eon-moveTab": {
            (async () => {
                try {
                    let tab;
                    const sourceWindowId = await resolvePopupTargetWindowId();
                    if (sourceWindowId) {
                        [tab] = await ext.tabs.query({ active: true, windowId: sourceWindowId });
                    }
                    if (!tab) {
                        [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
                    }
                    if (tab && !isStaleExtensionTab(tab)) {
                        await moveTabToWindow(tab.id, msg.targetWindowId);
                    }
                    sendResponse({ ok: true });
                } catch (err) {
                    console.error("eon-moveTab failed", err);
                    sendResponse({ ok: false, error: String(err) });
                }
            })();
            return true;
        }
        case "eon-setWindowName": {
            (async () => {
                try {
                    if (!msg.windowId || msg.windowId <= 0) {
                        sendResponse({ ok: false, error: "invalid window" });
                        return;
                    }
                    await setWindowName(msg.windowId, msg.name);
                    await updateActionLabel(msg.windowId);
                    updateSendTabSubmenu(msg.windowId).catch(() => {});
                    sendResponse({ ok: true });
                } catch (err) {
                    console.error("eon-setWindowName failed", err);
                    sendResponse({ ok: false, error: String(err) });
                }
            })();
            return true;
        }
        case "eon-openNewWindow": {
            (async () => {
                const win = await ext.windows.create({});
                if (msg.name) {
                    await setWindowName(win.id, msg.name);
                    await updateActionLabel(win.id);
                }
                sendResponse({ windowId: win.id });
            })();
            return true;
        }
        case "eon-cleanupExtension": {
            (async () => {
                try {
                    await cleanupExtensionState();
                    await rebuildNamedWindowState();
                    sendResponse({ ok: true });
                } catch (err) {
                    console.error("eon-cleanupExtension failed", err);
                    sendResponse({ ok: false, error: String(err) });
                }
            })();
            return true;
        }
    }
});
