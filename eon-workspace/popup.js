"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

const searchInput = document.getElementById("searchInput");
const windowList = document.getElementById("windowList");
const newWindowBtn = document.getElementById("newWindowBtn");

let allWindows = [];
let selectedRowIndex = -1;
let targetWindowId = null;

const COMMANDS = {
    name: async (argument) => {
        const windowId = await getBrowserWindowId();
        if (!windowId) {
            flashInputError("No active window");
            return;
        }
        const name = argument.trim();
        let result;
        try {
            result = await ext.runtime.sendMessage({
                action: "eon-setWindowName",
                windowId,
                name,
            });
        } catch {
            flashInputError("Rename failed");
            return;
        }
        if (!result?.ok) {
            flashInputError("Rename failed");
            return;
        }
        window.close();
    },
    send: async (argument) => {
        const targets = getSendTargetWindows(argument);
        if (targets.length === 0) {
            flashInputError("No matching window");
            return;
        }
        const filter = argument.trim().toLowerCase();
        const exact = targets.find(w => (w.name || "").toLowerCase() === filter);
        await sendTabToWindow((exact || targets[0]).id);
    },
};

const SHORTHAND = { n: "name" };
const COMMANDS_WITH_ARG = new Set(["name", "send"]);
const COMMANDS_WITH_WINDOW_ARG = new Set(["send"]);
const POPUP_INIT_KEY = "eon_popup_init";
const COMMAND_META = {
    name: { shorthand: "n", description: "Name current window" },
    send: { description: "Send tab to window" },
};

const parsed = {
    startsSlashed: false,
    command: "",
    argument: "",
    shorthand: "",

    clear() {
        parsed.startsSlashed = false;
        parsed.command = "";
        parsed.argument = "";
        parsed.shorthand = "";
    },

    parse(text) {
        if (!text.startsWith("/")) {
            parsed.clear();
            return;
        }
        parsed.startsSlashed = true;
        const body = text.slice(1);
        const space = body.indexOf(" ");
        if (space === -1) {
            parsed.command = body.toLowerCase();
            parsed.argument = "";
        } else {
            parsed.command = body.slice(0, space).toLowerCase();
            parsed.argument = body.slice(space + 1);
        }
        parsed.matchCommand();
    },

    matchCommand() {
        parsed.shorthand = "";
        const word = parsed.command;
        if (!word) return;

        for (const command of Object.keys(COMMANDS)) {
            if (command.startsWith(word)) {
                parsed.command = command;
                return;
            }
        }
        for (const [shorthand, command] of Object.entries(SHORTHAND)) {
            if (word === shorthand) {
                parsed.command = command;
                parsed.shorthand = shorthand;
                return;
            }
        }
        parsed.command = "";
    },
};

function clearSearchInput() {
    parsed.clear();
    searchInput.value = "";
    searchInput.classList.remove("slashCommand", "error");
}

function flashInputError(message) {
    const original = searchInput.placeholder;
    searchInput.classList.add("error");
    searchInput.placeholder = message;
    setTimeout(() => {
        searchInput.classList.remove("error");
        searchInput.placeholder = original;
    }, 1500);
}

function getCommandUsage(command) {
    if (command === "name") return "/n <name>";
    if (command === "send") return "/send <window>";
    return `/${command} <arg>`;
}

async function executeSlashCommand() {
    const { command, argument } = parsed;
    if (!command) {
        if (searchInput.value.length > 1) {
            flashInputError(`Unknown command: ${searchInput.value.split(/\s/)[0]}`);
        }
        clearSearchInput();
        render();
        return;
    }
    if (COMMANDS_WITH_ARG.has(command) && !argument.trim()) {
        flashInputError(`Usage: ${getCommandUsage(command)}`);
        return;
    }
    await COMMANDS[command](argument);
}

function isDeletion(event) {
    return event?.inputType?.startsWith("delete");
}

function getCommandMatches(prefix) {
    if (!prefix) {
        return Object.keys(COMMANDS).sort();
    }

    const matches = new Set();
    for (const command of Object.keys(COMMANDS)) {
        if (command.startsWith(prefix)) {
            matches.add(command);
        }
    }
    for (const [shorthand, command] of Object.entries(SHORTHAND)) {
        if (shorthand.startsWith(prefix)) {
            matches.add(command);
        }
    }
    return [...matches].sort();
}

