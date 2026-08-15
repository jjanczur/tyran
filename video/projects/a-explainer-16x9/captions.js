/**
 * Burned-in caption renderer, shared by every composition in the slate.
 *
 * Reads window.__CAPTIONS (inlined by pipeline/scaffold.mjs — never fetched,
 * because a render-time network request is non-deterministic) and builds:
 *   - one absolutely-positioned .hf-cue per cue, all present in the DOM at
 *     page load so a cold seek to a late frame finds them,
 *   - one .hf-w span per word, so the active word can be lit.
 *
 * Everything is registered on the caller's paused timeline. No clocks, no
 * listeners: the caption state at time t is a pure function of t.
 *
 * Visibility is driven with autoAlpha and zero-duration boundary sets, which
 * the determinism contract allows on non-clip elements. The cue container is a
 * plain div inside a clip, never a .clip itself — HyperFrames owns .clip
 * visibility and fighting it desyncs the render.
 */
(function () {
  function build(tl, opts) {
    const data = window.__CAPTIONS;
    if (!data || !data.cues || !data.cues.length) return;

    const o = Object.assign(
      {
        mount: "#captions",
        // seconds of fade at each end of a cue
        fade: 0.14,
        // light the spoken word in gold
        highlight: true,
      },
      opts || {}
    );

    const mount = document.querySelector(o.mount);
    if (!mount) return;

    const words = data.words || [];

    data.cues.forEach(function (cue, ci) {
      const el = document.createElement("div");
      el.className = "hf-cue";
      el.id = "hf-cue-" + ci;

      // Words belonging to this cue, by time containment.
      const mine = words.filter(function (w) {
        return w.s >= cue.s - 0.001 && w.s < cue.e + 0.001;
      });
      const list = mine.length
        ? mine
        : cue.text.split(/\s+/).map(function (t, i, a) {
            const each = (cue.e - cue.s) / a.length;
            return { w: t, s: cue.s + each * i, e: cue.s + each * (i + 1) };
          });

      list.forEach(function (w, wi) {
        const s = document.createElement("span");
        s.className = "hf-w";
        s.id = "hf-w-" + ci + "-" + wi;
        s.textContent = w.w;
        el.appendChild(s);
        // A real space node, so the line wraps and copies like text.
        if (wi < list.length - 1) el.appendChild(document.createTextNode(" "));
      });

      mount.appendChild(el);

      // Authored hidden state, restated explicitly: a render worker seeking
      // straight to frame 900 restores what the HTML says, not what a tween
      // did on the way there.
      el.style.opacity = "0";
      el.style.visibility = "hidden";

      tl.to(el, { autoAlpha: 1, duration: o.fade, ease: "power1.out" }, cue.s);
      tl.to(el, { autoAlpha: 0, duration: o.fade, ease: "power1.in" }, Math.max(cue.s + o.fade, cue.e - o.fade));

      if (o.highlight) {
        list.forEach(function (w, wi) {
          const sel = "#hf-w-" + ci + "-" + wi;
          tl.set(sel, { color: "var(--cap-hot)" }, w.s);
          tl.set(sel, { color: "var(--cap-cold)" }, w.e);
        });
      }
    });
  }

  window.hfCaptions = build;
})();
