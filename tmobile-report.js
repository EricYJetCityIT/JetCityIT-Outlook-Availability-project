// T-Mobile move reports (Project Planning > T-Mobile). Builds the two PDF
// reports from one move sheet, entirely in the browser:
//   - Walk summary: equipment needed (totals + by desk) and the walk notes.
//   - Completion report: what is good to go / completed / still open.
// Input is the normalized sheet from GET /api/tmobile/sheet. Output is the
// bytes of a PDF laid out and written here (standard Helvetica, uncompressed
// streams), so no library has to be vendored. Exposed as window.TMReport.
(function () {
  'use strict';

  // ── Classification ─────────────────────────────────────────────────────────
  // A desk with a pre-move destination photo is good to go. Otherwise a
  // post-move photo and/or the JetCity Fix check means Jet City IT completed
  // it; a need or a note with neither is still open; anything else has nothing
  // recorded yet (usually people with no destination desk).
  function statusOf(r) {
    if (r.pre) return 'good';
    if (r.fix || r.post) return 'done';
    if (r.needs.length || noteText(r)) return 'open';
    return 'none';
  }

  // Techs sometimes paste a photo's filename into the notes column.
  function noteText(r) {
    var n = String(r.note || '').replace(/\s+/g, ' ').trim();
    if (!n || /\.(jpe?g|png|heic|gif)$/i.test(n)) return '';
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  // Which bucket a walk note belongs in: the Walk Status picklist when the
  // sheet has it, otherwise the wording techs used on earlier jobs.
  function noteKind(r) {
    var s = String(r.status || '').toLowerCase();
    if (s === 'not found') return 'notFound';
    if (s === 'user at desk') return 'atDesk';
    if (s === 'follow-up') return 'followUp';
    var n = noteText(r).toLowerCase();
    if (!n) return '';
    if (/can'?t find|cannot find|unable to find|not found/.test(n)) return 'notFound';
    if (/at (the )?desk|occup|moved in|at setup|set ?up (is )?(already )?complete/.test(n)) return 'atDesk';
    return 'followUp';
  }

  var NEED_LABELS = {
    'dp cable': ['DP cable', 'DP cables'],
    'usbc': ['USB-C cable', 'USB-C cables'], 'usb-c': ['USB-C cable', 'USB-C cables'],
    'monitors': ['Monitor', 'Monitors'], 'monitor': ['Monitor', 'Monitors'],
    'monitor power': ['Monitor power cable', 'Monitor power cables'],
    'arms': ['Monitor arm', 'Monitor arms'], 'arm': ['Monitor arm', 'Monitor arms'],
    'full setup': ['Full setup', 'Full setups'],
  };
  function needLabel(n) {
    var l = NEED_LABELS[String(n).toLowerCase().trim()];
    return l ? l[0] : String(n).trim();
  }
  // counts carry display labels ("USB-C cable"); pluralize via the label table.
  function pluralLabel(label, many) {
    if (!many) return label;
    for (var k in NEED_LABELS) if (NEED_LABELS[k][0] === label) return NEED_LABELS[k][1];
    return label;
  }
  var NEED_ORDER = ['DP cable', 'USB-C cable', 'Monitor', 'Monitor power cable', 'Monitor arm', 'Full setup'];
  function needRank(label) { var i = NEED_ORDER.indexOf(label); return i < 0 ? NEED_ORDER.length : i; }
  function countNeeds(rows) {
    var c = {};
    rows.forEach(function (r) { r.needs.forEach(function (n) { var l = needLabel(n); c[l] = (c[l] || 0) + 1; }); });
    return Object.keys(c).sort(function (a, b) { return needRank(a) - needRank(b) || a.localeCompare(b); })
      .map(function (k) { return { label: k, count: c[k] }; });
  }

  function shortBldg(b) {
    var m = /building\s*(\w+)/i.exec(b || '');
    return m ? 'Bldg ' + m[1] : (b || '');
  }
  // Destination order; people with no destination building go last.
  function byDesk(a, b) {
    var k = function (r) { return (r.bldg ? '0' : '1') + r.bldg + '|' + r.desk + '|' + r.name; };
    return k(a).localeCompare(k(b), undefined, { numeric: true });
  }
  // Name parts typed in ALL CAPS ("JANE Doe") read better in title case.
  function tidyName(n) {
    return String(n || '').split(' ').map(function (w) {
      return /^[A-Z]{3,}$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w;
    }).join(' ');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function summarize(sheet) {
    var rows = sheet.rows.slice().sort(byDesk);
    rows.forEach(function (r) { r._status = statusOf(r); r._kind = noteKind(r); });
    var needRows = rows.filter(function (r) { return r.needs.length; });
    var pick = function (s) { return rows.filter(function (r) { return r._status === s; }); };
    return {
      rows: rows,
      good: pick('good'), done: pick('done'), open: pick('open'), none: pick('none'),
      needRows: needRows,
      needCounts: countNeeds(needRows),
    };
  }

  // ── PDF writer ─────────────────────────────────────────────────────────────
  // US Letter, points. Text uses the PDF standard fonts (Helvetica and
  // Helvetica-Bold, WinAnsi encoding) so nothing is embedded; widths below are
  // the standard Helvetica metrics (1/1000 em) for ASCII 32-126, used to wrap.
  var PAGE_W = 612, PAGE_H = 792, MARGIN_X = 54, MARGIN_TOP = 54, MARGIN_BOTTOM = 60;
  var CONTENT_W = PAGE_W - 2 * MARGIN_X;
  var W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  var W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  var BLUE = '0.184 0.333 0.588', DARK = '0.13 0.13 0.13', GREY = '0.42 0.42 0.42';

  // Map typographic characters to WinAnsi-safe text; drop anything else that
  // isn't Latin-1 (the standard fonts can't draw it).
  function pdfText(s) {
    return String(s == null ? '' : s)
      .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
      .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/•/g, '-')
      .replace(/[ \t\r\n]+/g, ' ')
      .replace(/[^ -~¡-ÿ]/g, '');
  }
  function textWidth(s, size, bold) {
    var w = 0, t = bold ? W_BOLD : W_REG;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); w += (c >= 32 && c <= 126) ? t[c - 32] : 556; }
    return w * size / 1000;
  }
  function esc(s) { return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

  // Greedy word wrap over mixed bold/regular runs. Returns lines of segments.
  function wrapRuns(runs, size, maxW) {
    var words = [];
    runs.forEach(function (r) {
      pdfText(r.text).split(/(\s+)/).forEach(function (w) { if (w) words.push({ t: w, bold: !!r.bold, space: /^\s+$/.test(w) }); });
    });
    var lines = [], line = [], lineW = 0;
    function push() { while (line.length && line[line.length - 1].space) line.pop(); lines.push(line); line = []; lineW = 0; }
    words.forEach(function (w) {
      if (w.space) { if (line.length) { line.push({ t: ' ', bold: w.bold, space: true }); lineW += textWidth(' ', size, w.bold); } return; }
      var ww = textWidth(w.t, size, w.bold);
      if (lineW + ww > maxW && line.length) push();
      // A single word wider than the column (long email, long desk id) is split.
      while (ww > maxW && w.t.length > 1) {
        var n = w.t.length; while (n > 1 && textWidth(w.t.slice(0, n), size, w.bold) > maxW) n--;
        line.push({ t: w.t.slice(0, n), bold: w.bold }); push();
        w = { t: w.t.slice(n), bold: w.bold }; ww = textWidth(w.t, size, w.bold);
      }
      line.push(w); lineW += ww;
    });
    if (line.length || !lines.length) push();
    return lines;
  }

  function Doc() { this.pages = []; this.images = []; this.newPage(); }
  // JPEG photos are embedded as-is (DCTDecode); the browser re-encodes every
  // photo to JPEG before it gets here (see tmPreparePhotos in index.html).
  Doc.prototype.addImage = function (img) { this.images.push(img); return 'Im' + this.images.length; };
  Doc.prototype.drawImage = function (name, x, y, w, h) {
    this.ops.push('q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /' + name + ' Do Q');
  };
  Doc.prototype.newPage = function () { this.ops = []; this.pages.push(this.ops); this.y = PAGE_H - MARGIN_TOP; };
  Doc.prototype.room = function (h) { if (this.y - h < MARGIN_BOTTOM) this.newPage(); };
  Doc.prototype.textAt = function (x, y, s, size, bold, color) {
    this.ops.push('BT ' + (color || DARK) + ' rg /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf 1 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm (' + esc(s) + ') Tj ET');
  };
  Doc.prototype.drawLines = function (lines, x, size, lead, color) {
    var self = this;
    lines.forEach(function (segs) {
      self.room(lead);
      self.y -= lead;
      var cx = x;
      segs.forEach(function (s) { if (!s.space) self.textAt(cx, self.y + (lead - size) * 0.35, s.t, size, s.bold, color); cx += textWidth(s.t, size, s.bold); });
    });
  };
  Doc.prototype.rich = function (runs, opts) {
    opts = opts || {};
    var size = opts.size || 10, lead = size * 1.35;
    this.drawLines(wrapRuns(runs, size, CONTENT_W), MARGIN_X, size, lead, opts.color);
    this.y -= opts.after != null ? opts.after : 5;
  };
  Doc.prototype.title = function (t) { this.rich([{ text: t }], { size: 22, after: 4 }); };
  Doc.prototype.para = function (t, opts) { this.rich([{ text: t }], opts); };
  Doc.prototype.label = function (l, t) { this.rich([{ text: l, bold: true }, { text: t }]); };
  // Headings keep with what follows: start a new page if there isn't room for
  // the heading plus a few lines under it.
  Doc.prototype.h1 = function (t) { this.y -= 10; this.room(70); this.rich([{ text: t, bold: true }], { size: 15, color: BLUE, after: 4 }); };
  Doc.prototype.h2 = function (t) { this.y -= 5; this.room(55); this.rich([{ text: t, bold: true }], { size: 12, color: BLUE, after: 3 }); };
  Doc.prototype.pageBreak = function () { this.newPage(); };

  // Grid table: header row shaded and repeated on every page it spans.
  Doc.prototype.table = function (headers, data, weights, opts) {
    opts = opts || {};
    var self = this, size = 9, lead = 11.5, pad = 4;
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    var widths = weights.map(function (w) { return CONTENT_W * w / sum; });
    function layout(cells, bold) {
      var wrapped = cells.map(function (c, i) { return wrapRuns([{ text: String(c == null ? '' : c), bold: bold }], size, widths[i] - 2 * pad); });
      var h = Math.max.apply(null, wrapped.map(function (l) { return l.length; })) * lead + 2 * pad;
      return { wrapped: wrapped, h: h, bold: bold };
    }
    function drawRow(row, fill) {
      var x = MARGIN_X, top = self.y;
      row.wrapped.forEach(function (lines, i) {
        var w = widths[i];
        if (fill) self.ops.push(fill + ' rg ' + x.toFixed(2) + ' ' + (top - row.h).toFixed(2) + ' ' + w.toFixed(2) + ' ' + row.h.toFixed(2) + ' re f');
        self.ops.push('0.65 0.65 0.65 RG 0.5 w ' + x.toFixed(2) + ' ' + (top - row.h).toFixed(2) + ' ' + w.toFixed(2) + ' ' + row.h.toFixed(2) + ' re S');
        lines.forEach(function (segs, li) {
          var ty = top - pad - (li + 1) * lead + (lead - size) * 0.45, cx = x + pad;
          segs.forEach(function (s) { if (!s.space) self.textAt(cx, ty, s.t, size, s.bold); cx += textWidth(s.t, size, s.bold); });
        });
        x += w;
      });
      self.y -= row.h;
    }
    var head = layout(headers, true);
    this.room(head.h + lead + 2 * pad);
    drawRow(head, '0.85 0.85 0.85');
    data.forEach(function (cells, ri) {
      var row = layout(cells, !!(opts.boldLast && ri === data.length - 1));
      if (self.y - row.h < MARGIN_BOTTOM) { self.newPage(); drawRow(head, '0.85 0.85 0.85'); }
      drawRow(row);
    });
    this.y -= 10;
  };

  Doc.prototype.toBytes = function (footer) {
    var n = this.pages.length;
    this.pages.forEach(function (ops, i) {
      var t = pdfText(footer) + '   |   Page ' + (i + 1) + ' of ' + n;
      ops.push('BT ' + GREY + ' rg /F1 8 Tf 1 0 0 1 ' + MARGIN_X + ' 32 Tm (' + esc(t) + ') Tj ET');
    });
    // Objects: 1 catalog, 2 page tree, 3/4 fonts, a page + content pair per
    // page, then one object per embedded photo.
    var objs = [], imgBase = 5 + 2 * n;
    var xobjects = this.images.length ? ' /XObject << ' + this.images.map(function (_, i) { return '/Im' + (i + 1) + ' ' + (imgBase + i) + ' 0 R'; }).join(' ') + ' >>' : '';
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [' + this.pages.map(function (_, i) { return (5 + 2 * i) + ' 0 R'; }).join(' ') + '] /Count ' + n + ' >>';
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    this.pages.forEach(function (ops, i) {
      var content = ops.join('\n');
      objs[5 + 2 * i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + xobjects + ' >> /Contents ' + (6 + 2 * i) + ' 0 R >>';
      objs[6 + 2 * i] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
    });
    this.images.forEach(function (img, i) {
      // Each byte of the JPEG becomes one char, so lengths and offsets stay byte-exact.
      var s = '';
      for (var p = 0; p < img.bytes.length; p += 8192) s += String.fromCharCode.apply(null, img.bytes.subarray(p, p + 8192));
      objs[imgBase + i] = '<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.bytes.length + ' >>\nstream\n' + s + '\nendstream';
    });
    // Every character is a single Latin-1 byte, so string length == byte offset.
    var out = '%PDF-1.4\n%âãÏÓ\n', offsets = [];
    for (var k = 1; k < objs.length; k++) { offsets[k] = out.length; out += k + ' 0 obj\n' + objs[k] + '\nendobj\n'; }
    var xref = out.length;
    out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
    for (k = 1; k < objs.length; k++) out += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    var bytes = new Uint8Array(out.length);
    for (k = 0; k < out.length; k++) bytes[k] = out.charCodeAt(k) & 0xff;
    return bytes;
  };


  // ── Report options ─────────────────────────────────────────────────────────
  // Both reports take opts (all optional; omitted = everything, as before):
  //   sections:  section keys to include (see SECTIONS)
  //   columns:   person-table columns to include (see COLUMNS); Name is always shown
  //   hideNotes: leave out the text techs typed in JCIT Notes
  //   scope:     a line describing what was left out, printed under the header
  // Rows to leave out are removed by the caller before the sheet is passed in,
  // so excluded people never reach the PDF at all.
  var SECTIONS = {
    walk: [['totals', 'Equipment totals'], ['bydesk', 'Equipment by desk'], ['followUp', 'Needs follow-up'], ['atDesk', 'Already at their desk'], ['notFound', 'Not found']],
    completion: [['summary', 'Summary'], ['completed', 'Completed by Jet City IT'], ['good', 'Good to go (by floor)'], ['alsoChecked', 'Also checked after the move'],
      ['open', 'Still open'], ['none', 'Nothing recorded'], ['photos', 'Photos'], ['appendix', 'Appendix: good-to-go list']],
  };
  var COLUMNS = [['bldg', 'Building'], ['floor', 'Floor'], ['desk', 'Desk'], ['curDesk', 'Current desk'], ['note', 'JCIT notes']];
  var DEFAULT_COLUMNS = ['bldg', 'floor', 'desk', 'note'];

  var O = {}; // options of the report being built (reports are built one at a time)
  function on(key) { return !O.sections || O.sections.indexOf(key) >= 0; }
  function col(key) {
    if (key === 'note' && O.hideNotes) return false;
    return (O.columns || DEFAULT_COLUMNS).indexOf(key) >= 0;
  }
  function note(r) { return O.hideNotes ? '' : noteText(r); }
  // "Bldg 3, 07-7300" from whichever of building/desk are switched on.
  function loc(r) {
    var p = [];
    if (col('bldg') && r.bldg) p.push(shortBldg(r.bldg));
    if (col('desk')) p.push(r.desk || 'no desk');
    return p.join(', ');
  }

  // ── Shared report pieces ───────────────────────────────────────────────────
  function longDate(d) { return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
  function jobTitle(sheet) {
    // "11/4 Some Building" -> "Some Building"
    return String(sheet.name || 'T-Mobile move').replace(/^\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*/, '') || 'T-Mobile move';
  }
  function header(d, sheet, label, date) {
    d.title(jobTitle(sheet) + ' Move');
    d.para(label + '  |  ' + longDate(date) + '  |  Jet City IT', { color: GREY });
    d.para('Source: ' + sheet.name + ' Smartsheet (' + plural(sheet.rows.length, 'person', 'people') + ').', { color: GREY, after: O.scope ? 2 : 6 });
    if (O.scope) d.para(O.scope, { color: GREY, after: 6 });
  }
  function needList(counts) {
    return counts.map(function (c) {
      return c.count + ' ' + pluralLabel(c.label, c.count !== 1).replace(/^[A-Z](?![A-Z])/, function (m) { return m.toLowerCase(); });
    }).join(', ');
  }

  // One table of people. `fields` is the table's natural columns; only the
  // ones switched on are shown. opts.need adds the Need column first,
  // opts.noteFn overrides the note text.
  var COL_DEF = {
    bldg: ['Building', 10, function (r) { return shortBldg(r.bldg) || 'Not assigned'; }],
    floor: ['Floor', 7, function (r) { return r.floor; }],
    desk: ['Desk', 11, function (r) { return r.desk; }],
    curDesk: ['Current desk', 11, function (r) { return r.curDesk; }],
    note: ['Note', 30, function (r) { return note(r); }],
  };
  function personTable(d, rows, fields, opts) {
    opts = opts || {};
    var keys = fields.filter(col);
    var heads = (opts.need ? ['Need'] : []).concat(['Name'], keys.map(function (k) { return COL_DEF[k][0]; }));
    var weights = (opts.need ? [18] : []).concat([26], keys.map(function (k) { return COL_DEF[k][1]; }));
    d.table(heads, rows.map(function (r) {
      return (opts.need ? [r.needs.map(needLabel).join(' + ')] : []).concat([r.name], keys.map(function (k) {
        return k === 'note' && opts.noteFn ? opts.noteFn(r) : COL_DEF[k][2](r);
      }));
    }), weights);
  }
  var PERSON_FIELDS = ['bldg', 'floor', 'desk', 'curDesk', 'note'];
  function needTable(d, rows) { personTable(d, rows, PERSON_FIELDS, { need: true }); }

  // Notes split into "follow-up" (people sharing a desk and the same note, like
  // a project room, become one line), "at their desk", and "not found"
  // (grouped by hotel desk). kinds limits which groups are printed.
  function notesSection(d, rows, kinds) {
    var want = function (k) { return !kinds || kinds.indexOf(k) >= 0; };
    var follow = rows.filter(function (r) { return r._kind === 'followUp'; });
    var atDesk = rows.filter(function (r) { return r._kind === 'atDesk'; });
    var notFound = rows.filter(function (r) { return r._kind === 'notFound'; });
    if (follow.length && want('followUp')) {
      d.h2('Needs follow-up (' + follow.length + ')');
      var groups = {}, order = [];
      follow.forEach(function (r) { var k = loc(r) + '|' + note(r); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(r); });
      order.forEach(function (k) {
        var g = groups[k], r = g[0], where = loc(r), n = note(r);
        if (g.length === 1) d.label(r.name + (where ? ' (' + where + ')' : '') + (n ? ': ' : ''), n);
        else d.label((where || 'Same note') + ' (' + g.length + ' people): ', (n ? n + ' ' : '') + 'People: ' + g.map(function (p) { return tidyName(p.name); }).join(', ') + '.');
      });
    }
    if (atDesk.length && want('atDesk')) {
      d.h2('Already at their new desk (' + atDesk.length + ')');
      personTable(d, atDesk, ['bldg', 'desk', 'curDesk', 'note']);
    }
    if (notFound.length && want('notFound')) {
      d.h2('Not found (' + notFound.length + ')');
      var byD = {}, keys = [];
      notFound.forEach(function (r) { var k = loc(r); if (!byD[k]) { byD[k] = []; keys.push(k); } byD[k].push(r); });
      keys.sort().forEach(function (k) {
        var g = byD[k];
        d.label((k || 'Not found') + ' (' + g.length + '): ', g.map(function (p) { return tidyName(p.name); }).join(', '));
      });
    }
  }

  // ── Walk summary ───────────────────────────────────────────────────────────
  function walkSummary(sheet, date, opts) {
    date = date || new Date();
    O = opts || {};
    try {
      var s = summarize(sheet), d = new Doc();
      header(d, sheet, 'Destination walk results', date);
      if (on('totals') || on('bydesk')) {
        d.h1('Equipment needed: ' + plural(s.needRows.length, 'desk', 'desks'));
        if (!s.needRows.length) d.para('No equipment needs were recorded on the walk.');
        else {
          if (on('totals')) d.table(['Item', 'Qty'], s.needCounts.map(function (c) { return [c.label, String(c.count)]; }), [80, 20]);
          if (on('bydesk')) { d.h2('Equipment by desk'); needTable(d, s.needRows); }
        }
      }
      var kinds = ['followUp', 'atDesk', 'notFound'].filter(on);
      if (kinds.length) {
        // Desks with a need already show their note in the equipment table.
        var noted = s.rows.filter(function (r) { return r._kind && !r.needs.length && kinds.indexOf(r._kind) >= 0; });
        d.h1('Notes');
        if (noted.length) notesSection(d, noted, kinds); else d.para('No notes were recorded on the walk.');
      }
      return d.toBytes(jobTitle(sheet) + ' - destination walk results - Jet City IT');
    } finally { O = {}; }
  }

  // Desks whose photos go in the completion report's photo section: everything
  // Jet City IT completed plus good-to-go desks that were re-checked after the
  // move. The page uses this list to know which photos to download.
  function photoDesks(sheet) {
    var s = summarize(sheet);
    return s.done.concat(s.good.filter(function (r) { return r.post || r.fix; }))
      .filter(function (r) { return r.preUrl || r.postUrl; });
  }

  // Pre/post photos side by side, a few desks per page. photos maps
  // "<row>:pre" / "<row>:post" to { bytes, w, h } (JPEG).
  function photoSection(d, desks, photos) {
    var gap = 14, boxW = (CONTENT_W - gap) / 2, boxH = 165; // three desks per page
    d.h1('Photos (' + plural(desks.length, 'desk', 'desks') + ')');
    d.para('Pre-move and post-move destination photos for the completed and re-checked desks.');
    desks.forEach(function (r) {
      d.room(boxH + 36);
      var need = r.needs.length ? ' - ' + r.needs.map(needLabel).join(' + ') : '';
      var where = loc(r);
      d.rich([{ text: r.name, bold: true }, { text: (where ? '  ' + where : '') + need }], { size: 10, after: 2 });
      var top = d.y;
      ['pre', 'post'].forEach(function (which, i) {
        var x = MARGIN_X + i * (boxW + gap);
        d.textAt(x, top - 10, which === 'pre' ? 'Pre-move' : 'Post-move', 8.5, true, GREY);
        d.ops.push('0.8 0.8 0.8 RG 0.5 w ' + x.toFixed(2) + ' ' + (top - 16 - boxH).toFixed(2) + ' ' + boxW.toFixed(2) + ' ' + boxH.toFixed(2) + ' re S');
        var img = photos[r.row + ':' + which];
        if (img) {
          var sc = Math.min((boxW - 8) / img.w, (boxH - 8) / img.h), w = img.w * sc, h = img.h * sc;
          d.drawImage(d.addImage(img), x + (boxW - w) / 2, top - 16 - boxH + (boxH - h) / 2, w, h);
        } else {
          d.textAt(x + boxW / 2 - 22, top - 16 - boxH / 2, 'No photo', 9, false, GREY);
        }
      });
      d.y = top - 16 - boxH - 14;
    });
  }

  // ── Completion report ──────────────────────────────────────────────────────
  // opts.photos (optional) maps photos for the Photos section; see photoSection.
  function completionReport(sheet, date, opts) {
    date = date || new Date();
    O = opts || {};
    try {
      var s = summarize(sheet), d = new Doc();
      var fixed = s.done.filter(function (r) { return r.needs.length; });
      var checked = s.done.filter(function (r) { return !r.needs.length; });
      var openNeeds = s.open.filter(function (r) { return r.needs.length; });
      var openNotes = s.open.filter(function (r) { return !r.needs.length; });
      var goodPost = s.good.filter(function (r) { return r.post || r.fix; });

      header(d, sheet, 'Completion report', date);
      d.para('A desk is good to go if it has a pre-move destination photo. Otherwise it is completed when it has a post-move photo and/or the JetCity Fix check.');
      if (on('summary')) {
        d.h1('Summary');
        d.table(['Status', 'Desks'], [
          ['Good to go (pre-move photo)', String(s.good.length)],
          ['Completed by Jet City IT', String(s.done.length)],
          ['Still open', String(s.open.length)],
          ['Nothing recorded', String(s.none.length)],
          ['Total', String(s.rows.length)],
        ], [80, 20], { boldLast: true });
        if (fixed.length) {
          d.label('Equipment installed: ', plural(fixed.length, 'desk', 'desks') + ' (' + needList(countNeeds(fixed)) + ').' +
            (openNeeds.length ? ' ' + plural(openNeeds.length, 'desk still needs', 'desks still need') + ' equipment.' : ' Every equipment need from the walk is done.'));
        }
      }

      if (on('completed')) {
        d.h1('Completed by Jet City IT (' + s.done.length + ')');
        if (fixed.length) { d.h2('Equipment installed (' + fixed.length + ')'); needTable(d, fixed); }
        if (checked.length) {
          d.h2('Checked after the move (' + checked.length + ')');
          personTable(d, checked, ['bldg', 'desk', 'curDesk', 'note'], { noteFn: function (r) {
            var n = note(r); if (n && !/[.!?]$/.test(n)) n += '.';
            return (n + (r.post ? ' Post-move photo taken.' : ' Marked fixed.')).trim();
          } });
        }
        if (!s.done.length) d.para('Nothing has been marked completed yet.');
      }

      if (on('good')) {
        d.h1('Good to go (' + s.good.length + ')');
        if (s.good.length) {
          d.para('These desks had a pre-move destination photo.' + (on('appendix') ? ' The full list is in the appendix.' : ''));
          var floors = {};
          s.good.forEach(function (r) { var k = shortBldg(r.bldg) + '|' + r.floor; floors[k] = (floors[k] || 0) + 1; });
          var floorRows = Object.keys(floors).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); })
            .map(function (k) { var p = k.split('|'); return [p[0], p[1], String(floors[k])]; });
          floorRows.push(['Total', '', String(s.good.length)]);
          d.table(['Building', 'Floor', 'Desks'], floorRows, [45, 25, 30], { boldLast: true });
        } else d.para('No pre-move destination photos yet.');
      }
      if (on('alsoChecked') && goodPost.length) {
        var h = 'Also checked after the move (' + goodPost.length + ')';
        if (on('good')) d.h2(h); else d.h1(h);
        personTable(d, goodPost, ['bldg', 'desk', 'curDesk', 'note']);
      }

      if (on('open')) {
        d.h1('Still open (' + s.open.length + ')');
        if (s.open.length) {
          d.para('These have a need or a note from the walk but no photo or fix yet.');
          if (openNeeds.length) { d.h2('Equipment still needed (' + openNeeds.length + ')'); needTable(d, openNeeds); }
          notesSection(d, openNotes.filter(function (r) { return r._kind; }));
        } else d.para('Nothing is open.');
      }

      if (on('none') && s.none.length) {
        d.h1('Nothing recorded (' + s.none.length + ')');
        d.para('No photo, need or note yet. These are often people with no destination desk.');
        personTable(d, s.none, ['bldg', 'floor', 'desk', 'curDesk']);
      }

      if (on('photos') && O.photos) {
        var desks = photoDesks(sheet);
        if (desks.length) { d.pageBreak(); photoSection(d, desks, O.photos); }
      }

      if (on('appendix') && s.good.length) {
        d.pageBreak();
        d.h1('Appendix: good-to-go desks (' + s.good.length + ')');
        personTable(d, s.good, ['bldg', 'floor', 'desk', 'curDesk']);
      }
      return d.toBytes(jobTitle(sheet) + ' - completion report - Jet City IT');
    } finally { O = {}; }
  }

  window.TMReport = {
    summarize: summarize, walkSummary: walkSummary, completionReport: completionReport, photoDesks: photoDesks, jobTitle: jobTitle,
    SECTIONS: SECTIONS, COLUMNS: COLUMNS, DEFAULT_COLUMNS: DEFAULT_COLUMNS,
  };
})();