function getSlashCommandPrefix() {
    if (!searchInput.value.startsWith("/")) return null;
    const body = searchInput.value.slice(1);
    if (body.includes(" ")) return null;
    return body.toLowerCase();
}

function isSlashCommandPickPhase() {
    if (!parsed.startsSlashed) return false;
    const body = searchInput.value.slice(1);
    return body.length > 0 && !body.includes(" ");
}

function isSlashTextArgPhase() {
    return parsed.startsSlashed
        && !isSlashCommandPickPhase()
        && parsed.command === "name";
}

function isSlashWindowArgPhase() {
    return parsed.startsSlashed
        && !isSlashCommandPickPhase()
        && COMMANDS_WITH_WINDOW_ARG.has(parsed.command);
}

function getSendTargetWindows(argument = parsed.argument) {
    const filter = argument.trim().toLowerCase();
    return allWindows.filter(w => {
        if (w.id < 0 || w.isCurrent || w.type !== "normal") return false;
        if (!filter) return true;
        return (w.name || "").toLowerCase().includes(filter)
            || `window ${w.id}`.includes(filter);
    });
}

function getCommandLabel(command) {
    const meta = COMMAND_META[command];
    if (meta?.shorthand) {
        return `/${command}  /${meta.shorthand}`;
    }
    return `/${command}`;
}

function applyCommandCompletion(command, withArgSpace = false) {
    const suffix = withArgSpace && COMMANDS_WITH_ARG.has(command) ? " " : "";
    searchInput.value = `/${command}${suffix}`;
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    parsed.parse(searchInput.value);
    searchInput.classList.add("slashCommand");
    render();
}

function activateSelectedCommand() {
    const rows = getVisibleRows();
    if (rows.length === 0) return;

    const row = selectedRowIndex >= 0 ? rows[selectedRowIndex] : rows[0];
    applyCommandCompletion(row.dataset.command, true);
    searchInput.focus();
}

function tryCompleteSlashCommandOnTab() {
    const str = searchInput.value;
    if (!str.startsWith("/") || str.slice(1).includes(" ")) return false;

    const prefix = str.slice(1).toLowerCase();
    if (!prefix) return false;

    const matches = getCommandMatches(prefix);
    if (matches.length !== 1) return false;

    const command = matches[0];
    if (str.toLowerCase() === `/${command}`) return false;

    applyCommandCompletion(command);
    return true;
}

function findBestNamedWindowMatch(query) {
    const q = query.trim().toLowerCase();
    if (!q) return null;

    const matches = allWindows
        .filter(w => w.id >= 0 && w.name?.trim())
        .filter(w => w.name.toLowerCase().startsWith(q))
        .sort((a, b) => a.name.length - b.name.length);

    return matches[0] ?? null;
}

function autocompleteWindowName(str) {
    const query = str.trim();
    if (!query) return;

    const match = findBestNamedWindowMatch(query);
    if (!match || match.name.length <= query.length) return;

    searchInput.value = match.name;
    searchInput.setSelectionRange(query.length, match.name.length);
}

function getFilteredWindows() {
    const filter = parsed.startsSlashed ? "" : searchInput.value.toLowerCase().trim();
    return allWindows.filter(w => {
        if (w.id < 0) return false;
        if (!filter) return true;
        return (w.name || "").toLowerCase().includes(filter)
            || `window ${w.id}`.includes(filter);
    });
}

function getVisibleRows() {
    return [...windowList.querySelectorAll(".window-row")];
}

function updateRowSelection() {
    for (const [i, row] of getVisibleRows().entries()) {
        row.classList.toggle("selected", i === selectedRowIndex);
    }
    const selected = getVisibleRows()[selectedRowIndex];
    selected?.scrollIntoView({ block: "nearest" });
}

function resetRowSelection() {
    selectedRowIndex = -1;
    updateRowSelection();
}

function cycleRowSelection(direction) {
    const rows = getVisibleRows();
    if (rows.length === 0) return;

    if (selectedRowIndex < 0) {
        selectedRowIndex = direction > 0 ? 0 : rows.length - 1;
    } else {
        selectedRowIndex = (selectedRowIndex + direction + rows.length) % rows.length;
    }
    updateRowSelection();
}

function activateSelectedRow() {
    if (isSlashCommandPickPhase()) {
        activateSelectedCommand();
        return;
    }
    if (isSlashWindowArgPhase()) {
        activateSendTarget();
        return;
    }

    const rows = getVisibleRows();
    if (rows.length === 0) return;

    if (selectedRowIndex >= 0) {
        switchToWindow(Number(rows[selectedRowIndex].dataset.windowId));
        return;
    }
    if (searchInput.value.trim()) {
        switchToWindow(Number(rows[0].dataset.windowId));
    }
}

