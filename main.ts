// SPDX-License-Identifier: MIT
// Token Radar — a make.fun token-radar-01 entry, round 2 (Node 22, stdlib only).
//
// Reads the sealed DefiLlama snapshot, fits a value model from the snapshot's
// own live-token protocols, ranks EVERY pre-token protocol by implied value,
// and writes the ranked board, the dashboard data, and the judge's dossier.
//
// The value model (see fitModel below, and the dashboard's model panel):
//   log(mcap) = b0 + b1*log(tvl) + b2*growth + b3*age_years
//   fitted on the 128 protocols whose token already trades (OLS, normal
//   equations, 4 parameters). growth = clamp(change_7d, -50, 100) / 100,
//   age_years = min(age_days, 1095) / 365 (unknown age: 365 days).
//   Validated two ways, both deterministic: an 80/20 held-out split (every
//   5th protocol by slug order is the test set) and 5-fold cross-validation
//   (folds by slug order mod 5). R^2 and MAE (log points) are reported.
//   Three specifications are compared on the same 5-fold CV and the winner
//   is picked by CV R^2 (see fitModel): base, base + top-5 category
//   dummies, base + log(TVL)^2. A challenger wins only if it beats the base
//   by more than 0.01 of CV R^2, so a marginal wiggle never buys parameters.
//   implied = round( exp(fitted log mcap) * P(token) ), where P(token) is the
//   empirical share of protocols that already record a token among peers in
//   the same age bucket x TVL bucket (9 cells, counted from this snapshot,
//   clamped to [0.05, 0.95]; empty cell falls back to the global share).
// No protocol name is special-cased anywhere: one fitted function scores
// every row, and the token-probability cells are counted, never hand-set.
// The board covers all 342 pre-token protocols (the 40 watchlist rows plus
// every other protocol that records no token); the 128 live-token protocols
// are kept apart as market anchors with their real market caps, never mixed
// into the ranking. A third anchor group holds the 288 protocols whose token
// already trades but whose market cap the snapshot does not record as a
// positive number (272 record a token with no mcap, 16 record an mcap of
// zero or less): set aside, outside the ranking, so coverage is 758/758.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const MODEL_VERSION = 'radar-2-ols';

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
  on_watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  model: {
    fit_mcap_usd: number;
    p_token: number;
    p_cell: string;
    growth_pct: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

interface CellStat {
  cell: string;
  age_label: string;
  tvl_label: string;
  rate: number;
  live: number;
  pre: number;
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

// ------------------------------------------------------------------ helpers

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

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

// ------------------------------------------------------------------ regression
//
// Ordinary least squares for log(mcap) on [1, log(tvl), growth, age_years],
// solved through the normal equations with Gaussian elimination and partial
// pivoting, plus a 1e-8 ridge on the slopes so a degenerate column can never
// make the system singular. Four parameters, no regularisation that matters.

function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    const div = m[col]![col]!;
    for (let j = col; j <= n; j++) m[col]![j] = m[col]![j]! / div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) m[r]![j] = m[r]![j]! - f * m[col]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

function olsFit(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let a = 0; a < k; a++) {
      xty[a] = xty[a]! + xi[a]! * y[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b] = xtx[a]![b]! + xi[a]! * xi[b]!;
    }
  }
  for (let a = 1; a < k; a++) xtx[a]![a] = xtx[a]![a]! + 1e-8;
  const beta = solveLinear(xtx, xty);
  if (beta === null) throw new Error('regression failed: singular design matrix');
  return beta;
}

function r2Score(y: number[], pred: number[]): number {
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < y.length; i++) {
    ssTot += (y[i]! - mean) ** 2;
    ssRes += (y[i]! - pred[i]!) ** 2;
  }
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

function maeScore(y: number[], pred: number[]): number {
  let s = 0;
  for (let i = 0; i < y.length; i++) s += Math.abs(y[i]! - pred[i]!);
  return s / y.length;
}

