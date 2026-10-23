// Minimal scene-tab switcher for the qualitative comparison gallery.
// No dependencies; safe to delete if you restructure the results section.

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-tab-group]").forEach((group) => {
    const groupName = group.dataset.tabGroup;
    const buttons = group.querySelectorAll(".tab-btn");
    const panelsRoot = document.querySelector(`[data-tab-panels="${groupName}"]`);
    if (!panelsRoot) return;
    const panels = panelsRoot.querySelectorAll(".tab-panel");

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        buttons.forEach((b) => b.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        const target = panelsRoot.querySelector(`[data-panel="${btn.dataset.tab}"]`);
        if (target) target.classList.add("active");
      });
    });
  });

  // Copy BibTeX to clipboard
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pre = document.getElementById(btn.dataset.copyTarget);
      if (!pre) return;
      navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = original), 1500);
      });
    });
  });
});
