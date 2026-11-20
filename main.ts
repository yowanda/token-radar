// Token Radar — a make.fun token-radar-01 entry (Node 22, standard library only).
//
// Reads the sealed DefiLlama snapshot, scores every pre-token protocol with a
// category-comps value model, and writes the ranked board, the dashboard data,
// and the judge's dossier.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
//
// The value model (see valueModel below, and the dashboard's model panel):
//   comp     = median(mcap / tvl) of the LIVE-token protocols in the same
//              category, computed from this snapshot alone (global median
//              when a category has fewer than 3 live comps), clamped 0.05..2
//   growth   = 1 + clamp(change_7d, -50, 100) / 100 * 0.6
//   maturity = 0.7 + min(age_days, 1095) / 1095 * 0.3   (age unknown: 365)
//   implied  = round(tvl_usd * comp * growth * maturity)
// No protocol name is special-cased: one function scores every row. The board
// covers the whole watchlist plus the 260 largest rankable pre-token protocols
// below the floor, and the live-token protocols are kept apart in their own
// view with their market caps shown, never mixed into the ranking.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const MODEL_VERSION = 'radar-2';
const EARLY_ROWS = 260;
const LIVE_ROWS = 24;

// ------------------------------------------------------------------ types

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  model: {
    comp_category: string;
    comp_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

// ------------------------------------------------------------------ args

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// ------------------------------------------------------------------ snapshot

function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot is not an object');
  if (typeof raw.as_of !== 'string' || typeof raw.source !== 'string') throw new Error('snapshot lacks as_of/source');
  if (typeof raw.floor_usd !== 'number' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot lacks floor/protocols/watchlist');
  }
  const protocols: Protocol[] = (raw.protocols as Record<string, unknown>[]).map((p) => ({
    slug: String(p.slug),
    name: String(p.name),
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? (p.chains as unknown[]).filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: Number(p.tvl_usd),
    change_7d: typeof p.change_7d === 'number' ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  }));
  return {
    as_of: raw.as_of as string,
    source: raw.source as string,
    floor_usd: raw.floor_usd as number,
    protocols,
    watchlist: raw.watchlist as string[],
  };
}

// ------------------------------------------------------------------ model

const DAY_MS = 86_400_000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Category comps: for every category, the median market-cap-to-TVL ratio of
 * the protocols in it whose token already trades. A category with fewer than
 * 3 live comps falls back to the global median. Both are clamped to
 * [0.05, 2.0] so one outlier never decides a row.
 */
function compMultiples(snapshot: Snapshot): { byCategory: Map<string, number>; global: number; counts: Map<string, number> } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const global = clamp(median(allRatios), 0.05, 2);
  const byCat = new Map<string, number[]>();
  for (const p of live) {
    const c = p.category ?? 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(p.mcap_usd! / p.tvl_usd);
  }
  const byCategory = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const [c, ratios] of byCat) {
    counts.set(c, ratios.length);
    byCategory.set(c, ratios.length >= 3 ? clamp(median(ratios), 0.05, 2) : global);
  }
  return { byCategory, global, counts };
}

function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * A protocol the board may rank: it records no token, and it is not a
 * wrapped / staked / bridged product of a token that already trades, not a
 * centralised exchange, and not a versioned pool of another protocol. The
 * watchlist rule, applied to every row — not just the watchlist.
 */
