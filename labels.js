/* Core label logic: CSV parsing, price formatting, label drawing, zip export.
   No printer code in here, so it can be tested on its own. */
(function (global) {
  "use strict";

  var DOTS_PER_MM = 8;      // D110 is 203 dpi = 8 dots per mm
  var PRINTHEAD_DOTS = 96;  // D110 printhead is 96 dots = 12 mm

  // Common D110 roll sizes (width x height in mm, as sold).
  var LABEL_SIZES = [
    { id: "40x12", w: 40, h: 12 },
    { id: "30x15", w: 30, h: 15 },
    { id: "30x14", w: 30, h: 14 },
    { id: "30x12", w: 30, h: 12 },
    { id: "26x15", w: 26, h: 15 },
    { id: "22x14", w: 22, h: 14 },
    { id: "40x14", w: 40, h: 14 },
    { id: "50x14", w: 50, h: 14 },
    { id: "50x15", w: 50, h: 15 },
    { id: "75x12", w: 75, h: 12 }
  ];

  /** Pixel size of the printable area. The print head only covers 12 mm,
      so taller labels are printed as a 12 mm band centred on the label. */
  function labelPixels(size) {
    var w = Math.round(size.w * DOTS_PER_MM);
    var h = Math.min(Math.round(size.h * DOTS_PER_MM), PRINTHEAD_DOTS);
    return { w: w, h: h };
  }

  // ---------- CSV ----------
  function detectDelimiter(text) {
    var firstLine = text.split(/\r?\n/)[0] || "";
    var best = ",", bestCount = -1;
    [",", ";", "\t"].forEach(function (d) {
      var n = 0, q = false;
      for (var i = 0; i < firstLine.length; i++) {
        var c = firstLine[i];
        if (c === '"') q = !q; else if (c === d && !q) n++;
      }
      if (n > bestCount) { best = d; bestCount = n; }
    });
    return best;
  }

  /** Parse CSV text (quotes, escaped quotes, new lines in quotes, BOM). */
  function parseCSV(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    var delim = detectDelimiter(text);
    var rows = [], row = [], field = "", inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (v) { return v.trim() !== ""; }); });
    var headers = (rows.shift() || []).map(function (h) { return h.trim(); });
    var records = rows.map(function (r) {
      var o = {};
      headers.forEach(function (h, idx) { o[h] = (r[idx] || "").trim(); });
      return o;
    });
    return { headers: headers, rows: records, delimiter: delim };
  }

  var GUESSES = {
    name: [/^(card )?name$/i, /^card$/i, /name/i, /title/i, /product/i],
    number: [/^(card )?(no\.?|num(ber)?|#)$/i, /number/i, /^no\b/i, /collector/i],
    price: [/^price$/i, /sell/i, /price/i, /£/, /value/i, /cost/i],
    // Short set / expansion code such as "OP05" or "SV3pt5". Checked before the set name so "Set Code" isn't taken as the name.
    setCode: [/^(set|expansion|exp)[ _.-]*(code|abbr|abbrev|abbreviation|id)$/i, /^code$/i, /^expansion$/i, /^(set|expansion)[ _.-]*code/i],
    set: [/^set( name)?$/i, /expansion/i, /^set/i],
    rarity: [/rarity/i],
    condition: [/condition/i, /grade/i, /^cond/i],
    qr: [/^qr/i, /link/i, /url/i],
    qty: [/^qty$/i, /quantity/i, /copies/i, /count/i]
  };

  /** Pick the most likely column for each field. Returns {field: header or ""}.
      rows (optional): the CSV rows, used to tell a lone "Expansion" column of full set names from one of short codes. */
  function guessMapping(headers, rows) {
    var used = {}, map = {};
    Object.keys(GUESSES).forEach(function (field) {
      map[field] = "";
      GUESSES[field].some(function (re) {
        var hit = headers.find(function (h) { return !used[h] && re.test(h); });
        if (hit) { map[field] = hit; used[hit] = true; return true; }
        return false;
      });
    });
    // A lone "Expansion" column holding long names (e.g. "Obsidian Flames") is the set name, not a code.
    if (map.setCode && !map.set && /^expansion$/i.test(map.setCode) && rows && rows.length) {
      var vals = rows.map(function (r) { return String(r[map.setCode] || ""); }).filter(Boolean);
      var avg = vals.reduce(function (n, v) { return n + v.length; }, 0) / (vals.length || 1);
      var spaced = vals.filter(function (v) { return /\s/.test(v.trim()); }).length;
      if (avg > 10 || spaced > vals.length / 2) { map.set = map.setCode; map.setCode = ""; }
    }
    return map;
  }

  // ---------- Price ----------
  /** Supported currencies. Symbol always goes in front (£1.99, $1.99, €1.99) so every label reads the same way. */
  var CURRENCIES = {
    GBP: { code: "GBP", symbol: "£", label: "£ Pound" },
    USD: { code: "USD", symbol: "$", label: "$ Dollar" },
    EUR: { code: "EUR", symbol: "€", label: "€ Euro" }
  };
  function currencyOf(code) { return CURRENCIES[code] || CURRENCIES.GBP; }

  /** Read a price as a number, or NaN. Accepts "£1,250.00", "1.5", "GBP 3", "$4", "€2.50", "EUR 2". */
  function priceNumber(raw) {
    var cleaned = String(raw == null ? "" : raw).replace(/[£$€\s]|GBP|USD|EUR/gi, "");
    // Decimal commas ("2,50", "1.250,00") as used in euro countries; "1,250" stays one thousand two hundred and fifty.
    var lastComma = cleaned.lastIndexOf(","), lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot && (lastDot >= 0 || /,\d{1,2}$/.test(cleaned))) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    cleaned = cleaned.replace(/,/g, "");
    return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : NaN;
  }

  /** Turn "£1,250.00", "1.5", "4" into "£1,250.00", "£1.50", "£4.00" (or $ / € with opts.currency).
      Text that isn't a number is shown as typed, with the currency symbol in front. */
  function formatPrice(raw, opts) {
    opts = opts || {};
    var sym = currencyOf(opts.currency).symbol;
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    var n = priceNumber(s);
    if (!isNaN(n)) {
      var whole = Math.abs(n - Math.round(n)) < 0.005;
      var digits = (opts.hidePence && whole) ? 0 : 2;
      return sym + n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    s = s.replace(/^[£$€]\s*/, "");
    return sym + s;
  }

  /** Guess a file's currency from its price column header and values. Defaults to GBP. */
  function detectCurrency(header, values) {
    var text = String(header || "") + " " + (values || []).slice(0, 200).join(" ");
    var n = { GBP: (text.match(/£|GBP/gi) || []).length, USD: (text.match(/\$|USD/gi) || []).length, EUR: (text.match(/€|EUR/gi) || []).length };
    var best = "GBP";
    ["USD", "EUR"].forEach(function (c) { if (n[c] > n[best]) best = c; });
    return best;
  }

  /** Bulk price change. percent: e.g. 10 or -15. round: "none" | "0.10" | "0.50" | "1" | "99".
      Returns the new number, or NaN if the price isn't a number. */
  function adjustPrice(raw, percent, round) {
    var n = priceNumber(raw);
    if (isNaN(n)) return NaN;
    n = n * (1 + (Number(percent) || 0) / 100);
    if (round === "0.10") n = Math.round(n * 10) / 10;
    else if (round === "0.50") n = Math.round(n * 2) / 2;
    else if (round === "1") n = Math.round(n);
    else if (round === "99") n = Math.max(0.99, Math.round(n) - 0.01);
    n = Math.round(n * 100) / 100;
    return n < 0 ? 0 : n;
  }
  /** Price as stored/exported: plain "12.50", no symbol. Text that isn't a number is kept. */
  function plainPrice(raw) {
    var n = priceNumber(raw);
    return isNaN(n) ? String(raw == null ? "" : raw).trim() : n.toFixed(2);
  }

  // ---------- CSV out ----------
  function csvField(v) {
    v = String(v == null ? "" : v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  /** Cards back to CSV text. The currency rides in the price header, e.g. "Price (€)". */
  function cardsToCSV(cards, currency) {
    var sym = currencyOf(currency).symbol;
    var head = ["Card Name", "Card No.", "Set", "Set Code", "Rarity", "Condition", "Price (" + sym + ")", "Qty", "Link"];
    var lines = [head.join(",")];
    cards.forEach(function (c) {
      lines.push([c.name, c.number, c.set, c.setCode, c.rarity, c.condition, plainPrice(c.price), c.qty || 1, c.qr].map(csvField).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  /** Default QR link: a Cardmarket search for the card. Short form so the QR stays scannable. */
  var DEFAULT_QR_TEMPLATE = "https://cardmarket.com/en/Pokemon/Products/Search?searchString={name} {number}";

  function encodeQueryValue(v) {
    return encodeURIComponent(v).replace(/%20/g, "+").replace(/%2F/gi, "/");
  }

  function fillTemplate(tpl, rec) {
    var isUrl = /^https?:\/\//i.test(tpl);
    var out = String(tpl || "").replace(/\{(name|number|price|setcode|set|rarity|condition)\}/gi, function (_, k) {
      k = k.toLowerCase();
      var v = (k === "setcode" ? rec.setCode : rec[k]) || "";
      return isUrl ? encodeQueryValue(v) : v;
    });
    if (isUrl) out = out.replace(/ /g, "+").replace(/\++$/, "").replace(/=\++/, "=").replace(/\+{2,}/g, "+");
    return out.trim();
  }

  /** Work out what the QR code should hold for a card.
      mode "auto": link column if that card has one, otherwise the link template.
      mode "column": link column only. mode "template": the template/fixed link for every card. */
  function qrTextFor(card, opts) {
    var tpl = (opts.qrTemplate || "").trim() || DEFAULT_QR_TEMPLATE;
    if (opts.qrSource === "column") return card.qr || "";
    if (opts.qrSource !== "template" && card.qr) return card.qr;
    // Very long names make the code too dense to print at 2 dots per square,
    // so drop words from the end of the name until the link is short enough.
    var name = String(card.name || ""), url = fillTemplate(tpl, card);
    while (url.length > MAX_QR_LINK && name.indexOf(" ") > 0) {
      name = name.slice(0, name.lastIndexOf(" "));
      url = fillTemplate(tpl, Object.assign({}, card, { name: name }));
    }
    return url;
  }
  var MAX_QR_LINK = 150;

  /** Build a plain card record from a CSV row and a column mapping. */
  function toCard(row, map) {
    function get(f) { return map[f] ? (row[map[f]] || "") : ""; }
    var qty = parseInt(get("qty"), 10);
    return {
      name: get("name"), number: get("number"), price: get("price"),
      set: get("set"), setCode: get("setCode"), rarity: get("rarity"), condition: get("condition"), qr: get("qr"),
      qty: isNaN(qty) || qty < 1 ? 1 : Math.min(qty, 99)
    };
  }

  /** Filter cards. f: {text, set, rarity, condition, min, max}. Returns indexes that match. */
  function filterCards(cards, f) {
    f = f || {};
    var text = String(f.text || "").trim().toLowerCase();
    var min = f.min === "" || f.min == null ? NaN : Number(f.min);
    var max = f.max === "" || f.max == null ? NaN : Number(f.max);
    var out = [];
    cards.forEach(function (c, i) {
      if (text && (c.name + " " + c.number + " " + (c.setCode || "")).toLowerCase().indexOf(text) < 0) return;
      if (f.set && c.set !== f.set) return;
      if (f.rarity && c.rarity !== f.rarity) return;
      if (f.condition && c.condition !== f.condition) return;
      if (!isNaN(min) || !isNaN(max)) {
        var p = priceNumber(c.price);
        if (isNaN(p)) return;
        if (!isNaN(min) && p < min) return;
        if (!isNaN(max) && p > max) return;
      }
      out.push(i);
    });
    return out;
  }

  // ---------- Drawing ----------
  var FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';
  function setFont(ctx, weight, px) { ctx.font = weight + " " + px + "px " + FONT; }

  /** Largest font size (<= maxPx) where every line fits maxW. */
  function fitLines(ctx, lines, maxW, maxPx, weight, minPx) {
    var px = Math.floor(maxPx);
    while (px > minPx) {
      setFont(ctx, weight, px);
      if (lines.every(function (l) { return ctx.measureText(l).width <= maxW; })) break;
      px--;
    }
    setFont(ctx, weight, px);
    return px;
  }

  /** Split text into 2 lines as evenly as possible (by width). */
  function wrapTwo(ctx, text) {
    var words = text.split(/\s+/);
    if (words.length < 2) return [text];
    var best = null;
    for (var i = 1; i < words.length; i++) {
      var a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
      var w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
      if (!best || w < best.w) best = { w: w, lines: [a, b] };
    }
    return best.lines;
  }

  function ellipsize(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
    return text + "…";
  }

  // Cap height of Helvetica-like fonts is about 0.72 of the font size.
  var CAP = 0.72;

  /** Card name across the top: one line if it fits big enough, else two lines, shrinking to fit. */
  function drawName(ctx, text, box) {
    var minPx = 9;
    var one = fitLines(ctx, [text], box.w, Math.min(box.h / 1.15, 30), "bold", minPx);
    var lines = [text], px = one;
    if (box.h >= 2 * minPx * 1.05) {
      setFont(ctx, "bold", 20);
      var two = wrapTwo(ctx, text);
      if (two.length === 2) {
        var p2 = fitLines(ctx, two, box.w, box.h / 2 / 1.05, "bold", minPx);
        if (p2 > one * 1.12) { lines = two; px = p2; }
      }
    }
    setFont(ctx, "bold", px);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    var lineH = lines.length === 1 ? box.h : box.h / 2;
    lines.forEach(function (l, i) {
      var capTop = box.y + lineH * i + (lines.length === 1 ? 0 : 0);
      var baseline = Math.round(capTop + px * CAP + (lines.length === 1 ? Math.max(0, (box.h - px * 1.1) / 4) : Math.max(0, (lineH - px * 1.05) / 2)));
      ctx.fillText(ellipsize(ctx, l, box.w), box.x, baseline);
    });
  }

  function drawQR(ctx, text, box) {
    if (!text || typeof global.qrcode !== "function") return { ok: false, reason: "No QR text" };
    var qr = global.qrcode(0, "L");
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var cell = Math.floor(Math.min(box.w, box.h) / count);
    if (cell < 1) return { ok: false, reason: "Link too long for this label" };
    var size = cell * count;
    var ox = Math.round(box.x), oy = Math.round(box.y + (box.h - size) / 2);
    ctx.fillStyle = "#000";
    for (var r = 0; r < count; r++)
      for (var c = 0; c < count; c++)
        if (qr.isDark(r, c)) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
    return { ok: true, cell: cell, modules: count, size: size, text: text };
  }

  function drawIcon(ctx, img, box) {
    if (!img) return;
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) { iw = ih = 1; }
    var s = Math.min(box.w / iw, box.h / ih);
    var w = iw * s, h = ih * s;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
  }

  /** Make every pixel pure black or white (what the thermal head can print). */
  function threshold(ctx, w, h) {
    var d = ctx.getImageData(0, 0, w, h);
    var p = d.data;
    for (var i = 0; i < p.length; i += 4) {
      var a = p[i + 3] / 255;
      var lum = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) * a + 255 * (1 - a);
      var v = lum < 140 ? 0 : 255;
      p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
  }

  // ---------- Layout with set info (v3.0.2) ----------
  // Used when "Set" is switched on and the card has a set code or set name.
  // Name across the top (up to 2 lines), set code + number on one line and condition below it
  // at the bottom left, price big at the bottom right. Text never goes below MIN_INFO_PX
  // (about 1.3 mm tall capitals at 8 dots per mm) and the price always stays the biggest text.
  var MIN_INFO_PX = 14;   // cap height 14 * 0.72 = 10 dots = 1.26 mm
  var MAX_INFO_PX = 18;
  var MIN_NAME_PX = 12;   // name shrinks to this before it gets "…"
  var SEP = " · ";

  /** Largest px in [minPx, maxPx] where every line fits maxW. {px, fits} */
  function fitPx(ctx, lines, maxW, maxPx, minPx, weight) {
    maxPx = Math.floor(maxPx);
    var ok = function (px) {
      setFont(ctx, weight, px);
      return lines.every(function (l) { return ctx.measureText(l).width <= maxW; });
    };
    if (maxPx < minPx) return { px: maxPx, fits: ok(maxPx) };
    if (ok(maxPx)) return { px: maxPx, fits: true };
    if (!ok(minPx)) return { px: minPx, fits: false };
    var lo = minPx, hi = maxPx; // ok(lo) true, ok(hi) false
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ok(mid)) lo = mid; else hi = mid; }
    return { px: lo, fits: true };
  }

  /** The short set text for a card: the set code if there is one, else the set name. */
  function setLabelFor(card) {
    return String(card.setCode || "").trim() || String(card.set || "").trim();
  }
  /** Card number without a repeated set code: "OP05-119" with code "OP05" becomes "119". */
  function shortNumber(number, code) {
    number = String(number || "").trim(); code = String(code || "").trim();
    if (!code || !number) return number;
    var low = number.toLowerCase(), c = code.toLowerCase();
    if (low.indexOf(c) === 0) {
      var rest = number.slice(code.length).replace(/^[\s\-_#:/.]+/, "");
      if (rest) return rest;
    }
    return number;
  }

  /** Name lines for a box: one line if it's big enough, else two, shrinking to minPx before "…". */
  function layoutName(ctx, text, w, h, maxPx, minPx) {
    var r1 = fitPx(ctx, [text], w, Math.min(h / 1.15, maxPx), minPx, "bold");
    var best = { lines: [text], px: r1.px, fits: r1.fits };
    if (h >= 2 * minPx * 1.08) {
      setFont(ctx, "bold", 20);
      var two = wrapTwo(ctx, text);
      if (two.length === 2) {
        var r2 = fitPx(ctx, two, w, Math.min(h / 2 / 1.08, maxPx), minPx, "bold");
        if ((r2.fits && (!r1.fits || r2.px > r1.px * 1.12)) || (!r1.fits && !r2.fits)) best = { lines: two, px: r2.px, fits: r2.fits };
      }
    }
    if (!best.fits) {
      // Still too long at the smallest size: fill line 1 word by word, "…" at the end of line 2.
      setFont(ctx, "bold", best.px);
      var words = text.split(/\s+/), l1 = words[0], k = 1;
      while (k < words.length && ctx.measureText(l1 + " " + words[k]).width <= w) { l1 += " " + words[k]; k++; }
      var rest = words.slice(k).join(" ");
      best.lines = best.lines.length === 2 && rest ? [ellipsize(ctx, l1, w), ellipsize(ctx, rest, w)] : [ellipsize(ctx, text, w)];
      best.truncated = true;
    }
    return best;
  }

  /** Fit an info line into maxW at the current font. A "set · number" line loses letters from the set part first. */
  function fitInfoLine(ctx, line, maxW) {
    if (ctx.measureText(line.text).width <= maxW) return { text: line.text, cut: 0 };
    if (line.set && line.rest) {
      var s = line.set, tail = SEP + line.rest;
      while (s.length > 1 && ctx.measureText(s + "…" + tail).width > maxW) s = s.slice(0, -1);
      var t = s + "…" + tail;
      if (ctx.measureText(t).width <= maxW && s.length >= 3) return { text: t, cut: line.set.length - s.length };
    }
    // Drop whole parts from the end (condition first) rather than leaving "199/165 · …".
    var parts = line.parts.slice(), cut = 0;
    while (parts.length > 1 && ctx.measureText(parts.join(SEP)).width > maxW) cut += parts.pop().length + 1;
    var e = ellipsize(ctx, parts.join(SEP), maxW);
    if (e !== parts.join(SEP)) cut += parts.join(SEP).length - e.length + 1;
    return { text: e, cut: cut };
  }

  /** Ways to split set / number / condition into lines, most preferred first. */
  function infoGroupings(setTxt, num, cond) {
    function line(parts, hasSet) {
      parts = parts.filter(Boolean); if (!parts.length) return null;
      var o = { text: parts.join(SEP), parts: parts };
      if (hasSet && setTxt && parts.length > 1 && parts[0] === setTxt) { o.set = setTxt; o.rest = parts.slice(1).join(SEP); }
      return o;
    }
    var gs = [
      [line([setTxt, num], true), line([cond])],
      [line([setTxt, num, cond], true)],
      [line([setTxt]), line([num, cond])],
      [line([setTxt]), line([num]), line([cond])]
    ];
    var seen = {}, out = [];
    gs.forEach(function (g, rank) {
      g = g.filter(Boolean); var key = g.map(function (l) { return l.text; }).join("\n");
      if (g.length && !seen[key]) { seen[key] = 1; out.push({ lines: g, rank: rank }); }
    });
    return out;
  }

  /** Work out the best layout. Returns a plan the drawer follows; also used by the tests. */
  // Biggest bold size for the price that fits maxW wide and h tall, counting the real ink
  // (the comma in "1,250" and the "$" reach below the line; they may use DESC_ROOM px of the margin).
  var DESC_ROOM = 2;
  function priceInk(ctx, price, px) {
    setFont(ctx, "bold", px);
    var m = ctx.measureText(price);
    var asc = typeof m.actualBoundingBoxAscent === "number" ? m.actualBoundingBoxAscent : px * CAP;
    var desc = typeof m.actualBoundingBoxDescent === "number" ? Math.max(0, m.actualBoundingBoxDescent) : 0;
    return { w: m.width, asc: asc, desc: desc };
  }
  function fitPrice(ctx, price, maxW, h, maxPx) {
    var lo = 1, hi = Math.max(1, Math.floor(maxPx || 200));
    var ok = function (px) { var k = priceInk(ctx, price, px); return k.w <= maxW && k.asc + Math.max(0, k.desc - DESC_ROOM) <= h; };
    if (!ok(lo)) return { px: lo, fits: false };
    while (lo < hi) { var mid = Math.ceil((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid - 1; }
    return { px: lo, fits: true };
  }
  function priceBaseline(ctx, price, px, bottom) {
    return bottom - Math.max(0, Math.ceil(priceInk(ctx, price, px).desc) - DESC_ROOM);
  }

  function planSetLayout(ctx, box, name, price, info) {
    var groups = infoGroupings(info.set, info.number, info.condition);
    var gap = 6, plans = [];
    var priceMaxFor = function (h) { return h / CAP * 0.98; };
    var isCode = !!info.isCode;
    setFont(ctx, "normal", MIN_INFO_PX);
    var pairFits = !!(info.set && info.number) && ctx.measureText(info.set + SEP + info.number).width <= box.w;

    function finish(p) {
      // Name gets the space above; it must stay smaller than the price.
      if (name) {
        var nameMax = p.pricePx ? Math.max(MIN_NAME_PX, Math.floor(p.pricePx * 0.92)) : 40;
        p.name = layoutName(ctx, name, box.w, p.nameH, Math.min(nameMax, 40), Math.min(MIN_NAME_PX, nameMax));
      }
      // On very narrow labels a long price can't get big; then the set text drops to match it (never below the minimum).
      if (p.pricePx && p.infoPx > p.pricePx) p.infoPx = Math.max(MIN_INFO_PX, p.pricePx);
      // Scores: a bigger price helps less once it's already big; splitting set and number apart,
      // cutting letters off, or cutting the name short all cost points.
      var pp = p.pricePx || 0;
      var score = Math.min(pp, 42) + 0.35 * Math.max(0, pp - 42) + (p.name ? p.name.px * 1.6 : 0) + (p.infoPx || 0) * 2;
      // With a short code, splitting code and number onto separate lines is a last resort.
      var rankCost = isCode && pairFits ? [0, 8, 45, 60] : [0, 8, 14, 30];
      score -= rankCost[p.rank] + (p.mode === "stack" ? 6 : 0) + (p.cut ? 60 + 3 * p.cut : 0) + (p.name && p.name.truncated ? 120 : 0);
      if (p.name && p.pricePx && p.name.px > p.pricePx) score -= 1000;
      p.score = score;
      plans.push(p);
    }

    var nameShares = name ? [0.5, 0.44, 0.56] : [0];
    // Side by side: info at the bottom left, price at the bottom right.
    nameShares.forEach(function (share) {
      var nameH = Math.round(box.h * share), bh = box.h - nameH - (name ? 2 : 0);
      groups.forEach(function (g) {
        var n = g.lines.length;
        if (n * MIN_INFO_PX * 1.1 > bh) return;
        var maxInfo = Math.min(MAX_INFO_PX, Math.floor(bh / n / 1.1));
        var texts = g.lines.map(function (l) { return l.text; });
        var best = null;
        for (var ip = maxInfo; ip >= MIN_INFO_PX; ip--) {
          setFont(ctx, "normal", ip);
          var iw = Math.max.apply(null, texts.map(function (t) { return ctx.measureText(t).width; }));
          var pr = price ? fitPrice(ctx, price, box.w - iw - gap, bh, priceMaxFor(bh)) : { px: 0, fits: true };
          if (price && (!pr.fits || box.w - iw - gap <= 0)) continue;
          var cand = { mode: "side", nameH: nameH, bandH: bh, group: g, rank: g.rank, infoPx: ip, pricePx: pr.px, infoW: iw, cut: 0 };
          // Price must stay well above the info text.
          if (price && pr.px < Math.max(ip * 1.6, 24)) continue;
          if (!best || cand.pricePx + cand.infoPx * 2 > best.pricePx + best.infoPx * 2) best = cand;
        }
        if (!best) {
          // Doesn't fit at the smallest size: give the price its floor and shorten the set name.
          var floorPx = price ? Math.min(Math.floor(priceMaxFor(bh)), Math.max(MIN_INFO_PX * 1.6, 24)) : 0;
          var prW = 0;
          if (price) { var pf = fitPrice(ctx, price, box.w * 0.6, bh, floorPx); floorPx = pf.px; setFont(ctx, "bold", floorPx); prW = ctx.measureText(price).width; }
          var avail = box.w - prW - (price ? gap : 0);
          setFont(ctx, "normal", MIN_INFO_PX);
          var cut = 0, fitted = g.lines.map(function (l) { var f = fitInfoLine(ctx, l, avail); cut += f.cut; return f.text; });
          best = { mode: "side", nameH: nameH, bandH: bh, group: g, rank: g.rank, infoPx: MIN_INFO_PX, pricePx: floorPx, cut: cut, fitted: fitted };
        }
        finish(best);
      });
    });

    // Stacked: name, then the info line(s) across the full width, then the price on its own row.
    if (price) {
      groups.forEach(function (g) {
        if (g.lines.length > 2) return;
        [0.42, 0.5].forEach(function (pshare) {
          var ph = Math.round(box.h * pshare);
          var restH = box.h - ph - 2;
          var n = g.lines.length;
          var ih = Math.min(Math.round(n * MAX_INFO_PX * 1.1), restH - (name ? Math.ceil(MIN_NAME_PX * 1.15) : 0));
          if (ih < n * MIN_INFO_PX * 1.1) return;
          var texts = g.lines.map(function (l) { return l.text; });
          var ir = fitPx(ctx, texts, box.w, Math.min(MAX_INFO_PX, ih / n / 1.1), MIN_INFO_PX, "normal");
          var cut = 0, fitted = null;
          if (!ir.fits) {
            setFont(ctx, "normal", ir.px);
            fitted = g.lines.map(function (l) { var f = fitInfoLine(ctx, l, box.w); cut += f.cut; return f.text; });
          }
          var usedIH = Math.ceil(n * ir.px * 1.1);
          var pr = fitPrice(ctx, price, box.w, ph, priceMaxFor(ph));
          finish({ mode: "stack", nameH: name ? restH - usedIH : 0, infoH: usedIH, bandH: ph, group: g, rank: g.rank,
            infoPx: ir.px, pricePx: pr.px, cut: cut, fitted: fitted });
        });
      });
    }
    plans.sort(function (a, b) { return b.score - a.score; });
    return plans[0] || null;
  }

  // Draws text and notes where its ink went (used by the layout tests to check nothing overlaps).
  function put(ctx, boxes, kind, t, x, y) {
    if (!t) return;
    ctx.fillText(t, x, y);
    var m = ctx.measureText(t);
    var hasBox = typeof m.actualBoundingBoxRight === "number";
    var x0 = hasBox ? x - m.actualBoundingBoxLeft : (ctx.textAlign === "right" ? x - m.width : x);
    var x1 = hasBox ? x + m.actualBoundingBoxRight : x0 + m.width;
    boxes.push({ kind: kind, text: t, x0: x0, x1: x1,
      top: y - (m.actualBoundingBoxAscent || 0), bottom: y + (m.actualBoundingBoxDescent || 0) });
  }
  function drawNameLines(ctx, nm, box, boxes) {
    setFont(ctx, "bold", nm.px);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    var n = nm.lines.length, lh = n === 1 ? nm.px * 1.1 : Math.min(box.h / 2, nm.px * 1.12);
    var top = box.y + Math.max(0, (box.h - lh * n) / (n === 1 ? 4 : 3));
    nm.lines.forEach(function (l, i) {
      put(ctx, boxes, "name", nm.truncated ? l : ellipsize(ctx, l, box.w), box.x, Math.round(top + lh * i + nm.px * CAP + (lh - nm.px * 1.0) / 2));
    });
  }

  function drawSetLayout(ctx, box, name, price, info) {
    var p = planSetLayout(ctx, box, name, price, info);
    if (!p) return null;
    ctx.fillStyle = "#000";
    var boxes = p.boxes = [];
    if (p.name) drawNameLines(ctx, p.name, { x: box.x, y: box.y, w: box.w, h: p.nameH - 1 }, boxes);
    var texts = p.fitted || p.group.lines.map(function (l) { return l.text; });
    var bottom = box.y + box.h;
    if (p.mode === "side") {
      var by = box.y + box.h - p.bandH;
      var priceW = 0;
      if (price) {
        setFont(ctx, "bold", p.pricePx); priceW = ctx.measureText(price).width;
        ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
        put(ctx, boxes, "price", price, box.x + box.w, priceBaseline(ctx, price, p.pricePx, bottom));
        setFont(ctx, "bold", p.pricePx);
      }
      setFont(ctx, "normal", p.infoPx); ctx.textAlign = "left";
      var maxW = box.w - priceW - (price ? 6 : 0);
      var lh = Math.min(p.bandH / texts.length, p.infoPx * 1.18);
      // Last line sits on the same baseline as the price; the others stack above it.
      texts.forEach(function (t, i) {
        var yb = Math.round(bottom - lh * (texts.length - 1 - i));
        if (yb - p.infoPx * CAP < by - 1) yb = Math.round(by + p.infoPx * CAP + lh * i);
        put(ctx, boxes, "info", ellipsize(ctx, t, maxW), box.x, yb);
      });
    } else {
      var iy = box.y + p.nameH + 1;
      setFont(ctx, "normal", p.infoPx); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      texts.forEach(function (t, i) { put(ctx, boxes, "info", ellipsize(ctx, t, box.w), box.x, Math.round(iy + p.infoPx * 1.1 * i + p.infoPx * CAP + 2)); });
      setFont(ctx, "bold", p.pricePx); ctx.textAlign = "right";
      put(ctx, boxes, "price", price, box.x + box.w, priceBaseline(ctx, price, p.pricePx, bottom));
    }
    return p;
  }

  /**
   * Draw one label onto a canvas.
   * Layout: picture on the left at full height; name across the top of the rest;
   * number and condition small at the bottom left; price large at the bottom right.
   * opts: { size, margin (mm), show:{name,number,condition,set,price}, hidePence, currency: "GBP"|"USD"|"EUR",
   *         graphic: "none"|"qr"|"icon", qrSource: "auto"|"column"|"template", qrTemplate, iconImage }
   * Returns { warnings: [], qr: {...} }.
   */
  function renderLabel(canvas, card, opts) {
    var px = labelPixels(opts.size);
    canvas.width = px.w; canvas.height = px.h;
    var ctx = canvas.getContext("2d");
    var warnings = [], qrInfo = null;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, px.w, px.h);
    ctx.fillStyle = "#000";

    var m = Math.round((opts.margin == null ? 0.75 : opts.margin) * DOTS_PER_MM);
    var vy = Math.min(m, 3);
    var inner = { x: m, y: vy, w: px.w - 2 * m, h: px.h - 2 * vy };
    var text = { x: inner.x, y: inner.y, w: inner.w, h: inner.h };

    if (opts.graphic === "qr" || opts.graphic === "icon") {
      var g = inner.h;
      var gBox = { x: inner.x, y: inner.y, w: g, h: g };
      if (opts.graphic === "qr") {
        var qrText = qrTextFor(card, opts);
        if (!qrText) warnings.push("No QR link for this card");
        else {
          qrInfo = drawQR(ctx, qrText, gBox);
          if (!qrInfo.ok) warnings.push(qrInfo.reason);
          else {
            gBox.w = qrInfo.size; // let the text start right after the code
            if (qrInfo.cell < 2) warnings.push("QR code is very dense and may not scan. Use a shorter link.");
          }
        }
      } else if (opts.iconImage) drawIcon(ctx, opts.iconImage, gBox);
      else warnings.push("No icon chosen");
      var gap = qrInfo && qrInfo.ok ? Math.max(6, qrInfo.cell * 3) : 6;
      text.x = gBox.x + gBox.w + gap;
      text.w = inner.x + inner.w - text.x;
      ctx.fillStyle = "#000";
    }
    if (text.w < 20) return { warnings: warnings.concat("Label too small for text"), qr: qrInfo };

    var price = opts.show.price ? formatPrice(card.price, { hidePence: opts.hidePence, currency: opts.currency }) : "";
    if (opts.show.price && !price) warnings.push("No price");
    var setTxt = opts.show.set ? setLabelFor(card) : "";
    if (setTxt) {
      // v3.0.2 layout: readable set code + number, see drawSetLayout.
      var plan = drawSetLayout(ctx, text, opts.show.name ? card.name : "", price, {
        set: setTxt, isCode: !!String(card.setCode || "").trim(), number: opts.show.number ? shortNumber(card.number, card.setCode) : "",
        condition: opts.show.condition ? String(card.condition || "") : "" });
      threshold(ctx, px.w, px.h);
      return { warnings: warnings, qr: qrInfo, layout: plan && { mode: plan.mode, pricePx: plan.pricePx, infoPx: plan.infoPx,
        namePx: plan.name ? plan.name.px : 0, nameLines: plan.name ? plan.name.lines : [], nameTruncated: !!(plan.name && plan.name.truncated),
        infoLines: plan.fitted || plan.group.lines.map(function (l) { return l.text; }), infoCut: plan.cut,
        boxes: plan.boxes, textBox: text } };
    }
    var small = [];
    if (opts.show.number && card.number) small.push(card.number);
    if (opts.show.condition && card.condition) small.push(card.condition);
    if (opts.show.set && card.set) small.push(card.set);
    var hasBottom = !!(price || small.length);
    var name = opts.show.name ? card.name : "";

    // Split height: name on top, price row at the bottom.
    var nameH = name ? (hasBottom ? Math.round(text.h * 0.5) : text.h) : 0;
    var bottom = { x: text.x, y: text.y + nameH, w: text.w, h: text.h - nameH };
    if (name) drawName(ctx, name, { x: text.x, y: text.y, w: text.w, h: nameH - 2 });

    if (hasBottom) {
      var priceW = 0, pricePx = 0;
      if (price) {
        // Price: as big as the bottom row allows, up to 70% of the width (all of it if nothing else).
        var maxPriceW = small.length ? bottom.w * 0.7 : bottom.w;
        pricePx = fitLines(ctx, [price], maxPriceW, bottom.h / CAP * 0.98, "bold", 10);
        priceW = Math.ceil(ctx.measureText(price).width);
        ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
        ctx.fillText(price, bottom.x + bottom.w, bottom.y + bottom.h);
      }
      if (small.length) {
        var sw = bottom.w - priceW - (price ? 5 : 0);
        var lines = small.length > 1 && bottom.h >= 26 ? [small[0], small.slice(1).join(" · ")] : [small.join(" · ")];
        var spx = fitLines(ctx, lines, sw, Math.min(bottom.h / lines.length / 1.05, 16), "normal", 8);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        var lh = bottom.h / lines.length;
        lines.forEach(function (l, i) {
          ctx.fillText(ellipsize(ctx, l, sw), bottom.x, Math.round(bottom.y + lh * (i + 1) - (lh - spx * CAP) / 2));
        });
      }
    }

    threshold(ctx, px.w, px.h);
    return { warnings: warnings, qr: qrInfo };
  }

  // ---------- Zip (stored, no compression) ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  /** files: [{name, bytes: Uint8Array}] -> Uint8Array zip */
  function makeZip(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), crc = crc32(f.bytes), size = f.bytes.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.bytes);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    });
    var cdSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var out = new Uint8Array(all.reduce(function (s, p) { return s + p.length; }, 0)), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  function safeFileName(s) {
    return String(s || "label").replace(/[^A-Za-z0-9 _.-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "label";
  }

  global.LabelCore = {
    DOTS_PER_MM: DOTS_PER_MM, PRINTHEAD_DOTS: PRINTHEAD_DOTS, LABEL_SIZES: LABEL_SIZES,
    labelPixels: labelPixels, parseCSV: parseCSV, guessMapping: guessMapping, formatPrice: formatPrice, priceNumber: priceNumber,
    DEFAULT_QR_TEMPLATE: DEFAULT_QR_TEMPLATE, qrTextFor: qrTextFor, filterCards: filterCards,
    fillTemplate: fillTemplate, toCard: toCard, renderLabel: renderLabel, makeZip: makeZip, crc32: crc32,
    safeFileName: safeFileName, CURRENCIES: CURRENCIES, currencyOf: currencyOf, detectCurrency: detectCurrency,
    adjustPrice: adjustPrice, plainPrice: plainPrice, cardsToCSV: cardsToCSV,
    setLabelFor: setLabelFor, shortNumber: shortNumber, MIN_INFO_PX: MIN_INFO_PX, FONT: FONT
  };
})(typeof window !== "undefined" ? window : globalThis);
