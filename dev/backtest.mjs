/*
 * Backtest aturan klasifikasi + eksperimen eksekusi.
 *
 * Pertanyaan yang dijawab: sinyal stage 4/5 dengan EKSEKUSI apa yang paling masuk akal?
 * Varian yang dibandingkan (semua dalam satuan R terhadap risiko masing-masing):
 *   A — baseline : entry open H+1 · stop di HL · TP +2R · timeout 30 hari
 *   B — ATR stop : entry open H+1 · stop = HL − 1×ATR14 · TP +2R
 *   C — ATR 1.5  : sama tapi stop = HL − 1.5×ATR14
 *   D — parsial  : stop HL − 1×ATR · TP1 +1.5R (50%, lalu stop ke BE) · TP2 +3R (50%)
 *   E — retest   (stage 4 saja): limit di level LH yang ditembus · stop HL − 1×ATR · TP +2R
 *                    (kalau 10 hari gak pullback ke LH = tidak fill; batal kalau HL jebol)
 *
 * Data di-cache di dev/.cache — run pertama mengunduh, run berikutnya instan.
 * Jalankan: node dev/backtest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import scanner from '../scanner.js';

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT',
  'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'BCHUSDT', 'UNIUSDT', 'ATOMUSDT',
  'FILUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT',
  'INJUSDT', 'NEARUSDT', 'ICPUSDT', 'AAVEUSDT', 'GRTUSDT', 'ALGOUSDT', 'EGLDUSDT',
  'SANDUSDT', 'MANAUSDT'
];
const MONTHS = [
  '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
  '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'
];
const TP_R = 2, MAX_DAYS = 30, FILL_DAYS = 10, ATR_P = 14;
const CACHE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '.cache');

function unzipZip(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('bukan zip');
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const data = buf.subarray(start, compSize ? start + compSize : undefined);
  return method === 0 ? data.toString() : inflateRawSync(data).toString();
}

function parseKlines(csv) {
  const rows = [];
  for (const line of csv.trim().split('\n').slice(1)) {
    const f = line.split(',');
    if (f.length < 8) continue;
    rows.push({ openTime: +f[0], o: +f[1], h: +f[2], l: +f[3], c: +f[4], closeTime: +f[6] });
  }
  return rows;
}

async function loadSymbol(sym) {
  fs.mkdirSync(CACHE, { recursive: true });
  const cf = path.join(CACHE, sym + '.json');
  if (fs.existsSync(cf)) return JSON.parse(fs.readFileSync(cf, 'utf8'));
  let rows = [];
  const urls = MONTHS.map(m =>
    `https://data.binance.vision/data/futures/um/monthly/klines/${sym}/1d/${sym}-1d-${m}.zip`);
  const conc = 8, q = urls.slice();
  async function w() {
    while (q.length) {
      const u = q.shift();
      try {
        const res = await fetch(u, { headers: { 'accept-encoding': 'identity' } });
        if (res.ok) rows = rows.concat(parseKlines(unzipZip(Buffer.from(await res.arrayBuffer()))));
      } catch (e) { /* bulan hilang = belum listing */ }
    }
  }
  await Promise.all(Array.from({ length: conc }, w));
  rows.sort((a, b) => a.openTime - b.openTime);
  const seen = new Set();
  rows = rows.filter(r => { if (seen.has(r.openTime)) return false; seen.add(r.openTime); return true; });
  fs.writeFileSync(cf, JSON.stringify(rows));
  return rows;
}

/* ATR14 sederhana (SMA true range) per index. */
function buildATR(candles) {
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    sum += tr;
    if (i >= ATR_P) {
      if (i > ATR_P) sum -= trPrev[i - ATR_P];
      atr[i] = sum / ATR_P;
    }
    (trPrev[i] = tr);
  }
  return atr;
}
const trPrev = [];

/* Simulasi satu trade. Mengembalikan { outcome, r } atau null (tidak valid). */
function walk(candles, startIdx, entry, stop, tpR, partial) {
  const end = Math.min(startIdx + MAX_DAYS, candles.length - 1);
  if (end <= startIdx) return { outcome: 'open', r: null };
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  let stopCur = stop;
  let leg1Open = true, leg2Open = true;
  let rAcc = 0;
  for (let k = startIdx; k <= end; k++) {
    const cd = candles[k];
    // Konservatif: dalam satu candle, stop dievaluasi sebelum TP.
    if (cd.l <= stopCur) {
      const rStop = (stopCur - entry) / risk;
      const legs = (leg1Open ? 1 : 0) + (leg2Open ? 1 : 0);
      if (legs === 2) return { outcome: 'loss', r: rStop };
      if (legs === 1) return { outcome: leg1Open ? 'loss1' : 'loss2', r: rAcc + 0.5 * rStop };
      return { outcome: 'be', r: rAcc };
    }
    if (partial) {
      if (leg1Open && cd.h >= entry + 1.5 * risk) {
        rAcc += 0.5 * 1.5; leg1Open = false; stopCur = entry; // stop ke breakeven
      }
      if (!leg1Open && leg2Open && cd.h >= entry + 3 * risk) {
        return { outcome: 'win', r: rAcc + 0.5 * 3 };
      }
    } else if (cd.h >= entry + tpR * risk) {
      return { outcome: 'win', r: tpR };
    }
  }
  const closed = end < candles.length - 1 || startIdx + MAX_DAYS < candles.length;
  if (!closed) return { outcome: 'open', r: null };
  const rT = (candles[end].c - entry) / risk;
  if (partial) {
    const legs = (leg1Open ? 1 : 0) + (leg2Open ? 1 : 0);
    if (legs === 2) return { outcome: 'timeout', r: rT };
    return { outcome: 'timeout1', r: rAcc + 0.5 * rT };
  }
  return { outcome: 'timeout', r: rT };
}

