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
    set: [/^set( name)?$/i, /expansion/i, /^set/i],
    rarity: [/rarity/i],
    condition: [/condition/i, /grade/i, /^cond/i],
    qr: [/^qr/i, /link/i, /url/i],
    qty: [/^qty$/i, /quantity/i, /copies/i, /count/i]
  };

  /** Pick the most likely column for each field. Returns {field: header or ""}. */
  function guessMapping(headers) {
    var used = {}, map = {};
    Object.keys(GUESSES).forEach(function (field) {
      map[field] = "";
      GUESSES[field].some(function (re) {
        var hit = headers.find(function (h) { return !used[h] && re.test(h); });
        if (hit) { map[field] = hit; used[hit] = true; return true; }
        return false;
      });
    });
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
    var head = ["Card Name", "Card No.", "Set", "Rarity", "Condition", "Price (" + sym + ")", "Qty", "Link"];
    var lines = [head.join(",")];
    cards.forEach(function (c) {
      lines.push([c.name, c.number, c.set, c.rarity, c.condition, plainPrice(c.price), c.qty || 1, c.qr].map(csvField).join(","));
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
    var out = String(tpl || "").replace(/\{(name|number|price|set|rarity|condition)\}/g, function (_, k) {
      var v = rec[k] || "";
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
      set: get("set"), rarity: get("rarity"), condition: get("condition"), qr: get("qr"),
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
      if (text && (c.name + " " + c.number).toLowerCase().indexOf(text) < 0) return;
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
    adjustPrice: adjustPrice, plainPrice: plainPrice, cardsToCSV: cardsToCSV
  };
})(typeof window !== "undefined" ? window : globalThis);
