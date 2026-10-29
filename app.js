/* Page wiring: card file library, editing, previews, printing. */
(function () {
  "use strict";
  var C = window.LabelCore, S = window.LabelStore;
  var $ = function (id) { return document.getElementById(id); };

  var SAMPLE_NAME = "Sample cards";
  var SAMPLE_CSV = [
    "Card Name,Card No.,Set,Rarity,Condition,Price,Qty",
    "SAMPLE - Pikachu,025/198,Sample Set A,Common,LP,1.5,2",
    "SAMPLE - Charizard ex,199/165,Sample Set B,Special Illustration Rare,NM,£89.99,1",
    "SAMPLE - Mewtwo V,072/078,Sample Set C,Ultra Rare,NM,4,1",
    "\"SAMPLE - Gardevoir ex, Special Illustration Rare\",245/198,Sample Set A,Special Illustration Rare,NM,\"£1,250.00\",1",
    "SAMPLE - Snorlax,143/165,Sample Set B,Uncommon,MP,0.75,3",
    "SAMPLE - Mega Charizard X ex Special Illustration Rare Alternate Art Promo,125/094,Sample Set C,Special Illustration Rare,NM,349.99,1"
  ].join("\n");
  var EXAMPLE_CARD = { name: "SAMPLE - Card name", number: "000/000", price: "1.99", condition: "NM", set: "", rarity: "", qr: "", qty: 1 };

  // state.cards is the current file's card list (same array the library saves).
  var state = { files: [], file: null, cards: [], ticks: {}, shown: [], iconImage: null, iconName: "", editing: null };
  var PREVIEW_LIMIT = 300;
  var printer = { client: null, busy: false, stop: false };
  var LAST_FILE_KEY = "hw-label-maker-last-file";

  // ---------- small helpers ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function icon(name) { var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), u = document.createElementNS(ns, "use"); u.setAttribute("href", "#i-" + name); s.appendChild(u); return s; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function currency() { return (state.file && state.file.currency) || "GBP"; }
  function sym() { return C.currencyOf(currency()).symbol; }
  var toastTimer = null;
  function toast(text, actionText, action) {
    $("toastText").textContent = text;
    var b = $("toastAction");
    b.classList.toggle("hidden", !actionText);
    b.textContent = actionText || ""; b.onclick = function () { hideToast(); if (action) action(); };
    $("toast").classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, actionText ? 7000 : 3200);
  }
  function hideToast() { $("toast").classList.remove("show"); }
  function confirmBox(title, text, yes) {
    return new Promise(function (resolve) {
      var d = $("confirmDialog");
      $("confirmTitle").textContent = title; $("confirmText").textContent = text || ""; $("confirmYes").textContent = yes || "Delete";
      function done(v) { $("confirmYes").onclick = $("confirmNo").onclick = null; d.onclose = null; if (d.open) d.close(); resolve(v); }
      $("confirmYes").onclick = function () { done(true); };
      $("confirmNo").onclick = function () { done(false); };
      d.onclose = function () { done(false); };
      d.showModal();
    });
  }
  // Close buttons and tapping the dim backdrop close any sheet.
  document.querySelectorAll("dialog").forEach(function (d) {
    d.addEventListener("click", function (e) {
      if (e.target === d) d.close();
      var c = e.target.closest && e.target.closest("[data-close]");
      if (c && d.contains(c)) d.close();
    });
  });

  // ---------- settings ----------
  var SETTINGS_KEY = "hw-label-maker-settings-v2";
  var SAVED_IDS = ["size", "margin", "showName", "showNumber", "showCondition", "showSet", "showPrice", "hidePence",
    "qrTemplate", "zoom", "density", "printTask"];
  function saveSettings() {
    var s = {};
    SAVED_IDS.forEach(function (id) { var e = $(id); s[id] = e.type === "checkbox" ? e.checked : e.value; });
    s.graphic = radio("graphic"); s.qrSource = radio("qrSource");
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }
  function loadSettings() {
    var s;
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (e) { s = null; }
    if (!s) return;
    SAVED_IDS.forEach(function (id) {
      if (!(id in s)) return;
      var e = $(id);
      if (e.type === "checkbox") e.checked = !!s[id]; else e.value = s[id];
    });
    if (!$("zoom").value) $("zoom").value = "fit";
    if (s.graphic) setRadio("graphic", s.graphic);
    if (s.qrSource) setRadio("qrSource", s.qrSource);
    if (!$("qrTemplate").value.trim()) $("qrTemplate").value = C.DEFAULT_QR_TEMPLATE;
  }
  function radio(name) { var r = document.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; }
  function setRadio(name, v) { var r = document.querySelector('input[name="' + name + '"][value="' + v + '"]'); if (r) r.checked = true; }

  function options() {
    var size = C.LABEL_SIZES.find(function (s) { return s.id === $("size").value; }) || C.LABEL_SIZES[0];
    return {
      size: size, margin: Number($("margin").value) || 0,
      show: { name: $("showName").checked, number: $("showNumber").checked, condition: $("showCondition").checked,
        set: $("showSet").checked, price: $("showPrice").checked },
      hidePence: $("hidePence").checked, graphic: radio("graphic"), currency: currency(),
      qrSource: radio("qrSource") || "auto", qrTemplate: $("qrTemplate").value.trim(), iconImage: state.iconImage
    };
  }

  // ---------- theme ----------
  var THEME_KEY = "hw-label-maker-theme";
  function applyTheme(t) { document.documentElement.setAttribute("data-theme", t || "auto"); }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) { /* ignore */ }
  $("themeBtn").onclick = function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur === "dark" || (cur === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    var next = dark ? "light" : "dark";
    applyTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    toast(next === "dark" ? "Dark look" : "Light look");
  };

  // ---------- tabs (phones) ----------
  function showTab(name) {
    document.body.setAttribute("data-active-tab", name);
    document.querySelectorAll("[data-tab-btn]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-tab-btn") === name); });
    if (name === "design") renderDesignPreview();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("[data-tab-btn]").forEach(function (b) { b.onclick = function () { showTab(b.getAttribute("data-tab-btn")); }; });
  $("printerChip").onclick = function () {
    if (matchMedia("(min-width: 960px)").matches) $("step-print").scrollIntoView({ behavior: "smooth", block: "start" });
    else showTab("printer");
  };

  // ---------- library ----------
  function makeFile(name, text) {
    var parsed = C.parseCSV(text);
    if (!parsed.headers.length) return null;
    var map = C.guessMapping(parsed.headers);
    var priceVals = map.price ? parsed.rows.map(function (r) { return r[map.price]; }) : [];
    var f = { id: uid(), name: uniqueName(name), createdAt: Date.now(), updatedAt: Date.now(),
      currency: C.detectCurrency(map.price, priceVals), edited: false,
      source: { headers: parsed.headers, rows: parsed.rows, map: map }, cards: [] };
    buildCardsFromSource(f);
    return f;
  }
  function buildCardsFromSource(f) {
    f.cards = f.source.rows.map(function (r) { var c = C.toCard(r, f.source.map); c.id = uid(); return c; });
    f.edited = false;
  }
  function uniqueName(name) {
    name = String(name || "Cards").replace(/\.(csv|txt)$/i, "").trim() || "Cards";
    var base = name, n = 2;
    while (state.files.some(function (f) { return f.name === name; })) name = base + " (" + (n++) + ")";
    return name;
  }
  function saveFile(f) {
    f = f || state.file; if (!f) return Promise.resolve();
    return S.put(f).catch(function (e) { toast("Couldn't save: " + (e && e.message ? e.message : e)); });
  }

  /** Import CSV text as a new saved file and switch to it. Returns the file. */
  function importCSVText(text, name, opts) {
    var f = makeFile(name, text);
    if (!f) { toast((name || "That file") + " looks empty."); return Promise.resolve(null); }
    state.files.push(f);
    return saveFile(f).then(function () {
      if (!opts || opts.select !== false) selectFile(f.id);
      S.persist();
      return f;
    });
  }
  // Kept for old tests and scripts: loads CSV text (saved into the library).
  function loadCSVText(text, label) { return importCSVText(text, label); }

  function importFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return Promise.resolve();
    var done = [];
    return files.reduce(function (p, file) {
      return p.then(function () { return file.text(); }).then(function (t) { return importCSVText(t, file.name, { select: false }); })
        .then(function (f) { if (f) done.push(f); });
    }, Promise.resolve()).then(function () {
      if (!done.length) return;
      var last = done[done.length - 1];
      selectFile(last.id);
      toast(done.length === 1 ? "Saved " + last.name + " · " + plural(last.cards.length, "card") : "Saved " + done.length + " files");
      var m = last.source.map;
      if (!m.name || !m.price) { openFileDialog(); $("mappingBox").open = true; toast("Check the columns: couldn't find the " + (!m.name ? "name" : "price") + " column"); }
    });
  }

  function selectFile(id) {
    var f = state.files.find(function (x) { return x.id === id; }) || null;
    state.file = f;
    state.cards = f ? f.cards : [];
    if (f && !state.ticks[f.id]) state.ticks[f.id] = {};
    try { if (f) localStorage.setItem(LAST_FILE_KEY, f.id); } catch (e) { /* ignore */ }
    ["fText", "fSet", "fRarity", "fCondition", "fMin", "fMax"].forEach(function (k) { $(k).value = ""; });
    fillFileSelect(); fillFilterLists(); render();
  }
  function fillFileSelect() {
    var sel = $("fileSelect"); sel.innerHTML = "";
    if (!state.files.length) { var o = el("option", null, "No files yet"); o.value = ""; sel.appendChild(o); sel.disabled = true; }
    else {
      sel.disabled = false;
      state.files.forEach(function (f) { var o = el("option", null, f.name + "  ·  " + f.cards.length); o.value = f.id; sel.appendChild(o); });
      if (state.file) sel.value = state.file.id;
    }
    $("fileMenuBtn").disabled = !state.file;
    var has = !!state.file;
    $("emptyState").classList.toggle("hidden", has);
    $("cardsPanel").classList.toggle("hidden", !has);
    document.body.classList.toggle("no-file", !has);
    if (has) {
      var f = state.file;
      $("csvStatus").textContent = plural(f.cards.length, "card") + " · " + C.currencyOf(f.currency).symbol + " prices" + (f.edited ? " · edited " + ago(f.updatedAt) : " · saved");
    } else $("csvStatus").textContent = "No card files yet.";
    $("fMinLabel").textContent = "Min " + sym(); $("fMaxLabel").textContent = "Max " + sym();
  }
  function ago(t) {
    var s = Math.round((Date.now() - (t || 0)) / 1000);
    if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  $("fileSelect").onchange = function () { selectFile($("fileSelect").value); };

  // ---------- file options ----------
  function openFileDialog() {
    var f = state.file; if (!f) return;
    $("fileName").value = f.name;
    setRadio("currency", f.currency || "GBP");
    $("shareCsv").classList.toggle("hidden", !canShareFiles());
    document.querySelectorAll("[data-map]").forEach(function (sel) {
      var field = sel.getAttribute("data-map");
      sel.innerHTML = "";
      var none = el("option", null, "(not used)"); none.value = ""; sel.appendChild(none);
      f.source.headers.forEach(function (h) { var o = el("option", null, h); o.value = h; sel.appendChild(o); });
      sel.value = f.source.map[field] || "";
    });
    $("mappingBox").open = false;
    $("fileDialog").showModal();
  }
  $("fileMenuBtn").onclick = openFileDialog;
  $("renameFile").onclick = function () {
    var f = state.file, n = $("fileName").value.trim(); if (!f || !n || n === f.name) return;
    f.name = uniqueName(n); $("fileName").value = f.name;
    saveFile().then(function () { fillFileSelect(); toast("Renamed to " + f.name); });
  };
  $("fileName").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); $("renameFile").click(); } };
  document.querySelectorAll('input[name="currency"]').forEach(function (r) {
    r.onchange = function () { setCurrency(r.value); };
  });
  function setCurrency(code) {
    if (!state.file) return;
    state.file.currency = C.CURRENCIES[code] ? code : "GBP";
    saveFile().then(function () { fillFileSelect(); render(); toast("Prices now in " + C.currencyOf(code).label.slice(2)); });
  }
  document.querySelectorAll("[data-map]").forEach(function (sel) {
    sel.onchange = function () {
      var f = state.file; if (!f) return;
      var go = f.edited ? confirmBox("Rebuild cards?", "Changing columns rebuilds the cards from the original CSV and undoes your edits to " + f.name + ".", "Rebuild") : Promise.resolve(true);
      go.then(function (yes) {
        if (!yes) { sel.value = f.source.map[sel.getAttribute("data-map")] || ""; return; }
        f.source.map[sel.getAttribute("data-map")] = sel.value;
        buildCardsFromSource(f); state.cards = f.cards; state.ticks[f.id] = {};
        saveFile().then(function () { fillFileSelect(); fillFilterLists(); render(); });
      });
    };
  });
  $("deleteFile").onclick = function () {
    var f = state.file; if (!f) return;
    confirmBox("Delete " + f.name + "?", "This removes the file and all its edits from this device. Export it first if you want a copy.").then(function (yes) {
      if (!yes) return;
      S.remove(f.id).then(function () {
        state.files = state.files.filter(function (x) { return x.id !== f.id; });
        delete state.ticks[f.id];
        $("fileDialog").close();
        selectFile(state.files.length ? state.files[state.files.length - 1].id : null);
        toast("Deleted " + f.name);
      });
    });
  };
  function csvFor(f) { return C.cardsToCSV(f.cards, f.currency); }
  $("exportCsv").onclick = function () {
    var f = state.file; if (!f) return;
    downloadBytes(new TextEncoder().encode("\uFEFF" + csvFor(f)), C.safeFileName(f.name) + ".csv", "text/csv");
  };
  function canShareFiles() {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File(["x"], "x.csv", { type: "text/csv" })] })); } catch (e) { return false; }
  }
  $("shareCsv").onclick = function () {
    var f = state.file; if (!f) return;
    var file = new File(["\uFEFF" + csvFor(f)], C.safeFileName(f.name) + ".csv", { type: "text/csv" });
    navigator.share({ files: [file], title: f.name }).catch(function () { /* cancelled */ });
  };

  // ---------- open a folder (desktop Chrome / Edge) ----------
  if (window.showDirectoryPicker) $("openFolder").classList.remove("hidden");
  var folderFiles = [];
  $("openFolder").onclick = async function () {
    var dir;
    try { dir = await window.showDirectoryPicker({ mode: "read" }); } catch (e) { return; }
    folderFiles = [];
    for await (var entry of dir.values()) if (entry.kind === "file" && /\.(csv|txt)$/i.test(entry.name)) folderFiles.push(entry);
    folderFiles.sort(function (a, b) { return a.name.localeCompare(b.name); });
    var list = $("folderList"); list.innerHTML = "";
    $("folderTitle").textContent = folderFiles.length ? plural(folderFiles.length, "CSV file") + " in " + dir.name : "No CSV files in " + dir.name;
    folderFiles.forEach(function (h, i) {
      var have = state.files.some(function (f) { return f.name === h.name.replace(/\.(csv|txt)$/i, ""); });
      var l = el("label", "check-row"), cb = el("input"); cb.type = "checkbox"; cb.checked = !have; cb.value = i;
      l.appendChild(cb); l.appendChild(el("span", null, h.name)); if (have) l.appendChild(el("em", "muted small", "already saved"));
      list.appendChild(l);
    });
    $("folderDialog").showModal();
  };
  $("folderImport").onclick = async function () {
    var picks = Array.prototype.filter.call($("folderList").querySelectorAll("input"), function (c) { return c.checked; });
    var files = [];
    for (var i = 0; i < picks.length; i++) files.push(await folderFiles[Number(picks[i].value)].getFile());
    $("folderDialog").close();
    importFiles(files);
  };

  // ---------- filters and ticking ----------
  var FILTER_LISTS = { set: "fSet", rarity: "fRarity", condition: "fCondition" };
  var FILTER_LABELS = { set: "All sets", rarity: "All rarities", condition: "All conditions" };
  function fieldValues(field) {
    var values = [];
    state.cards.forEach(function (c) { if (c[field] && values.indexOf(c[field]) < 0) values.push(c[field]); });
    return values.sort();
  }
  function fillFilterLists() {
    Object.keys(FILTER_LISTS).forEach(function (field) {
      var sel = $(FILTER_LISTS[field]), keep = sel.value;
      var values = fieldValues(field);
      sel.innerHTML = "";
      var all = el("option", null, FILTER_LABELS[field]); all.value = ""; sel.appendChild(all);
      values.forEach(function (v) { var o = el("option", null, v); o.value = v; sel.appendChild(o); });
      sel.value = values.indexOf(keep) >= 0 ? keep : "";
      sel.parentNode.classList.toggle("hidden", !values.length);
      sel.classList.toggle("hidden", !values.length);
    });
    ["set", "rarity"].forEach(function (field) {
      var dl = $(field + "List"); dl.innerHTML = "";
      fieldValues(field).forEach(function (v) { var o = el("option"); o.value = v; dl.appendChild(o); });
    });
  }
  function currentFilter() {
    return { text: $("fText").value, set: $("fSet").value, rarity: $("fRarity").value, condition: $("fCondition").value,
      min: $("fMin").value, max: $("fMax").value };
  }
  function ticksMap() { return state.file ? (state.ticks[state.file.id] = state.ticks[state.file.id] || {}) : {}; }
  function isTicked(i) { var c = state.cards[i]; return !!(c && ticksMap()[c.id]); }
  function setTick(i, on) { var c = state.cards[i]; if (!c) return; if (on) ticksMap()[c.id] = true; else delete ticksMap()[c.id]; }
  function setShownTicks(on) { state.shown.forEach(function (i) { setTick(i, on); }); render(); }
  $("filterBtn").onclick = function () {
    var open = $("filters").classList.toggle("hidden") === false;
    $("filterBtn").setAttribute("aria-expanded", String(open)); $("filterBtn").classList.toggle("on", open);
  };

  // ---------- preview ----------
  function sizeCanvas(canvas, px, zoom) {
    canvas.style.aspectRatio = px.w + " / " + px.h;
    canvas.style.height = "auto";
    canvas.style.width = zoom === "fit" ? "100%" : (px.w * Number(zoom)) + "px";
  }
  function render() {
    saveSettings();
    var opts = options();
    $("qrOptions").classList.toggle("hidden", opts.graphic !== "qr");
    $("iconOptions").classList.toggle("hidden", opts.graphic !== "icon");
    var px = C.labelPixels(opts.size);
    var zoom = $("zoom").value || "fit";
    $("sizeInfo").textContent = opts.size.w + " × " + opts.size.h + " mm · " + px.w + " × " + px.h + " dots";
    var box = $("previews"); box.innerHTML = "";
    box.classList.toggle("fixed-zoom", zoom !== "fit");
    var warnBox = $("warnings"); warnBox.innerHTML = "";
    var notes = [];
    if (opts.size.h > 12) notes.push("This roll is " + opts.size.h + " mm tall but the D110 prints a 12 mm strip, so about " + ((opts.size.h - 12) / 2) + " mm stays blank top and bottom.");
    state.shown = C.filterCards(state.cards, currentFilter());
    var nf = ["fSet", "fRarity", "fCondition", "fMin", "fMax"].filter(function (k) { return $(k).value !== ""; }).length;
    $("filterBadge").textContent = nf; $("filterBadge").classList.toggle("hidden", !nf);
    if (state.shown.length > PREVIEW_LIMIT) notes.push("Showing the first " + PREVIEW_LIMIT + " of " + state.shown.length + " matching cards. Select all still ticks every match.");
    if (state.file && !state.cards.length) notes.push("This file has no cards yet. Tap “Card” to add one.");
    else if (state.file && !state.shown.length) notes.push("No cards match the search or filters.");
    state.shown.slice(0, PREVIEW_LIMIT).forEach(function (i) { box.appendChild(cardItem(i, opts, px, zoom)); });
    notes.forEach(function (n) { warnBox.appendChild(el("div", "warn", n)); });
    renderExample(opts, px);
    renderDesignPreview();
    updateSummary();
  }

  function cardItem(i, opts, px, zoom) {
    var card = state.cards[i];
    var item = el("article", "card-item" + (isTicked(i) ? " ticked" : ""));
    item.dataset.index = i;
    var top = el("div", "card-top");
    var tick = el("label", "tick");
    var cb = el("input"); cb.type = "checkbox"; cb.checked = isTicked(i); cb.setAttribute("aria-label", "Tick " + (card.name || "card"));
    cb.onchange = function () { setTick(i, cb.checked); item.classList.toggle("ticked", cb.checked); updateSummary(); };
    tick.appendChild(cb); tick.appendChild(el("span", "tick-box")).appendChild(icon("check"));
    var frame = el("div", "label-frame");
    var canvas = document.createElement("canvas");
    var res = C.renderLabel(canvas, card, opts);
    sizeCanvas(canvas, px, zoom);
    frame.appendChild(canvas);
    frame.onclick = function () { cb.checked = !cb.checked; cb.onchange(); };
    top.appendChild(tick); top.appendChild(frame);
    item.appendChild(top);

    var foot = el("div", "card-foot");
    var info = el("div", "card-info");
    info.appendChild(el("div", "card-name", card.name || "(no name)"));
    var bits = [card.number, card.condition, card.set].filter(Boolean).join(" · ");
    info.appendChild(el("div", "card-meta", (card.qty > 1 ? "×" + card.qty + " · " : "") + (bits || "")));
    if (res.warnings.length) info.appendChild(el("div", "card-warn", res.warnings.join(". ")));
    foot.appendChild(info);
    var priceBtn = el("button", "price-chip", C.formatPrice(card.price, { currency: currency() }) || "Add price");
    priceBtn.type = "button"; priceBtn.title = "Edit price"; if (!card.price) priceBtn.classList.add("empty");
    priceBtn.onclick = function () { openEdit(i, "price"); };
    var editBtn = el("button", "icon-btn"); editBtn.type = "button"; editBtn.title = "Edit card"; editBtn.setAttribute("aria-label", "Edit card"); editBtn.appendChild(icon("edit"));
    editBtn.onclick = function () { openEdit(i); };
    var dl = el("button", "icon-btn"); dl.type = "button"; dl.title = "Download PNG"; dl.setAttribute("aria-label", "Download PNG"); dl.appendChild(icon("download"));
    dl.onclick = function () { downloadBlobFromCanvas(canvas, C.safeFileName((i + 1) + "-" + card.name) + ".png"); };
    foot.appendChild(priceBtn); foot.appendChild(editBtn); foot.appendChild(dl);
    item.appendChild(foot);
    return item;
  }

  function renderExample(opts, px) {
    var c = $("exampleCanvas"); C.renderLabel(c, EXAMPLE_CARD, opts); sizeCanvas(c, px, "fit");
  }
  function renderDesignPreview() {
    var opts = options(), px = C.labelPixels(opts.size);
    var card = state.shown.length ? state.cards[state.shown[0]] : (state.cards[0] || EXAMPLE_CARD);
    var c = $("designCanvas"); C.renderLabel(c, card, opts); sizeCanvas(c, px, "fit");
  }

  /** Ticked cards that the current filter is showing. Hidden cards are never printed. */
  function selectedJobs() {
    return state.shown.filter(function (i) { return isTicked(i); }).map(function (i) { return { card: state.cards[i], index: i }; });
  }
  function updateSummary() {
    var jobs = selectedJobs();
    var count = jobs.reduce(function (s, j) { return s + j.card.qty; }, 0);
    $("previewSummary").textContent = state.cards.length ? state.shown.length + " of " + state.cards.length : "";
    var status = printer.client ? "Printer connected" : (navigator.bluetooth ? "Printer connects when you print" : "No Bluetooth here: use PNGs");
    $("tickCount").textContent = jobs.length ? count + (count === 1 ? " label" : " labels") + " to print" : "Nothing ticked yet";
    $("tickSub").textContent = jobs.length ? jobs.length + (jobs.length === 1 ? " card" : " cards") + " ticked · " + status : "Tick cards to print them · " + status;
    $("exportZip").disabled = !count;
    $("print").disabled = printer.busy || !count;
    $("printLabel").textContent = printer.busy ? "Printing…" : (count ? "Print " + count : "Print");
    $("actionbar").classList.toggle("has-ticks", !!count);
    $("bScopeTicked").textContent = "Ticked (" + jobs.length + ")";
    $("bScopeShown").textContent = "All showing (" + state.shown.length + ")";
  }

  // ---------- edit a card ----------
  var EDIT_FIELDS = { eName: "name", eNumber: "number", ePrice: "price", eCondition: "condition", eSet: "set", eRarity: "rarity", eQty: "qty", eLink: "qr" };
  function openEdit(i, focus) {
    if (!state.file) return;
    var isNew = i == null;
    var card = isNew ? { name: "", number: "", price: "", condition: "NM", set: "", rarity: "", qr: "", qty: 1 } : state.cards[i];
    state.editing = { index: isNew ? null : i };
    $("editTitle").textContent = isNew ? "Add a card" : "Edit card";
    $("eDelete").classList.toggle("hidden", isNew);
    $("ePriceSym").textContent = sym();
    Object.keys(EDIT_FIELDS).forEach(function (id) {
      var v = card[EDIT_FIELDS[id]];
      if (id === "ePrice") v = v === "" || v == null ? "" : C.plainPrice(v);
      $(id).value = v == null ? "" : v;
    });
    editPreview();
    $("editDialog").showModal();
    var target = isNew ? "eName" : (focus === "price" ? "ePrice" : null);
    if (target) setTimeout(function () { $(target).focus(); $(target).select(); }, 60);
    else $("editDialog").querySelector(".sheet-body").scrollTop = 0;
  }
  function editValues() {
    var c = {};
    Object.keys(EDIT_FIELDS).forEach(function (id) { c[EDIT_FIELDS[id]] = $(id).value.trim(); });
    var q = parseInt(c.qty, 10); c.qty = isNaN(q) || q < 1 ? 1 : Math.min(q, 99);
    return c;
  }
  function editPreview() {
    var opts = options(), px = C.labelPixels(opts.size), c = $("editCanvas");
    C.renderLabel(c, editValues(), opts); sizeCanvas(c, px, "fit");
    var n = C.priceNumber($("ePrice").value);
    $("ePrice").classList.toggle("bad", $("ePrice").value.trim() !== "" && isNaN(n));
  }
  Object.keys(EDIT_FIELDS).forEach(function (id) { $(id).addEventListener("input", editPreview); });
  document.querySelectorAll("[data-nudge]").forEach(function (b) {
    b.onclick = function () {
      var n = C.priceNumber($("ePrice").value); if (isNaN(n)) n = 0;
      n = Math.max(0, Math.round((n + Number(b.getAttribute("data-nudge"))) * 100) / 100);
      $("ePrice").value = n.toFixed(2); editPreview();
    };
  });
  function stepQty(d) { var q = (parseInt($("eQty").value, 10) || 1) + d; $("eQty").value = Math.max(1, Math.min(99, q)); editPreview(); }
  $("eQtyMinus").onclick = function () { stepQty(-1); };
  $("eQtyPlus").onclick = function () { stepQty(1); };
  $("editForm").onsubmit = function (e) {
    e.preventDefault();
    var v = editValues(), f = state.file; if (!f) return;
    if (v.price !== "" && !isNaN(C.priceNumber(v.price))) v.price = C.plainPrice(v.price);
    var ed = state.editing, card;
    if (ed.index == null) {
      card = Object.assign({ id: uid() }, v);
      f.cards.push(card);
      ticksMap()[card.id] = true; // a new card is usually one you want to print
    } else {
      card = Object.assign(f.cards[ed.index], v);
    }
    f.edited = true;
    $("editDialog").close();
    saveFile().then(function () { fillFileSelect(); fillFilterLists(); render(); toast(ed.index == null ? "Card added and ticked" : "Saved " + (card.name || "card")); });
  };
  $("eDelete").onclick = function () {
    var ed = state.editing, f = state.file; if (!f || ed.index == null) return;
    var card = f.cards[ed.index];
    confirmBox("Delete this card?", (card.name || "This card") + " will be removed from " + f.name + ".").then(function (yes) {
      if (!yes) return;
      var at = f.cards.indexOf(card);
      f.cards.splice(at, 1); delete ticksMap()[card.id]; f.edited = true;
      $("editDialog").close();
      saveFile().then(function () {
        fillFileSelect(); fillFilterLists(); render();
        toast("Deleted " + (card.name || "card"), "Undo", function () {
          f.cards.splice(Math.min(at, f.cards.length), 0, card);
          saveFile().then(function () { fillFileSelect(); fillFilterLists(); render(); });
        });
      });
    });
  };
  $("addCard").onclick = function () { openEdit(null); };

  // ---------- bulk price change ----------
  function bulkTargets() {
    var idx = radio("bScope") === "shown" ? state.shown : selectedJobs().map(function (j) { return j.index; });
    return idx.map(function (i) { return state.cards[i]; });
  }
  function bulkPreview() {
    var cards = bulkTargets(), pct = Number($("bPercent").value) || 0, round = $("bRound").value, box = $("bPreview");
    box.innerHTML = "";
    var priced = cards.filter(function (c) { return !isNaN(C.priceNumber(c.price)); });
    if (!cards.length) { box.appendChild(el("p", "muted", radio("bScope") === "ticked" ? "Nothing ticked. Tick some cards or pick “All showing”." : "No cards showing.")); $("bApply").disabled = true; return; }
    $("bApply").disabled = !priced.length || (pct === 0 && round === "none");
    priced.slice(0, 4).forEach(function (c) {
      var row = el("div", "bp-row");
      row.appendChild(el("span", "bp-name", c.name || "(no name)"));
      row.appendChild(el("span", "bp-old", C.formatPrice(c.price, { currency: currency() })));
      row.appendChild(el("span", "bp-new", C.formatPrice(String(C.adjustPrice(c.price, pct, round)), { currency: currency() })));
      box.appendChild(row);
    });
    if (priced.length > 4) box.appendChild(el("p", "muted small", "…and " + plural(priced.length - 4, "more card")));
    if (priced.length < cards.length) box.appendChild(el("p", "muted small", plural(cards.length - priced.length, "card") + " without a number price will be left alone."));
  }
  $("bulkBtn").onclick = function () {
    if (!state.file) return;
    setRadio("bScope", selectedJobs().length ? "ticked" : "shown");
    $("bPercent").value = "0"; $("bRound").value = "none";
    bulkPreview(); $("bulkDialog").showModal();
  };
  ["bPercent", "bRound"].forEach(function (id) { $(id).addEventListener("input", bulkPreview); $(id).addEventListener("change", bulkPreview); });
  document.querySelectorAll('input[name="bScope"]').forEach(function (r) { r.onchange = bulkPreview; });
  document.querySelectorAll("[data-pct]").forEach(function (b) { b.onclick = function () { $("bPercent").value = b.getAttribute("data-pct"); bulkPreview(); }; });
  $("bulkForm").onsubmit = function (e) {
    e.preventDefault();
    var pct = Number($("bPercent").value) || 0, round = $("bRound").value, f = state.file;
    var undo = [];
    bulkTargets().forEach(function (c) {
      var n = C.adjustPrice(c.price, pct, round);
      if (isNaN(n)) return;
      undo.push([c, c.price]); c.price = n.toFixed(2);
    });
    f.edited = true;
    $("bulkDialog").close();
    saveFile().then(function () {
      render(); fillFileSelect();
      toast("Changed " + plural(undo.length, "price"), "Undo", function () {
        undo.forEach(function (u) { u[0].price = u[1]; }); saveFile().then(function () { render(); });
      });
    });
  };

  // ---------- export ----------
  function canvasToBytes(canvas) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { b.arrayBuffer().then(function (ab) { resolve(new Uint8Array(ab)); }); }, "image/png");
    });
  }
  function downloadBytes(bytes, name, type) {
    var url = URL.createObjectURL(new Blob([bytes], { type: type }));
    var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function downloadBlobFromCanvas(canvas, name) { canvasToBytes(canvas).then(function (b) { downloadBytes(b, name, "image/png"); }); }

  /** Builds the zip of ticked labels. Exposed for testing. */
  function buildZip() {
    var opts = options();
    var jobs = selectedJobs();
    return Promise.all(jobs.map(function (j, n) {
      var c = document.createElement("canvas");
      C.renderLabel(c, j.card, opts);
      return canvasToBytes(c).then(function (bytes) {
        var name = String(n + 1).padStart(3, "0") + "-" + C.safeFileName(j.card.name) + (j.card.qty > 1 ? "-x" + j.card.qty : "") + ".png";
        return { name: name, bytes: bytes };
      });
    })).then(function (files) { return C.makeZip(files); });
  }
  $("exportZip").onclick = function () {
    if (!selectedJobs().length) { toast("Tick at least one card first."); return; }
    buildZip().then(function (zip) { downloadBytes(zip, "labels-" + $("size").value + ".zip", "application/zip"); });
  };

  // ---------- printer ----------
  var APP_VERSION = "3.0.1 (find-all + Bluetooth check)";
  function log(text) { var p = $("log"); p.textContent += text + "\n"; p.scrollTop = p.scrollHeight; }
  function status(text) { $("printerStatus").textContent = text; }
  function setChip(stateName, text) {
    var chip = $("printerChip"); chip.classList.remove("ok", "busy", "off");
    chip.classList.add(stateName); $("printerChipText").textContent = text;
  }
  setChip("off", "Printer");

  // The service NiimBlueLib talks to. bef8d6c9-... is the characteristic inside it; it's listed too
  // (harmless) in case a browser wants it. The printer's second "UART" service (49535343-...) is left out
  // on purpose: it looks usable but never answers, and the library would pick it if it were allowed.
  var NIIMBOT_SERVICES = ["e7810a71-73ae-499d-8c15-faa9aef0c3f2", "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f"];
  var diag = { lastAttempt: "none yet", lastDevice: "", lastError: "", availability: "not checked" };
  function errText(e) {
    if (!e) return String(e);
    var parts = [];
    if (e.name) parts.push(e.name);
    if (e.message) parts.push(e.message);
    if (e.code !== undefined) parts.push("code " + e.code);
    var t = parts.length ? parts.join(": ") : String(e);
    if (e.stack && String(e.stack).indexOf(e.message || "@@") === -1) t += "\n" + e.stack;
    else if (e.stack) t += "\n" + String(e.stack).split("\n").slice(0, 6).join("\n");
    return t;
  }
  function showDiag() {
    var bt = navigator.bluetooth;
    var lines = [
      "App: " + APP_VERSION,
      "navigator.bluetooth present: " + (bt ? "yes" : "no"),
      "requestDevice: " + (bt && typeof bt.requestDevice === "function" ? "yes" : "no"),
      "getAvailability(): " + diag.availability,
      "getDevices: " + (bt && typeof bt.getDevices === "function" ? "yes" : "no"),
      "Secure page (https): " + (window.isSecureContext ? "yes" : "no"),
      "Printer library loaded: " + (window.niimbluelib ? "yes" : "no"),
      "User agent: " + navigator.userAgent,
      "Last connect attempt: " + diag.lastAttempt,
      "Device picked: " + (diag.lastDevice || "-"),
      "Last error: " + (diag.lastError || "-")
    ];
    $("diag").textContent = lines.join("\n");
  }
  function checkAvailability() {
    var bt = navigator.bluetooth;
    if (!bt) { diag.availability = "n/a (no navigator.bluetooth)"; showDiag(); return; }
    if (typeof bt.getAvailability !== "function") { diag.availability = "not supported by this browser"; showDiag(); return; }
    diag.availability = "checking..."; showDiag();
    Promise.resolve().then(function () { return bt.getAvailability(); }).then(function (v) {
      diag.availability = String(v) + (v ? "" : " (Bluetooth off, or this browser isn't allowed to use it: check iPhone Settings > Bluefy > Bluetooth)");
      showDiag();
    }, function (e) { diag.availability = "error: " + errText(e); showDiag(); });
  }

  // showAll: open the browser's picker with every nearby device (no name filter), then hand the
  // chosen device to NiimBlueLib via connect({ authorizedDevice }).
  async function connectPrinter(showAll) {
    showAll = showAll === true;
    diag.lastAttempt = (showAll ? "Find printer (show all)" : "Connect printer") + " at " + new Date().toLocaleTimeString();
    diag.lastError = ""; diag.lastDevice = ""; showDiag();
    if (!window.niimbluelib) { diag.lastError = "printer library didn't load"; showDiag(); status("The printer library didn't load."); return false; }
    if (!navigator.bluetooth) { diag.lastError = "navigator.bluetooth missing"; showDiag(); noBluetooth(); return false; }
    var lib = window.niimbluelib;
    var device = null;
    if (showAll) {
      // requestDevice must be the first await so it still counts as a tap.
      try {
        status("Pick your printer (D110-...) from the list. It may also show as an unnamed device.");
        setChip("busy", "Searching…");
        device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: NIIMBOT_SERVICES });
      } catch (e) {
        diag.lastError = "requestDevice (show all): " + errText(e); showDiag();
        if (e && e.name === "NotFoundError") status("No device picked (or the list was empty). See the Bluetooth check box below.");
        else status("Couldn't search for devices: " + (e && e.message ? e.message : e));
        setChip("off", "Printer"); log("requestDevice failed: " + errText(e));
        return false;
      }
      diag.lastDevice = (device.name || "(no name)") + " id " + device.id; showDiag();
      log("Picked device " + diag.lastDevice);
    }
    var client = lib.instantiateClient("bluetooth");
    client.on("packetsent", function (e) { log(">> " + lib.Utils.bufToHex(e.packet.toBytes())); });
    client.on("packetreceived", function (e) { log("<< " + lib.Utils.bufToHex(e.packet.toBytes())); });
    client.on("disconnect", function () {
      printer.client = null; status("Disconnected."); setChip("off", "Printer");
      $("connect").disabled = false; $("connectAll").disabled = false; $("disconnect").disabled = true; updateSummary();
    });
    try {
      if (!device) status("Pick your printer (it shows as D110-...) in the box that opens.");
      else status("Connecting to " + (device.name || "the device") + "...");
      setChip("busy", "Connecting…");
      var info = device ? await client.connect({ authorizedDevice: device }) : await client.connect();
      if (info && info.deviceName && !diag.lastDevice) diag.lastDevice = info.deviceName;
      printer.client = client;
      var meta = client.getModelMetadata();
      var task = client.getPrintTaskType();
      status("Connected to " + (meta ? meta.model : "an unknown model") + (task ? " (print mode " + task + ")" : "") +
        (meta ? ", " + meta.dpi + " dpi, " + meta.printheadPixels + " dot head." : "."));
      $("printerName").textContent = meta ? "NIIMBOT " + meta.model : "Printer";
      setChip("ok", meta ? meta.model : "Connected");
      if (meta && meta.densityMax) {
        Array.from($("density").options).forEach(function (o) { o.disabled = Number(o.value) > meta.densityMax; });
        if (Number($("density").value) > meta.densityMax) $("density").value = String(meta.densityMax);
      }
      $("connect").disabled = true; $("connectAll").disabled = true; $("disconnect").disabled = false; updateSummary();
      diag.lastError = "none (connected)"; showDiag();
      return true;
    } catch (e) {
      diag.lastError = (device ? "connect to picked device: " : "connect: ") + errText(e); showDiag();
      log("Connect failed: " + errText(e));
      var hint = "";
      if (device && e && /characteristic not found|No Services|NotFoundError|SecurityError/i.test((e.name || "") + " " + (e.message || "")))
        hint = " That device may not be the printer, or it didn't offer the NIIMBOT service.";
      status("Couldn't connect: " + (e && e.message ? e.message : e) + hint); setChip("off", "Printer");
      try { client.disconnect(); } catch (x) { /* ignore */ }
      return false;
    }
  }
  function noBluetooth() {
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var msg = ios ? "iPhone browsers can't use Bluetooth printers. Open this page in the free Bluefy browser app, or download PNGs and print them from the NIIMBOT app."
      : (!window.isSecureContext ? "Bluetooth needs a secure (https) page. Open the hosted link instead of a copied file."
        : "This browser can't use Bluetooth. Use Chrome or Edge (Android, Windows or Mac), or download PNGs.");
    status(msg); toast(msg, "Get PNGs", function () { $("exportZip").click(); });
  }
  $("connect").onclick = function () { connectPrinter(false); };
  $("connectAll").onclick = function () { connectPrinter(true); };
  $("diagRefresh").onclick = checkAvailability;
  $("diagCopy").onclick = function () {
    var t = $("diag").textContent;
    var done = function () { toast("Copied the Bluetooth check."); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () { selectDiag(); });
    else selectDiag();
  };
  function selectDiag() {
    var r = document.createRange(); r.selectNodeContents($("diag"));
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    toast("Text selected: tap Copy, or take a screenshot.");
  }
  $("disconnect").onclick = function () { if (printer.client) printer.client.disconnect(); };
  $("stop").onclick = function () { printer.stop = true; status("Stopping after this label..."); };

  $("print").onclick = async function () {
    if (printer.busy) return;
    if (!printer.client) { if (!(await connectPrinter())) return; }
    var client = printer.client, lib = window.niimbluelib;
    if (!client) return;
    var opts = options();
    var jobs = selectedJobs();
    var total = jobs.reduce(function (s, j) { return s + j.card.qty; }, 0);
    if (!total) return;
    var chosen = $("printTask").value;
    var taskName = chosen === "auto" ? (client.getPrintTaskType() || "D110") : chosen;
    var meta = client.getModelMetadata();
    var direction = (meta && meta.printDirection) || "left";
    printer.busy = true; printer.stop = false;
    $("stop").disabled = false; updateSummary(); setChip("busy", "Printing…");
    var task = client.protocol.newPrintTask(taskName, {
      totalPages: total, density: Number($("density").value), labelType: lib.LabelType.WithGaps,
      statusPollIntervalMs: 100, statusTimeoutMs: 8000
    });
    var done = 0, msg;
    try {
      await task.printInit();
      for (var k = 0; k < jobs.length; k++) {
        if (printer.stop) break;
        var j = jobs[k];
        var canvas = document.createElement("canvas");
        C.renderLabel(canvas, j.card, opts);
        var encoded = lib.ImageEncoder.encodeCanvas(canvas, lib.PageColorType.SingleColor, direction);
        status("Printing " + (done + 1) + " of " + total + ": " + j.card.name);
        $("printLabel").textContent = "Printing " + (done + 1) + "/" + total;
        await task.printPage(encoded, j.card.qty);
        await task.waitForPageFinished();
        done += j.card.qty;
      }
      if (!printer.stop) await task.waitForFinished();
      msg = printer.stop ? "Stopped. " + done + " of " + total + " labels printed." : "Done. " + done + " labels printed.";
    } catch (e) {
      msg = "Printing stopped: " + (e && e.message ? e.message : e) + ". " + done + " of " + total + " finished. Check the lid, the roll and the battery.";
    } finally {
      try { await task.printEnd(); } catch (e) { /* printer may be gone */ }
      printer.busy = false; $("stop").disabled = true;
      status(msg); toast(msg);
      if (printer.client) setChip("ok", (meta && meta.model) || "Connected");
      updateSummary();
    }
  };

  // ---------- inputs ----------
  ["csvFile", "csvFile2"].forEach(function (id) {
    $(id).onchange = function (e) { importFiles(e.target.files).then(function () { e.target.value = ""; }); };
  });
  $("loadSample").onclick = function () {
    var have = state.files.find(function (f) { return f.name === SAMPLE_NAME; });
    if (have) selectFile(have.id); else importCSVText(SAMPLE_CSV, SAMPLE_NAME);
  };
  $("iconFile").onchange = function (e) {
    var f = e.target.files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () { state.iconImage = img; state.iconName = f.name; $("iconStatus").textContent = f.name; render(); };
      img.onerror = function () { $("iconStatus").textContent = "That image couldn't be read."; };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  };

  C.LABEL_SIZES.forEach(function (s) {
    var o = el("option", null, s.w + " × " + s.h + " mm" + (s.id === "40x12" ? " (D110 standard)" : "")); o.value = s.id;
    $("size").appendChild(o);
  });
  $("qrTemplate").value = C.DEFAULT_QR_TEMPLATE;
  loadSettings();
  document.querySelectorAll("#step-label input, #step-label select, #step-label textarea").forEach(function (e) {
    if (e.type === "file") return;
    e.addEventListener("input", render); e.addEventListener("change", render);
  });
  var FILTER_IDS = ["fText", "fSet", "fRarity", "fCondition", "fMin", "fMax"];
  FILTER_IDS.forEach(function (id) { $(id).addEventListener("input", render); $(id).addEventListener("change", render); });
  $("fClear").onclick = function () { FILTER_IDS.forEach(function (id) { $(id).value = ""; }); render(); };
  $("selAll").onclick = function () { setShownTicks(true); };
  $("selNone").onclick = function () { setShownTicks(false); };
  $("qrReset").onclick = function () { $("qrTemplate").value = C.DEFAULT_QR_TEMPLATE; setRadio("qrSource", "auto"); render(); };
  $("density").onchange = saveSettings; $("printTask").onchange = saveSettings;
  $("btSupport").textContent = navigator.bluetooth
    ? "Bluetooth is available in this browser."
    : "Bluetooth isn't available here. It works in Chrome or Edge on Android, Windows and Mac (on a https link). On iPhone use the Bluefy browser app. You can still download PNGs.";
  if (!navigator.bluetooth) status("Bluetooth isn't available in this browser. You can still download PNG images below.");
  checkAvailability();

  // ---------- start ----------
  document.body.setAttribute("data-active-tab", "cards");
  var ready = S.list().then(function (files) {
    state.files = files;
    var last = null; try { last = localStorage.getItem(LAST_FILE_KEY); } catch (e) { /* ignore */ }
    var pick = files.find(function (f) { return f.id === last; }) || files[files.length - 1];
    selectFile(pick ? pick.id : null);
  }).catch(function () { selectFile(null); });
  render();

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () { /* offline use just won't be available */ }); });
  }

  window.LabelApp = { ready: ready, loadCSVText: loadCSVText, importCSVText: importCSVText, render: render, buildZip: buildZip, state: state, options: options, setRadio: setRadio,
    selectedJobs: selectedJobs, selectFile: selectFile, openEdit: openEdit, setCurrency: setCurrency, csvFor: csvFor,
    selectAll: function () { setShownTicks(true); }, selectNone: function () { setShownTicks(false); }, showTab: showTab };
})();