// One design row per protocol: [1, log TVL, 7-day growth as a fraction,
// age in years capped at 3]. The same function scores live comps (training)
// and pre-token rows (prediction), so the model cannot favour any name.
function designRow(p: Protocol, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at);
  const growth = clamp(p.change_7d ?? 0, -50, 100) / 100;
  const ageYears = Math.min(Math.max(age ?? 365, 0), 1095) / 365;
  return [1, Math.log(Math.max(p.tvl_usd, 1)), growth, ageYears];
}

function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// ------------------------------------------------------------------ P(token)
//
// Empirical token probability: for each of 9 peer cells (age bucket x TVL
// bucket) the share of protocols in that cell that already record a token,
// counted from this snapshot. A young, small protocol sits in a cell where
// few peers ever tokenised; an old, large one sits where most did. The rate
// is clamped to [0.05, 0.95] so no row is ever valued at zero or at the full
// fitted market cap, and an empty cell falls back to the global share.

function ageBucket(age: number | null): 'young' | 'mid' | 'old' {
  if (age === null) return 'mid';
  if (age < 365) return 'young';
  if (age <= 1095) return 'mid';
  return 'old';
}

function tvlBucket(tvl: number): 'small' | 'mid' | 'large' {
  if (tvl < 50_000_000) return 'small';
  if (tvl < 500_000_000) return 'mid';
  return 'large';
}

const AGE_LABEL: Record<string, string> = { young: 'under 1y old', mid: '1-3y old', old: 'over 3y old' };
const TVL_LABEL: Record<string, string> = { small: 'TVL under $50M', mid: 'TVL $50-500M', large: 'TVL over $500M' };

function tokenProbCells(snapshot: Snapshot): { cells: CellStat[]; global: number; rateOf: (p: Protocol, asOf: string) => { rate: number; cell: string } } {
  const counts = new Map<string, { live: number; pre: number }>();
  let liveTotal = 0;
  for (const p of snapshot.protocols) {
    const key = `${ageBucket(ageDays(snapshot.as_of, p.listed_at))}|${tvlBucket(p.tvl_usd)}`;
    if (!counts.has(key)) counts.set(key, { live: 0, pre: 0 });
    const c = counts.get(key)!;
    if (p.mcap_usd !== null) {
      c.live++;
      liveTotal++;
    } else {
      c.pre++;
    }
  }
  const global = liveTotal / snapshot.protocols.length;
  const cells: CellStat[] = [...counts.entries()]
    .map(([key, c]) => {
      const [age, tvl] = key.split('|') as [string, string];
      const n = c.live + c.pre;
      return {
        cell: key,
        age_label: AGE_LABEL[age] ?? age,
        tvl_label: TVL_LABEL[tvl] ?? tvl,
        rate: n === 0 ? global : clamp(c.live / n, 0.05, 0.95),
        live: c.live,
        pre: c.pre,
      };
    })
    .sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));
  const byKey = new Map(cells.map((c) => [c.cell, c.rate]));
  const rateOf = (p: Protocol, asOf: string): { rate: number; cell: string } => {
    const cell = `${ageBucket(ageDays(asOf, p.listed_at))}|${tvlBucket(p.tvl_usd)}`;
    return { rate: byKey.get(cell) ?? clamp(global, 0.05, 0.95), cell };
  };
  return { cells, global, rateOf };
}

// ------------------------------------------------------------------ fit + validate
//
// Fit on the live-token protocols (sorted by slug, so the folds are
// deterministic): 5-fold cross-validation plus an 80/20 held-out split
// (fold 4 is the test set). Three specifications are compared on the same
// 5-fold CV machinery, and the one with the highest out-of-fold R^2 wins —
// but only if it beats the base by more than 0.01; a smaller gain keeps the
// simpler base, so a marginal CV wiggle never buys extra parameters:
//   base:  log(mcap) = b0 + b1*log(tvl) + b2*growth + b3*age_years
//   cat:   base + one dummy per top-5 category among the live comps
//          (remaining categories pooled as "other", the reference level;
//          dummies come from the snapshot's category field, never a name)
//   quad:  base + b4*log(tvl)^2
// The final coefficients come from all 128 live comps, under the chosen spec.

