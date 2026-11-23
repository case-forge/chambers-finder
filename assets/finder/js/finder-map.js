/* Chambers Finder: the map. England and Wales drawn from england-wales.json (the ONS county
 * boundaries, simplified: the licence wording is inside that file), with a pin for every chambers (or court) in the list and a mark for where the
 * search started. No map library and no tiles: the page's promise is that nothing leaves the device, and a tile
 * map would tell a tile server where you are looking.
 *
 * The geometry (project, decode, fitView, clusterPoints) is plain functions the tests load directly; create()
 * is the DOM part: it draws an SVG, pans and zooms it, and reports hover and click to the page.
 *
 * Working units: world coordinates are miles on the projection below (x east, y south), screen coordinates are pixels,
 * and a view is { cx, cy, s } = the world point at the centre and pixels per mile. */
(function (root) {
  "use strict";

  // The projection Ordnance Survey maps use: a transverse Mercator on the meridian 2 degrees west, so England and Wales
  // read as they do on an OS map and a mile is a mile to within a fraction of a per cent from Cornwall to Northumberland
  // (a flat plane at one latitude was up to 6 per cent out east to west). Spherical, which is plenty at this size.
  const NS = "http://www.w3.org/2000/svg";
  const EARTH = 3958.8;                                   // miles
  const K0 = 0.9996, L0 = (-2 * Math.PI) / 180, RAD = Math.PI / 180;

  /** (lat, lon) in degrees to world miles: x east, y south (the way the screen counts). */
  const project = (lat, lon) => {
    const f = lat * RAD, dl = lon * RAD - L0;
    return { x: K0 * EARTH * Math.atanh(Math.cos(f) * Math.sin(dl)), y: -K0 * EARTH * Math.atan2(Math.tan(f), Math.cos(dl)) };
  };

  /** Turns a start-plus-steps array ([lon0, lat0, dlon, dlat, ...], thousandths of a degree) into world points. */
  function decodeLine(a, unit) {
    const out = [];
    let lon = 0, lat = 0;
    for (let i = 0; i + 1 < a.length; i += 2) {
      lon = i === 0 ? a[0] : lon + a[i];
      lat = i === 0 ? a[1] : lat + a[i + 1];
      out.push(project(lat * unit, lon * unit));
    }
    return out;
  }

  const pathOf = (lines, closed) =>
    lines.map((pts) => "M" + pts.map((p) => p.x.toFixed(1) + " " + p.y.toFixed(1)).join("L") + (closed ? "Z" : "")).join("");

  /** The outline file as SVG path data in world miles, with its bounds. */
  function decodeOutline(outline) {
    const land = outline.land.map((a) => decodeLine(a, outline.unit));
    const lines = outline.lines.map((a) => decodeLine(a, outline.unit));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    land.forEach((r) => r.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }));
    return { landPath: pathOf(land, true), linesPath: pathOf(lines, false), bounds: { minX, maxX, minY, maxY } };
  }

  /** The view that shows `bounds` inside a width x height box with `pad` pixels of margin. */
  function fitView(bounds, width, height, pad, maxScale) {
    const w = Math.max(bounds.maxX - bounds.minX, 1), h = Math.max(bounds.maxY - bounds.minY, 1);
    let s = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
    if (maxScale) s = Math.min(s, maxScale);
    return { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, s };
  }

  /** SVG path data of a circle of `miles` round (lat, lon), as it lies on the ground, in world miles. */
  function circlePath(lat, lon, miles) {
    const d = miles / EARTH, rad = RAD, f1 = lat * rad, l1 = lon * rad;
    const pts = [];
    for (let deg = 0; deg < 360; deg += 5) {
      const t = deg * rad;
      const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
      const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
      const p = project(f2 / rad, l2 / rad);
      pts.push(p.x.toFixed(1) + " " + p.y.toFixed(1));
    }
    return "M" + pts.join("L") + "Z";
  }

  const toScreen = (view, W, H, p) => ({ x: (p.x - view.cx) * view.s + W / 2, y: (p.y - view.cy) * view.s + H / 2 });

  /** Groups points that would land within `cell` pixels of each other. Points whose id is in `apart` stay single. */
  function clusterPoints(points, view, W, H, cell, apart) {
    const cells = new Map(), singles = [];
    // The grid can split places that sit a few metres apart, and joining the cells below averages as it goes, so which
    // places end up together depended on the order of the list. A star or a hide reorders the list, and a fan that was
    // open then no longer matched its group (one place had split off) and closed. A fixed order gives the same groups on
    // every redraw.
    points = points.slice().sort((a, b) => { const ka = a.id + "|" + (a.branch || ""), kb = b.id + "|" + (b.branch || ""); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    points.forEach((pt) => {
      const sp = toScreen(view, W, H, pt.world);
      if (sp.x < -30 || sp.y < -30 || sp.x > W + 30 || sp.y > H + 30) return;       // off the map: not drawn
      if (apart && apart.has(pt.id)) { singles.push({ points: [pt], x: sp.x, y: sp.y }); return; }
      const key = pt.kind + ":" + Math.floor(sp.x / cell) + ":" + Math.floor(sp.y / cell);
      const c = cells.get(key);
      if (c) { c.points.push(pt); c.x += sp.x; c.y += sp.y; } else cells.set(key, { points: [pt], x: sp.x, y: sp.y });
    });
    // The grid can split places that sit together (one just across a cell edge). Join groups whose centres are
    // closer than most of a cell, so places that overlap on screen are always one group.
    const merged = [];
    cells.forEach((c) => {
      const g = { points: c.points, x: c.x / c.points.length, y: c.y / c.points.length, kind: c.points[0].kind };
      const near = merged.find((h) => h.kind === g.kind && Math.hypot(h.x - g.x, h.y - g.y) < cell * 0.7);
      if (near) {
        const a = near.points.length, b2 = g.points.length;
        near.x = (near.x * a + g.x * b2) / (a + b2); near.y = (near.y * a + g.y * b2) / (a + b2);
        near.points = near.points.concat(g.points);
      } else merged.push(g);
    });
    const out = singles;
    merged.forEach((g) => out.push({ points: g.points, x: g.x, y: g.y }));
    return out;
  }

  /** Builds the map in `container` and returns what the page drives it with. */
  function create(container, outline, opts) {
    const o = opts || {};
    const world = decodeOutline(outline);
    const reduceMotion = !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const el = (name, attrs, parent) => {
      const n = document.createElementNS(NS, name);
      Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
      if (parent) parent.appendChild(n);
      return n;
    };

    container.classList.add("fmap");
    const svg = el("svg", { class: "fmap-svg", "aria-hidden": "true", focusable: "false" });
    const sea = el("rect", { class: "fmap-sea" }, svg);
    const worldG = el("g", { class: "fmap-world" }, svg);
    el("path", { class: "fmap-land", d: world.landPath, "fill-rule": "evenodd" }, worldG);
    el("path", { class: "fmap-borders", d: world.linesPath }, worldG);
    const ring = el("path", { class: "fmap-ring", d: "" }, worldG);
    const pinsG = el("g", { class: "fmap-pins" }, svg);
    container.appendChild(svg);

    const controls = document.createElement("div");
    controls.className = "fmap-controls";
    const mk = (text, label, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = text; b.setAttribute("aria-label", label); b.title = label;
      b.addEventListener("click", fn); controls.appendChild(b); return b;
    };
    container.appendChild(controls);
    const key = document.createElement("div");
    key.className = "fmap-key";
    key.innerHTML = '<span class="contacted">Contacted</span><span class="starred">Starred</span><span class="hidden">Hidden</span><span class="shape-court">Court</span>';
    container.appendChild(key);
    // The licence of the boundaries asks for this wording wherever they are shown.
    const attrib = document.createElement("div");
    attrib.className = "fmap-attrib";
    attrib.textContent = outline.source || "";
    container.appendChild(attrib);

    let W = 300, H = 300, points = [], start = null, radius = null, hot = new Set(), view = { cx: 0, cy: 0, s: 1 };
    let fitted = null, restore = null, anim = 0, hoverId = null, pinnedUntil = 0, spot = null;      // spot: the one office a Map press asked for ({ id, pk }), kept lit until the view is moved
    const fanned = new Map();                                   // clusters of places on one spot that are spread out: key -> members
    const keyOf = (g) => g.points.map((q) => q.id + "|" + (q.branch || "")).sort().join(",");
    const pk = (q) => q.id + "|" + (q.branch || "");            // one place: a chambers has a pin per branch
    // Places that no zoom can pull apart (same address, or a few metres off): pressing their number fans them out
    // instead of zooming, at any zoom. At the closest zoom they would still share a cell of the cluster grid.
    const isStack = (g) => g.points.every((a) => g.points.every((b) => Math.hypot(a.world.x - b.world.x, a.world.y - b.world.y) * maxScale < 20));
    const drawn = new Map();                                    // where each pin was drawn this time (a fanned pin is not at its place)
    const allView = () => fitView(world.bounds, W, H, 10);
    const minScale = () => allView().s * 0.9, maxScale = 40;

    function layoutWorld() {
      const t = `translate(${W / 2 - view.cx * view.s} ${H / 2 - view.cy * view.s}) scale(${view.s})`;
      worldG.setAttribute("transform", t);
      sea.setAttribute("width", W); sea.setAttribute("height", H);
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      ring.setAttribute("d", start && radius ? circlePath(start.lat, start.lon, radius) : "");
    }

    let drawing = false;                                        // a redraw moves focus about; those events are not the user's
    function draw() {
      if (drawing) return;
      drawing = true;
      try { drawNow(); } finally { drawing = false; }
    }
    function drawNow() {
      layoutWorld();
      // Redrawing replaces every element, so a keyboard user's focus is put back on the same one afterwards.
      const act = document.activeElement;
      const focused = act && pinsG.contains(act) ? { pk: act.getAttribute("data-pk"), key: act.getAttribute("data-key"), badge: act.classList.contains("fmap-fan-badge") } : null;
      pinsG.textContent = "";
      drawn.clear();
      // Where the search started goes underneath the pins: a ring round whatever sits there, not a lid over it.
      if (start) {
        const sp = toScreen(view, W, H, start.world);
        const g = el("g", { class: "fmap-start" }, pinsG);
        el("circle", { class: "halo", cx: sp.x, cy: sp.y, r: 15 }, g);
        el("circle", { class: "dot", cx: sp.x, cy: sp.y, r: 2.5 }, g);
        const t = el("text", { class: "fmap-label", x: sp.x + 20, y: sp.y + 4 }, g); t.textContent = start.label;
      }
      // A place under the pointer is pulled out of its cluster so it can be seen, except inside a fan: a fanned
      // place is already apart, and pulling it out would change the cluster and close the fan under the pointer.
      const apart = new Set(hot);
      if (fanned.size) clusterPoints(points, view, W, H, 16, new Set()).forEach((g) => { if (g.points.length > 1 && fanned.has(keyOf(g))) g.points.forEach((q) => apart.delete(q.id)); });
      const groups = clusterPoints(points, view, W, H, 16, apart);
      const order = (g) => (g.points.length > 1 ? 0 : g.points[0].dim ? 1 : g.points[0].state ? 3 : 2);
      groups.sort((a, b) => order(a) - order(b));
      // One group per place: a wide invisible circle to press on, and the mark. A court is a square, a chambers a circle;
      // the colour is its state (contacted, starred, hidden, or grey for none of those).
      const drawPin = (pt, x, y, inFan) => {
        const isHot = hot.has(pt.id) || (spot !== null && pk(pt) === spot.pk);
        const r = isHot ? 7 : 4.5;
        drawn.set(pk(pt), { x, y });
        const attrs = { class: "fmap-pin" + (pt.kind === "court" ? " court" : "") + (pt.state ? " " + pt.state : "") + (pt.dim ? " dim" : "") + (isHot ? " hot" : "") + (inFan ? " fanned" : ""), "data-pid": pt.id, "data-pk": pk(pt) };
        // A fanned place can be reached and pressed from the keyboard; the others are in the list below the map.
        if (inFan) Object.assign(attrs, { tabindex: "0", role: "button", "aria-label": pt.label + (pt.branch ? ", " + pt.branch : "") });
        const pin = el("g", attrs, pinsG);
        el("circle", { class: "fmap-hit", cx: x, cy: y, r: inFan ? 14 : Math.max(r, 10) }, pin);
        if (pt.kind === "court") el("rect", { class: "body", x: x - r, y: y - r, width: 2 * r, height: 2 * r, rx: 1.5 }, pin);
        else el("circle", { class: "body", cx: x, cy: y, r }, pin);
        const ti = el("title", {}, pin); ti.textContent = pt.label + (pt.sub ? " · " + pt.sub : "");
      };
      groups.forEach((g) => {
        if (g.points.length > 1) {
          const n = g.points.length, key = keyOf(g);
          // Places this close are one spot on the ground (several chambers share a city-centre point): no zoom pulls
          // them apart, so pressing the number fans them out round it instead.
          const together = view.s >= maxScale * 0.98 || isStack(g);
          if (together && fanned.has(key)) {
            const ring = 16 + 3 * n;
            // Equal spokes, the same length. Turned (never moved) so that none points at the search's own marker or
            // the name beside it.
            let turn = -Math.PI / 2;
            const sp = start ? toScreen(view, W, H, start.world) : null;
            if (sp) {
              const step = (2 * Math.PI) / n;
              let bestScore = -1;
              for (let t = 0; t < 24; t++) {
                const off = -Math.PI / 2 + (step * t) / 24;
                let score = Infinity;
                for (let k = 0; k < n; k++) {
                  const a2 = off + step * k, x = g.x + Math.cos(a2) * ring, y = g.y + Math.sin(a2) * ring;
                  score = Math.min(score, Math.hypot(x - sp.x, y - sp.y), Math.hypot(x - (sp.x + 70), y - sp.y));
                }
                if (score > bestScore) { bestScore = score; turn = off; }
              }
            }
            const lines = el("g", { class: "fmap-fan-lines" }, pinsG);
            g.points.forEach((pt, k) => {
              const a2 = turn + (2 * Math.PI * k) / n, x = g.x + Math.cos(a2) * ring, y = g.y + Math.sin(a2) * ring;
              el("line", { x1: g.x, y1: g.y, x2: x, y2: y }, lines);
            });
            // The number stays in the middle; pressing it folds the fan up again.
            const badge = el("g", { class: "fmap-fan-badge", "data-key": key, "data-cx": g.x, "data-cy": g.y, tabindex: "0", role: "button", "aria-label": n + " places here, spread out. Press to fold them up." }, pinsG);
            el("circle", { cx: g.x, cy: g.y, r: 9 }, badge);
            const bt = el("text", { x: g.x, y: g.y + 3.5, "text-anchor": "middle" }, badge); bt.textContent = n;
            g.points.forEach((pt, k) => {
              const a2 = turn + (2 * Math.PI * k) / n;
              drawPin(pt, g.x + Math.cos(a2) * ring, g.y + Math.sin(a2) * ring, true);
            });
            return;
          }
          const r = 7 + Math.min(6, Math.log2(n) * 2);
          const contacted = g.points.filter((q) => q.state === "contacted").length;
          // a green ring round the count says someone in it has been contacted
          const gg = el("g", { class: "fmap-cluster" + (contacted ? " contacted" : ""), "data-cx": g.x, "data-cy": g.y, "data-key": key, "data-together": together ? "1" : "", "data-members": g.points.map(pk).join("\n"), tabindex: "0", role: "button", "aria-label": n + " places here" + (together ? ". Press to spread them out." : ". Press to zoom in.") }, pinsG);
          el("circle", { cx: g.x, cy: g.y, r }, gg);
          const t = el("text", { x: g.x, y: g.y + 3.5, "text-anchor": "middle" }, gg); t.textContent = n;
          const ti = el("title", {}, gg);
          ti.textContent = n + " places here" + (contacted ? ", " + contacted + " contacted" : "") + (together ? ". Click to spread them out." : ". Click to zoom in.");
          return;
        }
        drawPin(g.points[0], g.x, g.y);
      });
      // What is hot is named beside its pin, on top of everything.
      const hotPts = points.filter((p) => hot.has(p.id) || (spot !== null && pk(p) === spot.pk));
      hotPts.forEach((pt) => {
        const sp = drawn.get(pk(pt)) || toScreen(view, W, H, pt.world);
        if (sp.x < 0 || sp.y < 0 || sp.x > W || sp.y > H) return;
        const several = hotPts.filter((q) => q.id === pt.id).length > 1;     // one chambers, several branches lit
        const t = el("text", { class: "fmap-label hot", x: sp.x + 10, y: sp.y + 4 }, pinsG);
        t.textContent = several && pt.branch ? pt.label + ": " + pt.branch : pt.label;
      });
      if (focused) {
        const sel = focused.pk ? `[data-pk="${CSS.escape(focused.pk)}"]` : focused.key ? (focused.badge ? ".fmap-fan-badge" : ".fmap-cluster") + `[data-key="${CSS.escape(focused.key)}"]` : null;
        const again = sel && pinsG.querySelector(sel);
        if (again && typeof again.focus === "function") again.focus({ preventScroll: true });
      }
    }

    const clamp = (v) => {
      const lo = minScale();
      v.s = Math.max(lo, Math.min(maxScale, v.s));
      // keep the middle of the map over the land: never lose England and Wales off the edge
      v.cx = Math.max(world.bounds.minX, Math.min(world.bounds.maxX, v.cx));
      v.cy = Math.max(world.bounds.minY, Math.min(world.bounds.maxY, v.cy));
      return v;
    };
    function setView(v, animate) {
      cancelAnimationFrame(anim);
      const to = clamp({ ...v });
      if (!animate || reduceMotion) { view = to; draw(); return; }
      const from = { ...view }, t0 = performance.now(), ms = 240;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
        view = { cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, s: from.s * Math.pow(to.s / from.s, e) };
        draw();
        if (k < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    }
    function zoomAt(factor, sx, sy, animate) {
      const x = sx === undefined ? W / 2 : sx, y = sy === undefined ? H / 2 : sy;
      const wx = view.cx + (x - W / 2) / view.s, wy = view.cy + (y - H / 2) / view.s;
      const s = Math.max(minScale(), Math.min(maxScale, view.s * factor));
      fanned.clear();                                             // zooming folds a fan up
      setView({ s, cx: wx - (x - W / 2) / s, cy: wy - (y - H / 2) / s }, animate);
    }

    // ── the page's controls ─────────────────────────────────────────────────────────────────────────────
    mk("+", "Zoom in", () => { restore = null; spot = null; zoomAt(1.6, undefined, undefined, true); });
    mk("−", "Zoom out", () => { restore = null; spot = null; zoomAt(1 / 1.6, undefined, undefined, true); });
    mk("Fit", "Show the places in the list", () => { restore = null; spot = null; hot = new Set(); if (fitted) setView(fitted, true); });
    mk("All", "Show all of England and Wales", () => { restore = null; spot = null; hot = new Set(); setView(allView(), true); });
    if (o.onHide) mk("Hide", "Hide the map", o.onHide);

    // ── panning and zooming ─────────────────────────────────────────────────────────────────────────────
    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-pid], .fmap-cluster, .fmap-fan-badge")) return;
      if (fanned.size || spot) { fanned.clear(); spot = null; draw(); }
      if (e.pointerType === "touch" || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
      svg.setPointerCapture(e.pointerId); container.classList.add("dragging"); restore = null;
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      view = clamp({ s: view.s, cx: drag.cx - dx / view.s, cy: drag.cy - dy / view.s }); draw();
    });
    const endDrag = () => { drag = null; container.classList.remove("dragging"); };
    svg.addEventListener("pointerup", endDrag); svg.addEventListener("pointercancel", endDrag);
    svg.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;                      // a plain scroll belongs to the page
      e.preventDefault(); restore = null;
      const r = svg.getBoundingClientRect();
      zoomAt(Math.pow(1.002, -e.deltaY), e.clientX - r.left, e.clientY - r.top, false);
    }, { passive: false });
    svg.addEventListener("dblclick", (e) => {
      const r = svg.getBoundingClientRect(); restore = null; zoomAt(2, e.clientX - r.left, e.clientY - r.top, true);
    });

    // ── pins: hover and click ───────────────────────────────────────────────────────────────────────────
    pinsG.addEventListener("pointerover", (e) => {
      const p = e.target.closest("[data-pid]");
      const id = p ? p.getAttribute("data-pid") : null;
      if (id === hoverId) return;
      hoverId = id;
      if (o.onHover) o.onHover(id);
      api.highlight(id ? [id] : null, true);
    });
    pinsG.addEventListener("pointerleave", () => { if (hoverId !== null) { hoverId = null; if (o.onHover) o.onHover(null); api.highlight(null, true); } });
    // A press counts if it ends on the same place it began. The pins are drawn afresh whenever the pointer enters one,
    // so the element pressed can be replaced before the button is released and the browser's own "click" is lost;
    // comparing the place (its id, or a cluster's position) survives that.
    const what = (t) => {
      const p = t.closest && t.closest("[data-pid]");
      if (p) return "p:" + p.getAttribute("data-pid");
      const bd = t.closest && t.closest(".fmap-fan-badge");
      if (bd) return "b:" + bd.getAttribute("data-key");
      const c = t.closest && t.closest(".fmap-cluster");
      return c ? "c:" + c.getAttribute("data-cx") + ":" + c.getAttribute("data-cy") + ":" + (c.getAttribute("data-together") ? c.getAttribute("data-key") : "") : null;
    };
    let pressed = null, handledAt = -1e9;
    pinsG.addEventListener("pointerdown", (e) => { pressed = e.button === 0 ? what(e.target) : null; });
    const activate = (was) => {
      if (was[0] === "p") { if (o.onSelect) o.onSelect(was.slice(2)); return; }
      if (was[0] === "b") { fanned.delete(was.slice(2)); draw(); return; }
      const [, cx, cy, ...rest] = was.split(":"), key = rest.join(":");
      restore = null;
      if (key) openFan(key); else zoomAt(2.4, Number(cx), Number(cy), true);
    };
    pinsG.addEventListener("pointerup", (e) => {
      const was = pressed; pressed = null;
      if (!was || what(e.target) !== was) return;
      handledAt = performance.now();
      activate(was);
    });
    // A touch screen can give only a click (no pointer down and up pair reaches us): the same press, once.
    pinsG.addEventListener("click", (e) => {
      if (performance.now() - handledAt < 600) return;
      const was = what(e.target);
      if (was) activate(was);
    });
    // Opens the fan of the cluster with this key (its members are read off the drawn cluster).
    function openFan(key) {
      const c = [...pinsG.querySelectorAll(".fmap-cluster")].find((n) => n.getAttribute("data-key") === key);
      fanned.set(key, c ? c.getAttribute("data-members").split("\n") : []);
      draw();
    }
    // The same presses from the keyboard: Enter or Space on a number, a fanned pin or the middle badge; Escape folds a fan.
    pinsG.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target;
      if (!t || !t.closest) return;
      const p = t.closest("[data-pid]");
      const bd = t.closest(".fmap-fan-badge");
      const c = t.closest(".fmap-cluster");
      if (!p && !bd && !c) return;
      e.preventDefault();
      if (p) { if (o.onSelect) o.onSelect(p.getAttribute("data-pid")); return; }
      if (bd) {
        const key = bd.getAttribute("data-key");
        fanned.delete(key); draw();
        const back = [...pinsG.querySelectorAll(".fmap-cluster")].find((n) => n.getAttribute("data-key") === key);
        if (back) back.focus({ preventScroll: true });
        return;
      }
      if (c.getAttribute("data-together")) {
        const key = c.getAttribute("data-key");
        openFan(key);
        const badge = [...pinsG.querySelectorAll(".fmap-fan-badge")].find((n) => n.getAttribute("data-key") === key);
        if (badge) badge.focus({ preventScroll: true });
      } else zoomAt(2.4, Number(c.getAttribute("data-cx")), Number(c.getAttribute("data-cy")), true);
    });
    const onEscape = (e) => {
      if (e.key !== "Escape" || !fanned.size) return;
      const keys = [...fanned.keys()];
      const inside = container.contains(document.activeElement);            // asked before the redraw replaces it
      fanned.clear(); spot = null;
      if (inside && hoverId !== null) { hoverId = null; if (o.onHover) o.onHover(null); hot = new Set(); }
      draw();
      const back = pinsG.querySelector(`.fmap-cluster[data-key="${CSS.escape(keys[0])}"]`);
      if (inside && back) back.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onEscape);
    // A fanned place named by the keyboard as well as by the pointer.
    pinsG.addEventListener("focusin", (e) => {
      if (drawing) return;
      const p = e.target.closest && e.target.closest("[data-pid]");
      const id = p ? p.getAttribute("data-pid") : null;
      if (!id) return;
      hoverId = id;
      if (o.onHover) o.onHover(id);
      api.highlight([id], true);
    });
    pinsG.addEventListener("focusout", (e) => {
      if (drawing) return;
      if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-pid]")) return;
      // Redrawing removes the focused element and puts focus on its replacement; a browser may report the removal
      // afterwards. Only clear the name when focus has really left the map's places.
      setTimeout(() => {
        if (pinsG.contains(document.activeElement) || hoverId === null) return;
        hoverId = null; if (o.onHover) o.onHover(null); api.highlight(null, true);
      }, 0);
    });
    pinsG.addEventListener("pointercancel", () => { pressed = null; });

    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => api.resize()) : null;
    if (ro) ro.observe(container);

    const api = {
      el: container,
      resize() {
        const r = container.getBoundingClientRect();
        if (!r.width || !r.height) return;
        W = r.width; H = r.height;
        if (fitted && !api._moved) fitted = fitView(fitted.bounds || world.bounds, W, H, 28, 12);
        draw();
      },
      setStart(s) { start = s ? { ...s, world: project(s.lat, s.lon) } : null; draw(); },
      setRadius(miles) { radius = miles || null; draw(); },
      setPoints(list) {
        points = list.map((p) => ({ ...p, world: project(p.lat, p.lon) }));
        // A list redraw (a star, a hide, a Map press) keeps a fan open while every place in it is still there.
        const have = new Set(points.map(pk));
        if (spot && !points.some((p) => pk(p) === spot.pk)) spot = null;
        [...fanned].forEach(([key, members]) => { if (!members.length || members.some((m) => !have.has(m))) fanned.delete(key); });
        draw();
      },
      /** Frames the start point and `list` (the places showing); that is where Fit goes back to. */
      fit(list, animate) {
        const pts = (list || points).map((p) => p.world || project(p.lat, p.lon)).concat(start ? [start.world] : []);
        if (!pts.length) return;
        const b = { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
        fitted = { ...fitView(b, W, H, 28, 12), bounds: b };
        setView(fitted, animate);
      },
      /** Marks places red. If one is off the map, the view widens to take in the start point and it, and goes back after. */
      highlight(ids, fromMap) {
        hot = new Set(ids || []);
        const hotPts = points.filter((p) => hot.has(p.id));
        const off = hotPts.some((p) => { const sp = toScreen(view, W, H, p.world); return sp.x < 14 || sp.y < 14 || sp.x > W - 14 || sp.y > H - 14; });
        // While a place has been asked for (a Map press) or a fan is open, hovering a row marks its pin and nothing more:
        // the page scrolls to the map and rows slide under the pointer, and their hover must not zoom the map away.
        if (off && !fromMap && performance.now() >= pinnedUntil && !spot && !fanned.size) {
          if (!restore) restore = { ...view };
          const pts = hotPts.map((p) => p.world).concat(start ? [start.world] : []);
          const b = { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
          setView(fitView(b, W, H, 40, 12), true);
        } else if (!hot.size && restore && !fromMap) { const back = restore; restore = null; setView(back, true); }
        else draw();
      },
      /** Shows one place: marks it red and zooms to it, with the start point in view. `branch` picks one office of a chambers. */
      focus(id, branch) {
        const p = points.find((q) => q.id === id && (!branch || q.branch === branch)) || points.find((q) => q.id === id);
        if (!p) return false;
        spot = { id, pk: pk(p) }; hot = new Set(); restore = null; fanned.clear(); pinnedUntil = performance.now() + 1500;
        // Close enough to tell it from its neighbours (a place a few streets from another needs a closer look than one
        // in a field); never past the closest zoom. Places that no zoom separates are fanned out round their number.
        let near = Infinity;
        points.forEach((q) => { if (q !== p) near = Math.min(near, Math.hypot(q.world.x - p.world.x, q.world.y - p.world.y)); });
        const need = Math.min(maxScale, Math.max(6, 20 / Math.max(near, 1e-6)));
        const pts = [p.world].concat(start ? [start.world] : []);
        const b = { minX: Math.min(...pts.map((q) => q.x)), maxX: Math.max(...pts.map((q) => q.x)), minY: Math.min(...pts.map((q) => q.y)), maxY: Math.max(...pts.map((q) => q.y)) };
        let v = fitView(b, W, H, 40, need);
        if (v.s < need * 0.999) v = { s: need, cx: p.world.x, cy: p.world.y };            // the start is too far to keep in view
        setView(v, true);
        const end = clamp({ ...v });
        const g = clusterPoints(points, end, W, H, 16, new Set()).find((c) => c.points.length > 1 && c.points.some((q) => pk(q) === pk(p)));
        if (g && (end.s >= maxScale * 0.98 || isStack(g))) fanned.set(keyOf(g), g.points.map(pk));      // as the drawing decides: nothing more to zoom
        return true;
      },
      isHot: (id) => hot.has(id),
      destroy() { cancelAnimationFrame(anim); if (ro) ro.disconnect(); document.removeEventListener("keydown", onEscape); container.textContent = ""; container.classList.remove("fmap", "dragging"); },
    };
    api.resize();
    return api;
  }

  const api = { project, decodeOutline, fitView, clusterPoints, circlePath, create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CFMap = api;
})(typeof window !== "undefined" ? window : globalThis);