async function activateSendTarget() {
    const rows = getVisibleRows();
    if (rows.length === 0) {
        flashInputError("No matching window");
        return;
    }
    const row = selectedRowIndex >= 0 ? rows[selectedRowIndex] : rows[0];
    await sendTabToWindow(Number(row.dataset.windowId));
}

function onSearchInput(event) {
    const str = searchInput.value;
    parsed.parse(str);
    searchInput.classList.toggle("slashCommand", parsed.startsSlashed);
    selectedRowIndex = -1;

    if (!isDeletion(event)) {
        if (!parsed.startsSlashed) {
            autocompleteWindowName(str);
        }
    }

    parsed.parse(searchInput.value);
    render();
}

async function applyPopupInit() {
    const result = await ext.storage.session.get(POPUP_INIT_KEY);
    const initial = result[POPUP_INIT_KEY];
    if (!initial) return;

    await ext.storage.session.remove(POPUP_INIT_KEY);
    searchInput.value = initial;
    parsed.parse(initial);
    searchInput.classList.toggle("slashCommand", parsed.startsSlashed);
    selectedRowIndex = -1;
}

async function loadWindows() {
    let ctx;
    try {
        ctx = await ext.runtime.sendMessage({ action: "eon-getPopupContext" });
    } catch {
        ctx = null;
    }
    targetWindowId = ctx?.targetWindowId ?? null;
    allWindows = ctx?.windows ?? [];
    await applyPopupInit();
    render();
    searchInput.focus();
}

async function getBrowserWindowId() {
    if (targetWindowId) return targetWindowId;
    targetWindowId = await ext.runtime.sendMessage({ action: "eon-getTargetWindowId" });
    return targetWindowId;
}

function render() {
    windowList.innerHTML = "";

    if (isSlashCommandPickPhase()) {
        renderCommandList();
        return;
    }

    if (parsed.startsSlashed && !isSlashCommandPickPhase()) {
        if (isSlashWindowArgPhase()) {
            renderSendTargetList();
            return;
        }
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "Type command argument...";
        windowList.appendChild(empty);
        return;
    }

    const filter = searchInput.value.toLowerCase().trim();
    const filtered = getFilteredWindows();

    if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = filter ? "No matching windows" : "No open windows";
        windowList.appendChild(empty);
        return;
    }

    for (const w of filtered) {
        windowList.appendChild(createRow(w));
    }
    updateRowSelection();
}

function renderSendTargetList() {
    const filtered = getSendTargetWindows();

    if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = parsed.argument.trim() ? "No matching windows" : "No other windows";
        windowList.appendChild(empty);
        return;
    }

    for (const w of filtered) {
        windowList.appendChild(createRow(w));
    }
    updateRowSelection();
}

function renderCommandList() {
    const prefix = getSlashCommandPrefix() ?? "";
    const matches = getCommandMatches(prefix);

    if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No matching commands";
        windowList.appendChild(empty);
        return;
    }

    for (const command of matches) {
        windowList.appendChild(createCommandRow(command));
    }
    updateRowSelection();
}

function createCommandRow(command) {
    const row = document.createElement("div");
    row.className = "window-row command-row";
    row.dataset.command = command;

    const icon = document.createElement("div");
    icon.className = "window-icon command-icon";
    icon.textContent = "/";

    const name = document.createElement("span");
    name.className = "window-name";
    name.textContent = getCommandLabel(command);

    const description = document.createElement("span");
    description.className = "tab-count";
    description.textContent = COMMAND_META[command]?.description ?? "";

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(description);

    row.addEventListener("click", () => {
        applyCommandCompletion(command, true);
        searchInput.focus();
    });

    return row;
}