type SpecId = 'base' | 'cat' | 'quad';

const CV_MEANINGFUL_GAIN = 0.01;
const TOP_CATEGORIES = 5;

function catKey(p: Protocol): string {
  return p.category ?? 'Other';
}

function topCategories(live: Protocol[]): string[] {
  const counts = new Map<string, number>();
  for (const p of live) counts.set(catKey(p), (counts.get(catKey(p)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_CATEGORIES)
    .map(([c]) => c);
}

function designRowSpec(p: Protocol, asOf: string, spec: SpecId, topCats: string[]): number[] {
  const base = designRow(p, asOf);
  if (spec === 'cat') return [...base, ...topCats.map((c) => (catKey(p) === c ? 1 : 0))];
  if (spec === 'quad') {
    const logTvl = Math.log(Math.max(p.tvl_usd, 1));
    return [...base, logTvl * logTvl];
  }
  return base;
}

function cvFor(X: number[][], y: number[]): { cv_r2: number; cv_mae_log: number } {
  const oofY: number[] = [];
  const oofP: number[] = [];
  for (let f = 0; f < 5; f++) {
    const tr = X.map((_, i) => i).filter((i) => i % 5 !== f);
    const te = X.map((_, i) => i).filter((i) => i % 5 === f);
    const b = olsFit(tr.map((i) => X[i]!), tr.map((i) => y[i]!));
    for (const i of te) {
      oofY.push(y[i]!);
      oofP.push(dot(b, X[i]!));
    }
  }
  return { cv_r2: r2Score(oofY, oofP), cv_mae_log: maeScore(oofY, oofP) };
}

interface ModelFit {
  beta: number[];
  spec: SpecId;
  spec_label: string;
  top_categories: string[];
  r2_train: number;
  r2_test: number;
  mae_log_test: number;
  cv_r2: number;
  cv_mae_log: number;
  cv_r2_base: number;
  cv_r2_cat: number;
  cv_r2_quad: number;
  cv_mae_base: number;
  cv_mae_cat: number;
  cv_mae_quad: number;
  n_live: number;
}

const SPEC_LABEL: Record<SpecId, string> = {
  base: 'base OLS',
  cat: 'base + top-5 category dummies',
  quad: 'base + log(TVL)^2',
};

function fitModel(snapshot: Snapshot): ModelFit {
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const y = live.map((p) => Math.log(p.mcap_usd!));
  const topCats = topCategories(live);
  const xBase = live.map((p) => designRowSpec(p, snapshot.as_of, 'base', topCats));
  const xCat = live.map((p) => designRowSpec(p, snapshot.as_of, 'cat', topCats));
  const xQuad = live.map((p) => designRowSpec(p, snapshot.as_of, 'quad', topCats));
  const cvBase = cvFor(xBase, y);
  const cvCat = cvFor(xCat, y);
  const cvQuad = cvFor(xQuad, y);
  // Highest CV R^2 wins, but only by a meaningful margin over the base;
  // a tie between the two challengers goes to the category spec.
  let spec: SpecId = 'base';
  if (cvCat.cv_r2 > cvBase.cv_r2 + CV_MEANINGFUL_GAIN && cvCat.cv_r2 >= cvQuad.cv_r2) {
    spec = 'cat';
  } else if (cvQuad.cv_r2 > cvBase.cv_r2 + CV_MEANINGFUL_GAIN) {
    spec = 'quad';
  }
  const X = spec === 'cat' ? xCat : spec === 'quad' ? xQuad : xBase;
  const beta = olsFit(X, y);
  const r2_train = r2Score(y, X.map((x) => dot(beta, x)));
  // Held-out: fold 4 (every 5th protocol by slug order) is the test set.
  const trainIdx = live.map((_, i) => i).filter((i) => i % 5 !== 4);
  const testIdx = live.map((_, i) => i).filter((i) => i % 5 === 4);
  const betaHold = olsFit(trainIdx.map((i) => X[i]!), trainIdx.map((i) => y[i]!));
  const r2_test = r2Score(testIdx.map((i) => y[i]!), testIdx.map((i) => dot(betaHold, X[i]!)));
  const mae_log_test = maeScore(testIdx.map((i) => y[i]!), testIdx.map((i) => dot(betaHold, X[i]!)));
  const chosenCv = spec === 'cat' ? cvCat : spec === 'quad' ? cvQuad : cvBase;
  return {
    beta,
    spec,
    spec_label: SPEC_LABEL[spec],
    top_categories: topCats,
    r2_train,
    r2_test,
    mae_log_test,
    cv_r2: chosenCv.cv_r2,
    cv_mae_log: chosenCv.cv_mae_log,
    cv_r2_base: cvBase.cv_r2,
    cv_r2_cat: cvCat.cv_r2,
    cv_r2_quad: cvQuad.cv_r2,
    cv_mae_base: cvBase.cv_mae_log,
    cv_mae_cat: cvCat.cv_mae_log,
    cv_mae_quad: cvQuad.cv_mae_log,
    n_live: live.length,
  };
}

// ------------------------------------------------------------------ farm plans
//
// Typical gas per transaction in USD, by chain (ordinary times, not a spike).
// Kept in code so every step can price itself; a chain not listed here uses
// $0.50. These are cost inputs to the plan, never a promise of the live fee.

const GAS_USD: Record<string, number> = {
  Ethereum: 8.0,
  Arbitrum: 0.3,
  Optimism: 0.1,
  Base: 0.05,
  Polygon: 0.02,
  'BNB Chain': 0.15,
  BSC: 0.15,
  Avalanche: 0.1,
  Solana: 0.01,
  Sui: 0.01,
  Aptos: 0.01,
  Fantom: 0.05,
  Gnosis: 0.05,
  Linea: 0.1,
  'zkSync Era': 0.15,
  Scroll: 0.1,
  Blast: 0.05,
  Mantle: 0.05,
  Tron: 0.1,
  Celo: 0.02,
  Mode: 0.05,
};

function gasUsd(chain: string): number {
  return GAS_USD[chain] ?? 0.5;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

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

// The core action, per category, filled with this protocol's own name,
// chain and TVL. A bridge moves value, a CEX takes a deposit and one trade,
// liquid staking stakes the underlying and keeps the receipt token.
function coreAction(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const tvl = fmtUsd(p.tvl_usd);
  const target = p.chains.length > 1 ? p.chains[1]! : 'Ethereum';
  if (c.includes('bridge') || c.includes('canonical')) {
    return `Bridge $${capital} of USDC from ${chain} to ${target} through ${name} (TVL ${tvl}), then bridge half of it back a week later so both directions are on record.`;
  }
  if (c === 'cex' || c.includes('centralized')) {
    return `Open an account on ${name}, deposit $${capital} of USDC from ${chain}, make one small spot trade, and leave the balance on the exchange for the holding period.`;
  }
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restaked')) {
    return `Stake $${capital} of the underlying asset through ${name} on ${chain} (TVL ${tvl}) and keep the receipt token in your wallet instead of selling it.`;
  }
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateralized')) {
    return `Supply $${capital} of USDC as collateral to ${name} on ${chain} (TVL ${tvl}), borrow a small amount against it, then repay the borrow in full.`;
  }
  if (c.includes('dex')) {
    return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} (TVL ${tvl}) and hold the LP position through at least one fee collection.`;
  }
  if (c.includes('yield') || c.includes('leveraged farm')) {
    return `Deposit $${capital} into ${name}'s highest-TVL vault on ${chain} (TVL ${tvl}) and keep the vault shares instead of withdrawing early.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain}, open one small hedged position, then close it and leave the margin in place.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} on ${chain} and take one small position in an active market, then settle it when the market resolves.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) {
    return `Deposit $${capital} into a ${name} curated vault on ${chain} (TVL ${tvl}) and hold the vault shares for the full period.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} (TVL ${tvl}) and hold it in your wallet.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in your wallet for the full period.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full period.`;
  }
  if (c.includes('options')) {
    return `Deposit $${capital} of USDC into ${name} on ${chain} and write or buy one small option, then let it settle.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} (TVL ${tvl}) and use its main feature once, end to end.`;
}

function weeklyAction(p: Protocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('bridge')) return 'a bridge in either direction';
  if (c === 'cex' || c.includes('centralized')) return 'a small trade or a deposit top-up';
  if (c.includes('liquid')) return 'a top-up stake, or a claim of staking rewards';
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
  const gas = gasUsd(chain);
  const steps: { text: string; cost: string; time: string }[] = [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase written on paper offline.',
      cost: '$0.00 to set up',
      time: '5 minutes',
    },
    {
      text: coreAction(p, capital, chain),
      cost: `$${capital} of capital plus about ${money(gas)} of gas for the transactions on ${chain}`,
      time: '15 minutes to set up',
    },
    {
      text: `Repeat one qualifying action every week for at least a month, such as ${weeklyAction(p)}.`,
      cost: `about ${money(gas)} of gas on ${chain} each week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity spans more than one snapshot window.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page from its official site and claim only through the link it publishes.`,
      cost: '$0.00 to check; never pay a fee to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet address, the dates and every transaction hash in a farm log, and set a monthly reminder to re-check the position.',
      cost: '$0.00; only the log itself',
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

function buildBoard(
  snapshot: Snapshot,
  fit: ModelFit,
  prob: ReturnType<typeof tokenProbCells>,
): { board: BoardRow[]; preCount: number } {
  const watch = new Set(snapshot.watchlist);
  const pre = snapshot.protocols.filter(isPreToken);
  const scored = pre.map((p) => {
    const x = designRowSpec(p, snapshot.as_of, fit.spec, fit.top_categories);
    const fitMcap = Math.exp(dot(fit.beta, x));
    const { rate, cell } = prob.rateOf(p, snapshot.as_of);
    const age = ageDays(snapshot.as_of, p.listed_at);
    const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(fitMcap * rate)));
    return { p, fitMcap, rate, cell, age, implied };
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
    on_watchlist: watch.has(s.p.slug),
    token_status: 'pre-token',
    implied_value_usd: s.implied,
    model: {
      fit_mcap_usd: s.fitMcap,
      p_token: s.rate,
      p_cell: s.cell,
      growth_pct: clamp(s.p.change_7d ?? 0, -50, 100),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
  return { board, preCount: pre.length };
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
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!(r.model.fit_mcap_usd > 0) || !(r.model.p_token > 0 && r.model.p_token <= 1)) return `${r.slug} has a bad model breakdown`;
  }
  return null;
}

// ------------------------------------------------------------------ run

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const fit = fitModel(snapshot);
const prob = tokenProbCells(snapshot);
const { board, preCount } = buildBoard(snapshot, fit, prob);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: board refused: ${issue}\n`);
  process.exit(1);
}

// Live-token protocols, all of them, set aside as market anchors: their
// market cap is a fact, never a model output, and they never enter the
// pre-token ranking. They are also the data the regression is fitted on.
const live = snapshot.protocols
  .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
  .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
  .map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));

// Protocols whose token already trades but whose market cap the snapshot
// does not record as a positive number: they can neither be fitted on (the
// model needs a positive mcap) nor ranked (they have a token), so they sit
// in their own view, outside the board — but they are counted, so every one
// of the snapshot's protocols appears somewhere on the page.
type UnpricedStatus = 'token-no-mcap' | 'mcap-nonpositive';
const unpriced = snapshot.protocols
  .filter((p) => !isPreToken(p) && !(p.mcap_usd !== null && p.mcap_usd > 0))
  .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  .map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: (p.mcap_usd === null ? 'token-no-mcap' : 'mcap-nonpositive') as UnpricedStatus,
  }));
const unpricedNoMcap = unpriced.filter((p) => p.token_status === 'token-no-mcap').length;
const unpricedNonpositive = unpriced.length - unpricedNoMcap;

const radar = {
  as_of: snapshot.as_of,
  source: snapshot.source.replace('https://api.llama.fi/protocols', 'DefiLlama protocols API'),
  floor_usd: snapshot.floor_usd,
  model_version: fit.spec === 'base' ? MODEL_VERSION : `${MODEL_VERSION}-${fit.spec}`,
  model: {
    kind: 'ols-log-mcap',
    spec: fit.spec,
    spec_label: fit.spec_label,
    top_categories: fit.top_categories,
    beta_extra: fit.beta.slice(4).map(round4),
    n_live: fit.n_live,
    intercept: round4(fit.beta[0]!),
    beta_log_tvl: round4(fit.beta[1]!),
    beta_growth: round4(fit.beta[2]!),
    beta_age_years: round4(fit.beta[3]!),
    r2_train: round4(fit.r2_train),
    r2_test: round4(fit.r2_test),
    mae_log_test: round4(fit.mae_log_test),
    cv_r2: round4(fit.cv_r2),
    cv_mae_log: round4(fit.cv_mae_log),
    cv_r2_base: round4(fit.cv_r2_base),
    cv_r2_cat: round4(fit.cv_r2_cat),
    cv_r2_quad: round4(fit.cv_r2_quad),
    cv_mae_base: round4(fit.cv_mae_base),
    cv_mae_cat: round4(fit.cv_mae_cat),
    cv_mae_quad: round4(fit.cv_mae_quad),
    p_global: round4(prob.global),
    p_cells: prob.cells.map((c) => ({
      cell: c.cell,
      age_label: c.age_label,
      tvl_label: c.tvl_label,
      rate: round4(c.rate),
      live: c.live,
      pre: c.pre,
    })),
    growth_floor: -50,
    growth_cap: 100,
    age_cap_days: 1095,
    unknown_age_days: 365,
  },
  watchlist_size: snapshot.watchlist.length,
  board_size: board.length,
  pre_token_count: preCount,
  live_size: live.length,
  unpriced_size: unpriced.length,
  unpriced_no_mcap: unpricedNoMcap,
  unpriced_nonpositive: unpricedNonpositive,
  coverage_total: preCount + live.length + unpriced.length,
  total_protocols: snapshot.protocols.length,
  total_implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
  median_implied_usd: median(board.map((r) => r.implied_value_usd)),
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
    on_watchlist: r.on_watchlist,
    implied_value_usd: r.implied_value_usd,
    fit_mcap_usd: r.model.fit_mcap_usd,
    p_token: r.model.p_token,
    p_cell: r.model.p_cell,
    farm_steps: r.farm_steps,
  })),
  live,
  unpriced,
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
  `token radar: ${snapshot.protocols.length} protocols (${preCount} pre-token, ${live.length} live, ${unpriced.length} live-token unpriced: ${unpricedNoMcap} token-no-mcap, ${unpricedNonpositive} mcap<=0), watchlist ${snapshot.watchlist.length}, board ${board.length} rows, coverage ${preCount + live.length + unpriced.length}/${snapshot.protocols.length}\n` +
    `token radar: OLS log(mcap) on ${fit.n_live} live comps: R2 train ${fit.r2_train.toFixed(3)}, held-out R2 ${fit.r2_test.toFixed(3)}, held-out MAE(log) ${fit.mae_log_test.toFixed(3)}, 5-fold CV R2 ${fit.cv_r2.toFixed(3)}\n` +
    `token radar: model spec comparison (5-fold CV R2): base ${fit.cv_r2_base.toFixed(3)}, +category ${fit.cv_r2_cat.toFixed(3)}, +logTVL^2 ${fit.cv_r2_quad.toFixed(3)} -> chosen ${fit.spec_label} (CV R2 ${fit.cv_r2.toFixed(3)})\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length}) and ${join(out, 'dossier.json')}\n`,
);
