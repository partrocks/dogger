// Copy-to-clipboard for install commands. Progressive enhancement only —
// the page works fine without JS.
document.querySelectorAll("[data-copy]").forEach((wrap) => {
  const btn = wrap.querySelector(".copy-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const text = wrap.getAttribute("data-copy") || "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older / non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently */
      }
      document.body.removeChild(ta);
    }

    const original = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1600);
  });
});
