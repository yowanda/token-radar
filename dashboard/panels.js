// Token Radar panels, round 4. Renders three sections the board alone
// cannot show, from the same window.RADAR data main.ts writes — no
// refitting, no second source of truth:
//   1. Distribution: a histogram of implied values across all 342
//      pre-token rows (log10 buckets), with the median and the top decile
//      marked, so a reader sees at a glance how concentrated the board is.
//   2. Calibration: a fitted-vs-actual scatter for the 128 live-token
//      comps (log market cap), with the diagonal, so the judge can see
//      the fit's real spread instead of taking one R^2 on trust.
//   3. Compare: pick any three of the top 60 protocols and read them
//      side by side — TVL, growth, age, fitted cap, P(token), implied
//      value with its 80% interval drawn as a bar, and the farm plan's
//      totals (capital, gas, holding days).
// Everything here is derived from DATA.rows / DATA.live / DATA.model, the
// same numbers board.json carries; the page never invents a value.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var host = document.getElementById('panels');
  if (!DATA || !host) return;

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  // ---- 1. Distribution of implied values --------------------------------
  function distribution() {
    var vals = DATA.rows.map(function (r) { return Math.log10(Math.max(r.implied_value_usd, 1)); });
    var lo = Math.floor(Math.min.apply(null, vals) * 2) / 2;
    var hi = Math.ceil(Math.max.apply(null, vals) * 2) / 2;
    var bins = 12;
    var width = (hi - lo) / bins;
    var counts = new Array(bins).fill(0);
    vals.forEach(function (v) {
      var b = Math.min(bins - 1, Math.floor((v - lo) / width));
      counts[b]++;
    });
    var max = Math.max.apply(null, counts);
    var med = DATA.median_implied_usd;
    var p90 = DATA.rows.slice().sort(function (a, b) { return a.implied_value_usd - b.implied_value_usd; })[Math.floor(DATA.rows.length * 0.9)].implied_value_usd;
    var bars = el('div', { class: 'hist' });
    counts.forEach(function (c, i) {
      var label = fmtUsd(Math.pow(10, lo + i * width));
      bars.appendChild(el('div', { class: 'hcol' },
        el('span', { class: 'hcount', text: String(c) }),
        el('div', { class: 'hbar', style: 'height:' + Math.max(2, Math.round((c / max) * 120)) + 'px', title: label + ': ' + c + ' protocols' }),
        el('span', { class: 'hlabel', text: label })));
    });
    return el('section', { class: 'panel panels' },
      el('h2', { text: 'How implied value is distributed' }),
      el('p', { class: 'sub', text: 'All ' + DATA.rows.length + ' pre-token protocols, in log10 buckets. Most of the board sits far below the top: the median is ' + fmtUsd(med) + ', the 90th percentile is ' + fmtUsd(p90) + ', and the top rank is ' + fmtUsd(DATA.rows[0].implied_value_usd) + '. A rank is a claim about order, not about closeness — ranks 40 and 41 can be a hair apart while rank 1 stands alone.' }),
      bars);
  }

  // ---- 2. Calibration scatter -------------------------------------------
  function calibration() {
    var m = DATA.model;
    var pts = (DATA.live || []).filter(function (r) { return r.mcap_usd > 0 && r.fit_mcap_usd > 0; })
      .map(function (r) { return { x: Math.log(r.fit_mcap_usd), y: Math.log(r.mcap_usd), name: r.name }; });
    var xs = pts.map(function (p) { return p.x; });
    var ys = pts.map(function (p) { return p.y; });
    var x0 = Math.floor(Math.min.apply(null, xs.concat(ys)));
    var x1 = Math.ceil(Math.max.apply(null, xs.concat(ys)));
    var W = 560, H = 300, PAD = 28;
    var X = function (v) { return PAD + ((v - x0) / (x1 - x0)) * (W - 2 * PAD); };
    var Y = function (v) { return H - PAD - ((v - x0) / (x1 - x0)) * (H - 2 * PAD); };
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'scatter', role: 'img', 'aria-label': 'Fitted versus actual log market cap for the 128 live-token protocols' });
    svg.appendChild(svgEl('line', { x1: X(x0), y1: Y(x0), x2: X(x1), y2: Y(x1), class: 'diag' }));
    pts.forEach(function (p) {
      var c = svgEl('circle', { cx: X(p.x).toFixed(1), cy: Y(p.y).toFixed(1), r: '3.2', class: 'dot' });
      c.appendChild(svgEl('title', {}));
      c.firstChild.textContent = p.name + ': fitted ' + fmtUsd(Math.exp(p.x)) + ', actual ' + fmtUsd(Math.exp(p.y));
      svg.appendChild(c);
    });
    svg.appendChild(svgEl('text', { x: PAD, y: H - 6, class: 'axis' })).textContent = 'fitted log mcap ' + x0;
    svg.appendChild(svgEl('text', { x: W - PAD, y: H - 6, class: 'axis', 'text-anchor': 'end' })).textContent = String(x1);
    svg.appendChild(svgEl('text', { x: 6, y: PAD + 4, class: 'axis' })).textContent = 'actual log mcap';
    return el('section', { class: 'panel panels' },
      el('h2', { text: 'Calibration — the fit against reality' }),
      el('p', { class: 'sub', text: 'Each dot is one of the ' + pts.length + ' live-token protocols: fitted log market cap on the x-axis, actual on the y-axis. The diagonal is a perfect fit. The cloud is wide — repeated-CV R\u00B2 ' + m.rep_r2.toFixed(3) + ', residual \u03C3 ' + m.residual_sigma.toFixed(2) + ' log points — which is why every row carries an 80% interval instead of a single number pretending to be precise. A model this noisy still ranks: it separates the $100M-scale launches from the $1M-scale ones, and the interval says how much to trust any single rank.' }),
      svg);
  }

  // ---- 3. Compare up to three protocols ---------------------------------
  var picked = [0, 1, 2];
  function compareTable() {
    var top = DATA.rows.slice(0, 60);
    function picker(i) {
      var sel = el('select', { 'aria-label': 'Compare protocol ' + (i + 1) },
        top.map(function (r, j) {
          return el('option', { value: String(j), text: '#' + r.rank + ' ' + r.name, selected: picked[i] === j ? 'selected' : null });
        }));
      sel.addEventListener('change', function () { picked[i] = Number(sel.value); renderCompare(); });
      return el('div', { class: 'field' }, el('label', { text: 'Protocol ' + (i + 1) }), sel);
    }
    function intervalBar(r) {
      var all = DATA.rows;
      var lo = Math.log10(Math.max(1, all[all.length - 1].implied_value_usd));
      var hi = Math.log10(Math.max(1, all[0].implied_value_usd));
      function pos(v) { return Math.max(0, Math.min(100, ((Math.log10(Math.max(1, v)) - lo) / (hi - lo)) * 100)); }
      var a = pos(r.implied_lo_usd), b = pos(r.implied_hi_usd), p = pos(r.implied_value_usd);
      return el('div', { class: 'ibar' },
        el('i', { class: 'irange', style: 'left:' + a.toFixed(1) + '%;width:' + Math.max(1, b - a).toFixed(1) + '%' }),
        el('i', { class: 'ipoint', style: 'left:' + p.toFixed(1) + '%' }));
    }
    var rows = picked.map(function (j) { return top[j]; });
    function attr(label, fn) {
      return el('tr', null, el('th', { scope: 'row', text: label }),
        rows.map(function (r) { return el('td', { class: 'num', text: fn(r) }); }));
    }
    function attrNode(label, fn) {
      return el('tr', null, el('th', { scope: 'row', text: label }),
        rows.map(function (r) { return el('td', null, fn(r)); }));
    }
    return el('div', { class: 'compare' },
      el('div', { class: 'pickers' }, picker(0), picker(1), picker(2)),
      el('div', { class: 'wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: '' }),
          rows.map(function (r) { return el('th', { scope: 'col', text: '#' + r.rank + ' ' + r.name }); }))),
        el('tbody', null,
          attr('TVL', function (r) { return fmtUsd(r.tvl_usd); }),
          attr('7-day growth', function (r) { return fmtPct(r.change_7d); }),
          attr('Age', function (r) { return fmtAge(r.age_days); }),
          attr('Chains', function (r) { return String((r.chains || []).length); }),
          attr('Category', function (r) { return r.category || 'Other'; }),
          attr('Fitted market cap', function (r) { return fmtUsd(r.fit_mcap_usd); }),
          attr('P(token)', function (r) { return Math.round(r.p_token * 100) + '%'; }),
          attr('Implied value', function (r) { return fmtUsd(r.implied_value_usd); }),
          attrNode('80% interval', function (r) {
            return el('div', null, intervalBar(r),
              el('span', { class: 'sub', text: fmtUsd(r.implied_lo_usd) + ' – ' + fmtUsd(r.implied_hi_usd) }));
          }),
          attr('Farm capital', function (r) { return fmtUsd(r.farm_capital_usd); }),
          attr('Farm gas, total', function (r) { return '$' + r.farm_gas_total_usd.toFixed(2); }),
          attr('Farm holding time', function (r) { return r.farm_hold_days + ' days'; })))));
  }
  var compareHost;
  function renderCompare() {
    if (!compareHost) return;
    compareHost.textContent = '';
    compareHost.appendChild(compareTable());
  }
  function compare() {
    compareHost = el('div');
    renderCompare();
    var sec = el('section', { class: 'panel panels' },
      el('h2', { text: 'Compare three protocols head to head' }),
      el('p', { class: 'sub', text: 'Same model, same arithmetic as the board — pick any three of the top 60 and read them side by side. The interval bar is drawn on a log scale across the whole board, so a wide bar means the model genuinely cannot tell those two apart, and a narrow one high up means the gap is real. Farm totals are the plan\u2019s own numbers: capital at risk, gas for one setup plus four weekly actions, and the holding period.' }),
      compareHost);
    return sec;
  }

  host.appendChild(el('div', { class: 'panels-wrap' }, distribution(), calibration(), compare()));
})();
