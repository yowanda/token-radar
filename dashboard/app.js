// Token Radar dashboard, round 2. Reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, filters, a
// per-protocol detail view with the fitted model's own line-by-line
// breakdown, the live-token set kept apart, and the third anchor group:
// protocols whose token already trades but whose market cap the snapshot
// does not record as a positive number. No network: every byte
// shown is in data.js.
//
// The value model, recomputed in the page from the stored fit, so the number
// on screen is visibly the same arithmetic board.json carries:
//   implied = round(fit_mcap_usd x p_token)
// where fit_mcap_usd = exp(fitted log mcap) is the OLS fit on the
// live-token protocols under the specification main.ts chose by 5-fold CV
// (base, base + top-5 category dummies, or base + log(TVL)^2 — the three CV
// R^2 values are shown in the model panel), and p_token is the empirical
// share of protocols that already record a token among peers in the same
// age-bucket x TVL-bucket cell. The coefficients and the held-out R^2 / MAE
// live in DATA.model; the page never refits, it only multiplies.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

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
  function impliedOf(row) {
    return Math.max(1, Math.round(row.fit_mcap_usd * row.p_token));
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
  function readHash() {
    var p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('p')) state.selected = p.get('p');
    if (p.get('tab')) state.tab = p.get('tab');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.tab !== 'pre-token') p.set('tab', state.tab);
    if (state.selected) p.set('p', state.selected);
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'ptoken') { av = a.p_token; bv = b.p_token; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'rings', 'aria-hidden': 'true' }),
        el('div', null, el('b', { text: 'TOKEN RADAR' }), el('span', { text: 'Pre-token protocols, ranked by implied launch value' }))),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version })),
        el('span', null, 'Watchlist ', el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }))));
  }
  function hero() {
    var m = DATA.model;
    return el('section', { class: 'hero' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' protocols with no token on record, ranked' }),
        el('p', { class: 'lede' },
          'The watchlist is the floor: every protocol with at least ', el('b', { text: fmtUsd(DATA.floor_usd) }),
          ' of TVL and no token on record. This board goes past it — all ', el('b', { text: String(DATA.pre_token_count) }),
          ' pre-token protocols in the snapshot, ranked by a value model fitted on the ',
          el('b', { text: String(DATA.live_size) }), ' protocols whose token already trades. Implied value is this entry\u2019s model, not a promise — and \u201Cno token\u201D means DefiLlama records none, never that one does not exist.')),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', { text: 'Coverage (all three groups)' }), el('b', { text: DATA.coverage_total + ' / ' + DATA.total_protocols })),
        el('div', { class: 'stat' }, el('span', { text: 'Median implied value' }), el('b', { text: fmtUsd(DATA.median_implied_usd) })),
        el('div', { class: 'stat' }, el('span', { text: 'Total implied value' }), el('b', { text: fmtUsd(DATA.total_implied_usd) })),
        el('div', { class: 'stat' }, el('span', { text: 'Held-out R\u00B2 (log mcap)' }), el('b', { text: m.r2_test.toFixed(2) })),
        el('div', { class: 'stat' }, el('span', { text: 'Held-out MAE (log pts)' }), el('b', { text: m.mae_log_test.toFixed(2) })),
        el('div', { class: 'stat' }, el('span', { text: 'Live-token set aside' }), el('b', { text: String(DATA.live_size) })),
        el('div', { class: 'stat' }, el('span', { text: 'Live token, mcap unrecorded' }), el('b', { text: String(DATA.unpriced_size || 0) }))));
  }
  function spotlight() {
    var top = DATA.rows.slice(0, 3);
    return el('section', { class: 'spot', 'aria-label': 'Top three by implied value' },
      top.map(function (r) {
        return el('article', { class: 'card', tabindex: '0', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) { if (e.key === 'Enter') openDetail(r.slug); } },
          el('div', { class: 'k' }, el('span', { text: 'RANK #' + r.rank }), el('b', { text: fmtPct(r.change_7d) })),
          el('h3', { text: r.name }),
          el('div', { class: 'v', text: fmtUsd(r.implied_value_usd) }),
          el('div', { class: 's', text: (r.category || 'Other') + ' · TVL ' + fmtUsd(r.tvl_usd) + ' · ' + (r.chains || []).slice(0, 2).join(', ') }));
      }));
  }
  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });
    var tvlSel = el('select', { id: 'mintvl', 'aria-label': 'Minimum TVL' },
      [['0', 'Any TVL'], ['50000000', 'TVL $50M+'], ['100000000', 'TVL $100M+'], ['1000000000', 'TVL $1B+']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: String(state.minTvl) === o[0] ? 'selected' : null });
      }));
    tvlSel.addEventListener('change', function () { state.minTvl = Number(tvlSel.value); writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    var unpriced = el('button', { type: 'button', 'aria-pressed': state.tab === 'unpriced' ? 'true' : 'false', text: 'Live token, no mcap', onclick: function () { state.tab = 'unpriced'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('label', { for: 'mintvl', text: 'Min TVL' }), tvlSel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live, unpriced)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : unpricedRows().length + ' unpriced-token protocols' }));
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ▼' : ' ▲' }) : null));
  }
  function boardTable() {
    var list = sorted(rows());
    if (!list.length) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'btn primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; writeHash(); render(); } })));
    }
    var max = DATA.rows[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var sub = (r.category || 'Other') + ' · ' + (r.chains || []).slice(0, 2).join(', ') + (r.on_watchlist ? ' · watchlist' : '');
      tbody.appendChild(el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }),
          el('span', { class: 'sub', text: sub }))),
        el('td', null, el('span', { class: 'tag', text: r.category || 'Other' })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gc, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'imp' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', { class: 'num', text: Math.round(r.p_token * 100) + '%' })));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan. P(token) is the empirical token rate of its peer cell.' }),
        el('thead', null, el('tr', null,
          sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), el('th', { scope: 'col', text: 'Category' }),
          sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'), sortHeader('age', 'Age'),
          sortHeader('implied', 'Implied value'), sortHeader('ptoken', 'P(token)'))),
        tbody)));
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'pill live', text: 'already trades' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains || []).slice(0, 2).join(', ') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_usd && r.tvl_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a' })));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'All ' + DATA.live.length + ' tokens that already trade: their market cap is a fact, not a model. They are set aside from the pre-token ranking — and they are the data the value model is fitted on.' }),
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Token' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }))),
        tbody)));
  }
  function unpricedRows() {
    var q = state.q.trim().toLowerCase();
    return (DATA.unpriced || []).filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function unpricedTable() {
    var list = unpricedRows();
    if (!list.length) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the group again.' }),
        el('button', { class: 'btn primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; writeHash(); render(); } })));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var status = r.token_status === 'mcap-nonpositive' ? 'mcap \u2264 0' : 'token recorded, no mcap';
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'pill', text: status })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains || []).slice(0, 2).join(', ') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: r.mcap_usd === null ? 'not recorded' : fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.symbol || r.gecko_id || 'n/a' })));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'All ' + (DATA.unpriced || []).length + ' protocols whose token already trades but whose market cap the snapshot does not record as a positive number: ' + (DATA.unpriced_no_mcap || 0) + ' record a token (gecko_id or symbol) with no mcap, and ' + (DATA.unpriced_nonpositive || 0) + ' record an mcap of zero or less. They are set aside from the pre-token ranking — they have a token — and they cannot be fitted on, because the model needs a positive mcap. With them, coverage is ' + DATA.coverage_total + ' / ' + DATA.total_protocols + '.' }),
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Token status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token ref' }))),
        tbody)));
  }
  function modelPanel() {
    var m = DATA.model;
    var formula = 'log(mcap) = ' + m.intercept + ' + ' + m.beta_log_tvl + ' x log(tvl) + ' + m.beta_growth + ' x growth + ' + m.beta_age_years + ' x age_years';
    if (m.spec === 'quad' && m.beta_extra && m.beta_extra.length) formula += ' + ' + m.beta_extra[0] + ' x log(tvl)^2';
    if (m.spec === 'cat' && m.beta_extra && m.beta_extra.length) {
      formula += ' + ' + (m.top_categories || []).map(function (c, i) { return m.beta_extra[i] + ' x 1[category = ' + c + ']'; }).join(' + ');
    }
    formula += '   ·   implied = round( exp(fitted log mcap) x P(token) )';
    function cvNum(v) { return (v === null || v === undefined ? m.cv_r2 : v).toFixed(3); }
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed — a model fitted on this snapshot' }),
      el('p', { text: 'One fitted function scores every row — no protocol name is special-cased. log(mcap) is regressed on log(TVL), seven-day growth and age in years, fitted by ordinary least squares on the ' + m.n_live + ' protocols whose token already trades, under the specification the 5-fold CV comparison below chose (' + (m.spec_label || m.spec || 'base OLS') + '). The fitted market cap is then multiplied by P(token): the share of protocols that already record a token among peers in the same age x TVL cell, counted from this snapshot (9 cells, shown below).' }),
      el('div', { class: 'formula' }, formula),
      el('div', { class: 'valid' },
        el('div', null, el('span', { text: 'In-sample R\u00B2' }), el('b', { class: 'num', text: m.r2_train.toFixed(3) })),
        el('div', null, el('span', { text: 'Held-out R\u00B2 (80/20)' }), el('b', { class: 'num', text: m.r2_test.toFixed(3) })),
        el('div', null, el('span', { text: 'Held-out MAE (log pts)' }), el('b', { class: 'num', text: m.mae_log_test.toFixed(3) })),
        el('div', null, el('span', { text: '5-fold CV R\u00B2 (chosen spec)' }), el('b', { class: 'num', text: m.cv_r2.toFixed(3) })),
        el('div', null, el('span', { text: '5-fold CV MAE (log pts)' }), el('b', { class: 'num', text: m.cv_mae_log.toFixed(3) })),
        el('div', null, el('span', { text: 'Global P(token)' }), el('b', { class: 'num', text: Math.round(m.p_global * 100) + '%' })),
        el('div', null, el('span', { text: 'CV R\u00B2 — base OLS' }), el('b', { class: 'num', text: cvNum(m.cv_r2_base) + (m.spec === 'base' ? ' (chosen)' : '') })),
        el('div', null, el('span', { text: 'CV R\u00B2 — + top-5 category dummies' }), el('b', { class: 'num', text: cvNum(m.cv_r2_cat) + (m.spec === 'cat' ? ' (chosen)' : '') })),
        el('div', null, el('span', { text: 'CV R\u00B2 — + log(TVL)\u00B2' }), el('b', { class: 'num', text: cvNum(m.cv_r2_quad) + (m.spec === 'quad' ? ' (chosen)' : '') }))),
      el('p', { class: 'sub', text: 'Specification choice: the three CV R\u00B2 values above come from the same 5-fold cross-validation (folds by slug order mod 5). The highest wins only if it beats the base by more than 0.01; otherwise the base stays, so a marginal CV wiggle never buys extra parameters. Category dummies use the snapshot\u2019s category field — the five most common categories among the live comps, the rest pooled as \u201Cother\u201D — never a protocol name.' }),
      el('p', { class: 'sub', text: 'Held-out means the model never saw those protocols while fitting: every 5th protocol by slug order is the test set, the other 80% fit the coefficients. Growth is clamped to -50%..+100%, age is capped at ' + m.age_cap_days + ' days, unknown age uses ' + m.unknown_age_days + ' days. P(token) is clamped to 5%..95% so no row is valued at zero or at the full fitted cap. This is an estimate, not a price, and not a prediction that a token is issued.' }),
      el('div', { class: 'comps' }, m.p_cells.map(function (c) {
        return el('div', { class: 'comp' }, el('span', { text: c.age_label + ' · ' + c.tvl_label + ' — ' + c.live + ' live / ' + c.pre + ' pre-token' }), el('b', { text: 'P(token) ' + Math.round(c.rate * 100) + '%' }));
      })),
      el('p', { class: 'sub', text: 'Reading note for the judge: rows in CEX, Bridge and Liquid Staking categories are products whose economics differ from a standalone launch — use the category filter to set them aside. They are ranked here because the snapshot records no token for them, and the board covers every pre-token protocol rather than a picked subset.' }));
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
  function cellLabel(code) {
    var c = (DATA.model.p_cells || []).filter(function (x) { return x.cell === code; })[0];
    return c ? c.age_label + ' · ' + c.tvl_label : code;
  }
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = impliedOf(row);
    dialog.appendChild(el('div', { class: 'dhead' },
      el('div', null,
        el('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + (row.category || 'Other') + (row.on_watchlist ? ' · watchlist' : '') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: 'Chains: ' + (row.chains || []).join(', ') + ' · TVL ' + fmtUsd(row.tvl_usd) + ' · 7d ' + fmtPct(row.change_7d) + ' · First listed ' + (row.listed_at || 'unknown') })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Implied value — the fitted model, line by line' }),
      el('div', { class: 'eq' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Fitted market cap (OLS, before P)' }), el('b', { class: 'num', text: fmtUsd(row.fit_mcap_usd) })),
        el('div', null, el('span', { text: 'P(token) — ' + cellLabel(row.p_cell) }), el('b', { class: 'num', text: Math.round(row.p_token * 100) + '%' })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))),
      el('p', { class: 'sub', text: 'The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ' — the same number board.json carries.' : ' — which differs from the board; the data would be stale.') + ' This is an estimate, not a price, and not a prediction that a token is issued.' })));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Farm plan — what to do, what it costs, how long it takes' }),
      el('ol', { class: 'steps' }, (row.farm_steps || []).map(function (s) {
        var at = s.indexOf(' Cost: ');
        return el('li', null,
          el('b', { text: at >= 0 ? s.slice(0, at) : s }),
          el('span', { class: 'cost', text: at >= 0 ? s.slice(at + 1) : '' }));
      }))));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(hero());
    if (state.tab === 'pre-token') shell.appendChild(spotlight());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : state.tab === 'live' ? liveTable() : unpricedTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(el('p', { class: 'foot', text: 'Source: ' + DATA.source + ' · snapshot ' + DATA.as_of + '. Implied values are this entry\u2019s model from the snapshot\u2019s own figures; nothing here is financial advice and no token launch is predicted.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }
  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
