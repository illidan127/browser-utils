(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  let lastContextLinkText = "";

  document.addEventListener(
    "contextmenu",
    (event) => {
      const el = event.target instanceof Element ? event.target : null;
      const link = el?.closest?.("a");
      if (!link) return;
      lastContextLinkText = (link.textContent ?? "").trim();
    },
    true
  );

  async function copyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText =
      "position:fixed!important;left:-9999px!important;top:0!important;opacity:0!important";
    const root = document.body || document.documentElement;
    root.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    root.removeChild(ta);
    if (ok) return true;

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    return false;
  }

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "browser-utils-copy-anchor-text") return undefined;
    const text = typeof msg.text === "string" ? msg.text : lastContextLinkText;
    copyText(text)
      .then((ok) => sendResponse({ ok }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  });
})();