function createRow(w) {
    const row = document.createElement("div");
    row.className = "window-row";
    if (w.isCurrent) row.classList.add("current");
    if (w.state === "minimized") row.classList.add("minimized");
    row.dataset.windowId = w.id;

    const icon = document.createElement("div");
    icon.className = "window-icon";
    icon.textContent = w.type === "popup" ? "📌" : w.state === "minimized" ? "▫" : w.isCurrent ? "◆" : "◇";

    const name = document.createElement("span");
    name.className = "window-name";
    name.textContent = w.name || `Window ${w.id}`;
    if (!w.name) name.classList.add("nameless");

    const tabCount = document.createElement("span");
    tabCount.className = "tab-count";
    tabCount.textContent = `${w.tabCount} tab${w.tabCount !== 1 ? "s" : ""}`;

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(tabCount);

    row.addEventListener("click", () => {
        if (row.classList.contains("editing")) return;
        if (isSlashWindowArgPhase()) {
            sendTabToWindow(w.id);
        } else {
            switchToWindow(w.id);
        }
    });

    row.addEventListener("dblclick", () => {
        if (row.classList.contains("editing")) return;
        startEdit(name, w);
    });

    return row;
}

async function switchToWindow(windowId) {
    await ext.runtime.sendMessage({ action: "eon-switchToWindow", windowId });
    window.close();
}

async function sendTabToWindow(windowId) {
    let result;
    try {
        result = await ext.runtime.sendMessage({
            action: "eon-moveTab",
            targetWindowId: windowId,
        });
    } catch {
        flashInputError("Send failed");
        return;
    }
    if (!result?.ok) {
        flashInputError("Send failed");
        return;
    }
    window.close();
}

function startEdit(nameEl, w) {
    const row = nameEl.closest(".window-row");
    row.classList.add("editing");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "window-name edit";
    input.value = w.name || "";
    input.placeholder = "Window name...";
    input.style.width = nameEl.offsetWidth + "px";

    input.addEventListener("blur", () => {
        commitEditFromInput(input, w);
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            commitEditFromInput(input, w);
        } else if (e.key === "Escape") {
            input.value = w.name || "";
            cancelEditFromInput(input, nameEl, w);
        }
    });

    nameEl.replaceWith(input);
    input.focus();
    input.select();
}

function commitEditFromInput(input, w) {
    const newName = input.value.trim();
    const nameEl = document.createElement("span");
    nameEl.className = "window-name";
    nameEl.textContent = newName || `Window ${w.id}`;
    if (!newName) nameEl.classList.add("nameless");

    input.replaceWith(nameEl);

    const row = nameEl.closest(".window-row");
    if (row) row.classList.remove("editing");

    w.name = newName;
    ext.runtime.sendMessage({
        action: "eon-setWindowName",
        windowId: w.id,
        name: newName
    });
}

function cancelEditFromInput(input, originalNameEl, w) {
    const nameEl = document.createElement("span");
    nameEl.className = "window-name";
    nameEl.textContent = w.name || `Window ${w.id}`;
    if (!w.name) nameEl.classList.add("nameless");

    input.replaceWith(nameEl);
    const row = nameEl.closest(".window-row");
    if (row) row.classList.remove("editing");
}

searchInput.addEventListener("input", onSearchInput);

searchInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        parsed.parse(searchInput.value);
        searchInput.classList.toggle("slashCommand", parsed.startsSlashed);
        if (parsed.startsSlashed) {
            if (isSlashTextArgPhase() || (!isSlashCommandPickPhase() && !isSlashWindowArgPhase())) {
                await executeSlashCommand();
            } else {
                activateSelectedRow();
            }
        } else {
            activateSelectedRow();
        }
        return;
    }
    if (e.key === "Tab") {
        e.preventDefault();
        if (parsed.startsSlashed && isSlashCommandPickPhase() && !e.shiftKey && tryCompleteSlashCommandOnTab()) {
            return;
        }
        cycleRowSelection(e.shiftKey ? -1 : 1);
        return;
    }
    if (e.key === "Escape" && parsed.startsSlashed) {
        e.preventDefault();
        clearSearchInput();
        render();
        return;
    }
    if (e.key === "ArrowDown") {
        e.preventDefault();
        const rows = getVisibleRows();
        if (rows.length === 0) return;
        selectedRowIndex = selectedRowIndex < 0 ? 0 : Math.min(selectedRowIndex + 1, rows.length - 1);
        updateRowSelection();
        return;
    }
    if (e.key === "ArrowUp") {
        e.preventDefault();
        if (selectedRowIndex <= 0) {
            resetRowSelection();
        } else {
            selectedRowIndex--;
            updateRowSelection();
        }
    }
});

newWindowBtn.addEventListener("click", async () => {
    await ext.runtime.sendMessage({ action: "eon-openNewWindow", name: "" });
    window.close();
});

document.addEventListener("DOMContentLoaded", loadWindows);

window.addEventListener("focus", () => {
    loadWindows();
});
