// TAC-4DGS project page: theme toggle, video carousel, on-demand viewer, BibTeX copy.

document.addEventListener("DOMContentLoaded", () => {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Theme toggle ----------
  // Dark by default until the visitor picks one.
  const root = document.documentElement;
  const toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const current = root.dataset.theme ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch (e) {}
    });
  }

  // ---------- Video carousel ----------
  document.querySelectorAll("[data-carousel]").forEach((carousel) => {
    const track = carousel.querySelector(".carousel-track");
    const slides = [...track.querySelectorAll(".carousel-slide")];
    const prev = carousel.querySelector("[data-carousel-prev]");
    const next = carousel.querySelector("[data-carousel-next]");
    const dotsRoot = carousel.querySelector("[data-carousel-dots]");

    // One dot per scroll position (depends on how many videos are visible at once).
    let dots = [];
    const visibleCount = () => {
      const w = slides[0].getBoundingClientRect().width;
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      return Math.max(1, Math.round((track.clientWidth + gap) / (w + gap)));
    };
    const pageCount = () => Math.max(1, slides.length - visibleCount() + 1);
    const buildDots = () => {
      const n = pageCount();
      if (n === dots.length) return;
      dotsRoot.innerHTML = "";
      dots = Array.from({ length: n }, (_, i) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.setAttribute("aria-label", `Go to position ${i + 1} of ${n}`);
        dot.addEventListener("click", () => goTo(i));
        dotsRoot.appendChild(dot);
        return dot;
      });
      carousel.querySelector(".carousel-nav").hidden = n < 2;
    };

    const current = () => {
      const left = track.scrollLeft;
      let best = 0;
      slides.forEach((s, i) => {
        if (Math.abs(s.offsetLeft - track.offsetLeft - left) <
            Math.abs(slides[best].offsetLeft - track.offsetLeft - left)) best = i;
      });
      return Math.min(best, pageCount() - 1);
    };
    const goTo = (i) => {
      const idx = Math.max(0, Math.min(pageCount() - 1, i));
      track.scrollTo({ left: slides[idx].offsetLeft - track.offsetLeft, behavior: reduceMotion ? "auto" : "smooth" });
    };
    const update = () => {
      buildDots();
      const maxScroll = track.scrollWidth - track.clientWidth;
      const atEnd = track.scrollLeft >= maxScroll - 2;
      const i = atEnd ? dots.length - 1 : current();
      dots.forEach((d, j) => d.classList.toggle("active", j === i));
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = atEnd;
    };

    prev.addEventListener("click", () => goTo(current() - 1));
    next.addEventListener("click", () => goTo(current() + 1));
    track.addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
    track.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); goTo(current() + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); goTo(current() - 1); }
    });
    addEventListener("resize", update);
    update();

    // Play videos only while they are on screen; click a video to pause/resume it.
    const videos = slides.map((s) => s.querySelector("video")).filter(Boolean);
    const paused = new WeakSet();
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(({ target, isIntersecting }) => {
          if (isIntersecting && !reduceMotion && !paused.has(target)) target.play().catch(() => {});
          else target.pause();
        });
      }, { threshold: 0.5 });
      videos.forEach((v) => io.observe(v));
    }
    videos.forEach((v) => {
      if (reduceMotion) v.controls = true;
      v.addEventListener("click", () => {
        if (v.controls) return;
        if (v.paused) { paused.delete(v); v.play().catch(() => {}); }
        else { paused.add(v); v.pause(); }
      });
    });
  });

  // ---------- Interactive viewer (loaded on demand) ----------
  document.querySelectorAll("[data-viewer]").forEach((box) => {
    const btn = box.querySelector("[data-viewer-load]");
    btn?.addEventListener("click", () => {
      const frame = document.createElement("iframe");
      frame.src = "viewer/?embed=1";
      frame.title = "TAC-4DGS interactive 4D Gaussian Splatting viewer";
      frame.allow = "fullscreen";
      frame.allowFullscreen = true;
      box.replaceChildren(frame);
      frame.focus();
    });
  });

  // ---------- Copy BibTeX ----------
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pre = document.getElementById(btn.dataset.copyTarget);
      if (!pre || !navigator.clipboard) return;
      const label = btn.querySelector("span") || btn;
      navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
        const original = label.textContent;
        label.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          label.textContent = original;
          btn.classList.remove("copied");
        }, 1500);
      });
    });
  });
});