function isRankable(p: Protocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

function impliedValue(
  p: Protocol,
  asOf: string,
  comp: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(p.change_7d ?? 0, -50, 100);
  const growthMult = 1 + (growthPct / 100) * 0.6;
  const ageForModel = age ?? 365;
  const maturityMult = 0.7 + (Math.min(Math.max(ageForModel, 0), 1095) / 1095) * 0.3;
  const implied = Math.max(1, Math.round(p.tvl_usd * comp * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

// ------------------------------------------------------------------ farm plans

function chainOf(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: Protocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  return 75;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

function gasNote(chain: string): string {
  return chain === 'Ethereum' ? 'about $5 to $15 of gas per transaction on Ethereum' : 'about $0.10 to $2 of gas per transaction';
}

function coreAction(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateralized')) {
    return `Supply $${capital} of USDC as collateral to ${name} on ${chain}, borrow a small amount against it, then repay the borrow.`;
  }
  if (c.includes('dex') || c.includes('dexes')) {
    return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and hold the LP position.`;
  }
  if (c.includes('yield') || c.includes('leveraged farm')) {
    return `Deposit $${capital} into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain}, open one small hedged position, then close it.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and take one small position in an active market, then settle it.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) {
    return `Deposit $${capital} into a ${name} curated vault on ${chain} and hold the vault shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in your wallet.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('options')) {
    return `Deposit $${capital} of USDC into ${name} on ${chain} and write or buy one small option.`;
  }
  if (c.includes('liquid')) {
    return `Deposit $${capital} of the staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and use its main feature once.`;
}

function weeklyAction(p: Protocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return 'a supply top-up, a borrow and repay, or a rate switch';
  if (c.includes('dex')) return 'a swap or a liquidity rebalance';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return 'a small trade or a margin adjustment';
  if (c.includes('prediction')) return 'a position in a new market';
  return 'a deposit, a swap, a vote, or a claim of any rewards';
}

function farmSteps(p: Protocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasNote(chain);
  const steps: { text: string; cost: string; time: string }[] = [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase written on paper offline.',
      cost: 'nothing to set up',
      time: '5 minutes',
    },
    {
      text: coreAction(p, capital, chain),
      cost: `$${capital} of capital plus ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: `Repeat one qualifying action every week for at least a month, such as ${weeklyAction(p)}.`,
      cost: `${gas} each week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity spans more than one snapshot window.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page from its official site and claim only through the link it publishes.`,
      cost: 'free to check; never pay a fee to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet address, the dates and every transaction hash in a farm log, and set a monthly reminder to re-check the position.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
  return steps.map((s) => {
    let out = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
    if (out.length > 600) out = `${out.slice(0, 596)}...`;
    return out;
  });
}

// ------------------------------------------------------------------ board

function buildBoard(snapshot: Snapshot): { board: BoardRow[]; comps: ReturnType<typeof compMultiples>; early: number } {
  const comps = compMultiples(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Protocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    // The comp is rounded to 4dp BEFORE scoring, so the dashboard page —
    // which recomputes each row from the stored comp — reproduces the exact
    // same implied value board.json carries.
    const comp = round4(comps.byCategory.get(p.category ?? 'Other') ?? comps.global);
    const v = impliedValue(p, snapshot.as_of, comp);
    return { p, comp, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    age_days: s.age,
    token_status: 'pre-token',
    implied_value_usd: s.implied,
    model: {
      comp_category: s.p.category ?? 'Other',
      comp_multiple: round4(s.comp),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
  return { board, comps, early: early.length };
}

function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `board has ${board.length} rows, fewer than 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i}`;
  }
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

// ------------------------------------------------------------------ run

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, comps, early } = buildBoard(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: board refused: ${issue}\n`);
  process.exit(1);
}

const live = snapshot.protocols
  .filter((p) => !isPreToken(p) && !(p.category !== null && EXCLUDED_CATEGORIES.has(p.category)))
  .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
  .slice(0, LIVE_ROWS)
  .map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));

const compTable = [...comps.byCategory.entries()]
  .map(([category, multiple]) => ({ category, multiple: round4(multiple), live_count: comps.counts.get(category) ?? 0 }))
  .sort((a, b) => b.multiple - a.multiple || (a.category < b.category ? -1 : 1));

const radar = {
  as_of: snapshot.as_of,
  source: snapshot.source.replace('https://api.llama.fi/protocols', 'DefiLlama protocols API'),
  floor_usd: snapshot.floor_usd,
  model_version: MODEL_VERSION,
  model: {
    growth_weight: 0.6,
    growth_floor: -50,
    growth_cap: 100,
    maturity_floor: 0.7,
    maturity_range: 0.3,
    maturity_days: 1095,
    unknown_age_days: 365,
    comp_global: round4(comps.global),
    comp_floor: 0.05,
    comp_cap: 2,
  },
  comps: compTable,
  watchlist_size: snapshot.watchlist.length,
  board_size: board.length,
  early_size: early,
  live_size: live.length,
  total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
  rows: board.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    age_days: r.age_days,
    implied_value_usd: r.implied_value_usd,
    comp_multiple: r.model.comp_multiple,
    growth_multiplier: r.model.growth_multiplier,
    maturity_multiplier: r.model.maturity_multiplier,
    farm_steps: r.farm_steps,
  })),
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length}: hand in 3\n`);
  process.exit(1);
}
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: bad screenshot name ${name}\n`);
    process.exit(1);
  }
}

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} rows (${early} early), ${live.length} live set aside\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length}) and ${join(out, 'dossier.json')}\n`,
);