function newStats() { return { n: 0, wins: 0, losses: 0, timeouts: 0, open: 0, nofill: 0, returns: [] }; }
const stats = {
  4: { A: newStats(), B: newStats(), C: newStats(), D: newStats(), E: newStats() },
  5: { A: newStats(), B: newStats(), C: newStats(), D: newStats() }
};

function backtest(sym, candles) {
  if (candles.length < 91 + MAX_DAYS) return;
  buildATR.length; // no-op agar trPrev tidak ter-reset di tengah simbol
  trPrev.length = 0;
  const atr = buildATR(candles);

  const perDay = [];
  for (let t = 60; t < candles.length; t++) {
    const r = scanner.classify(candles.slice(0, t + 1));
    perDay[t] = r.stage >= 0 ? { stage: r.stage, dsb: r.daysSinceBreak, stop: r.lastLL, lh: r.lastLH } : null;
  }

  for (let t = 60; t < candles.length - 1; t++) {
    const cur = perDay[t], prev = perDay[t - 1];
    if (!cur || !atr[t]) continue;
    const isSignal = cur.stage === 4 ? cur.dsb === 0
      : cur.stage === 5 ? (!prev || prev.stage !== 5)
      : false;
    if (!isSignal) continue;

    const s = stats[cur.stage];
    const entry0 = candles[t + 1].o;
    const a = atr[t];
    const results = {};

    results.A = walk(candles, t + 1, entry0, cur.stop, TP_R, false);
    results.B = walk(candles, t + 1, entry0, cur.stop - 1 * a, TP_R, false);
    results.C = walk(candles, t + 1, entry0, cur.stop - 1.5 * a, TP_R, false);
    results.D = walk(candles, t + 1, entry0, cur.stop - 1 * a, 0, true);

    // E (khusus stage 4): tunggu pullback ke level LH yang baru ditembus.
    if (cur.stage === 4 && cur.lh) {
      let filled = null;
      for (let f = t + 1; f <= Math.min(t + FILL_DAYS, candles.length - 1); f++) {
        if (candles[f].l <= cur.stop - 1 * a) break; // HL jebol sebelum retest → batal
        if (candles[f].l <= cur.lh * 1.005) { filled = f; break; }
      }
      if (filled == null) {
        results.E = { outcome: 'nofill', r: null };
      } else {
        results.E = walk(candles, filled, cur.lh, cur.stop - 1 * a, TP_R, false);
      }
    }

    for (const cfg in results) {
      const res = results[cfg];
      if (!res) continue;
      const st = s[cfg];
      st.n++;
      if (res.outcome === 'win') st.wins++;
      else if (res.outcome === 'loss' || res.outcome === 'loss1' || res.outcome === 'loss2') st.losses++;
      else if (String(res.outcome).startsWith('timeout')) st.timeouts++;
      else if (res.outcome === 'be') st.timeouts++;
      else if (res.outcome === 'nofill') st.nofill++;
      else st.open++;
      if (res.r != null) st.returns.push(res.r);
    }
  }
}

function median(a) {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
}

let done = 0;
for (const sym of SYMBOLS) {
  const candles = await loadSymbol(sym);
  process.stdout.write(`[${++done}/${SYMBOLS.length}] ${sym} (${candles.length} candle)\n`);
  if (sym === 'BTCUSDT') continue; // regime — tidak ikut sebagai sinyal
  backtest(sym, candles);
}

const LABELS = {
  A: 'baseline: open · stop HL · TP 2R',
  B: 'open · stop HL−1ATR · TP 2R',
  C: 'open · stop HL−1.5ATR · TP 2R',
  D: 'open · HL−1ATR · parsial 1.5R/3R+BE',
  E: 'limit retest LH · HL−1ATR · TP 2R'
};
console.log('\n============= EKSPERIMEN EKSEKUSI =============');
console.log(`30 koin likuid · sinyal ~2025-05 s/d 2026-08 · timeout ${MAX_DAYS}h · semua dalam R`);
for (const st of [4, 5]) {
  console.log(`\nStage ${st} (${scanner.STAGES[st].label}):`);
  for (const cfg in stats[st]) {
    const s = stats[st][cfg];
    const closed = s.wins + s.losses + s.timeouts;
    const wr = closed ? (s.wins / closed * 100).toFixed(1) : '-';
    const avgR = s.returns.length ? (s.returns.reduce((x, y) => x + y, 0) / s.returns.length).toFixed(3) : '-';
    const medR = median(s.returns) != null ? median(s.returns).toFixed(2) : '-';
    const totR = s.returns.length ? s.returns.reduce((x, y) => x + y, 0).toFixed(1) : '-';
    const fill = cfg === 'E' && s.n ? ` · fill ${(100 - s.nofill / s.n * 100).toFixed(0)}%` : '';
    console.log(`  ${cfg} ${LABELS[cfg].padEnd(34)} n=${String(s.n).padStart(3)} · WR ${wr.padStart(5)}% · avg ${avgR}R · med ${medR}R · tot ${totR}R${fill}`);
  }
}
console.log('\nBreakeven RR 2:1 = WR 33.3%. catatan: R dinormalisasi risiko masing-masing;');
console.log('biaya trading (fee, funding perp selama holding) belum dimodelkan.');
