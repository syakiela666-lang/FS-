/*
 * Backtest aturan klasifikasi — menjawab: seberapa bagus stage 4 (break) dan
 * stage 5 (retest) secara statistik?
 *
 * Aturan simulasi per sinyal:
 *   - Sinyal dideteksi pada close harian t (classify hanya melihat candle ≤ t,
 *     tanpa lookahead; sinyal stage 4 = break terjadi HARI INI, stage 5 = hari
 *     pertama masuk retest).
 *   - Entry: open hari t+1 (realistis — sinyal baru kelihatan setelah close).
 *   - Stop: di bawah HL (swing low struktur, field lastLL dari classify).
 *   - Take profit: +2R. Timeout: 30 hari, exit di close.
 *   - Satu trade per episode (sinyal hanya di transisi masuk stage).
 *
 * Data: arsip publik data.binance.vision (offline, tanpa fapi). Jalankan:
 *   node dev/backtest.mjs
 */
import { inflateRawSync } from 'node:zlib';
import scanner from '../scanner.js';

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT',
  'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'BCHUSDT', 'UNIUSDT', 'ATOMUSDT',
  'FILUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT',
  'INJUSDT', 'NEARUSDT', 'ICPUSDT', 'AAVEUSDT', 'GRTUSDT', 'ALGOUSDT', 'EGLDUSDT',
  'SANDUSDT', 'MANAUSDT'
];
// Warmup 4 bulan (classify butuh >=60 candle) + periode sinyal ~16 bulan.
const MONTHS = [
  '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
  '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'
];
const TP_R = 2;
const MAX_DAYS = 30;

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
      } catch (e) { /* bulan hilang = simbol belum listing, skip */ }
    }
  }
  await Promise.all(Array.from({ length: conc }, w));
  rows.sort((a, b) => a.openTime - b.openTime);
  // dedupe kalau ada overlap antar file
  const seen = new Set();
  return rows.filter(r => { if (seen.has(r.openTime)) return false; seen.add(r.openTime); return true; });
}

function backtest(sym, candles, stats, btcStageByTime) {
  if (candles.length < 91 + MAX_DAYS) return;

  // Klasifikasi per hari (stage pada close hari t) — satu pass, hasil disimpan.
  const perDay = [];
  for (let t = 60; t < candles.length; t++) {
    const r = scanner.classify(candles.slice(0, t + 1));
    perDay[t] = r.stage >= 0 ? { stage: r.stage, dsb: r.daysSinceBreak, stop: r.lastLL } : null;
  }

  let nTransitions = 0;
  for (let t = 60; t < candles.length - 1; t++) {
    const cur = perDay[t], prev = perDay[t - 1];
    if (!cur) continue;
    if (prev && cur.stage > prev.stage) nTransitions++;

    // Sinyal: stage 4 = break terjadi tepat hari ini; stage 5 = hari pertama masuk retest.
    const isSignal = cur.stage === 4 ? cur.dsb === 0
      : cur.stage === 5 ? (!prev || prev.stage !== 5)
      : false;
    if (!isSignal) continue;

    const end = Math.min(t + MAX_DAYS, candles.length - 1);
    if (end <= t + 1) continue; // butuh minimal 1 hari forward

    const entry = candles[t + 1].o;
    const stop = cur.stop;
    if (!(stop < entry)) continue; // struktur invalid (HL di atas harga entry)

    const risk = entry - stop;
    const tp = entry + TP_R * risk;
    let outcome = null, exitR = null;

    for (let k = t + 1; k <= end; k++) {
      const cd = candles[k];
      if (cd.l <= stop) { outcome = 'loss'; exitR = -1; break; } // konservatif: SL duluan
      if (cd.h >= tp) { outcome = 'win'; exitR = TP_R; break; }
    }
    if (!outcome) { outcome = end === candles.length - 1 && t + MAX_DAYS >= candles.length - 1 ? 'open' : 'timeout'; 
      exitR = outcome === 'timeout' ? (candles[end].c - entry) / risk : null; }

    // Bucket: semua sinyal vs terbagi regime BTC (tesis "alt butuh BTC break dulu").
    const grp = stats[cur.stage];
    const btcStage = btcStageByTime ? btcStageByTime.get(candles[t].openTime) : undefined;
    const buckets = [grp.all];
    if (btcStage != null) buckets.push(btcStage >= 4 ? grp.btcOn : grp.btcOff);
    for (const s of buckets) {
      s.n++;
      if (outcome === 'win') s.wins++;
      else if (outcome === 'loss') s.losses++;
      else if (outcome === 'timeout') s.timeouts++;
      else s.open++;
      if (exitR != null) s.returns.push(exitR);
    }
  }
  stats._transitions += nTransitions;
}

function median(a) {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
}

function newStats() {
  return { n: 0, wins: 0, losses: 0, timeouts: 0, open: 0, returns: [] };
}
const stats = {
  4: { all: newStats(), btcOn: newStats(), btcOff: newStats() },
  5: { all: newStats(), btcOn: newStats(), btcOff: newStats() },
  _transitions: 0
};

// Stage BTC per hari (keyed openTime) untuk filter regime.
async function buildBtcRegime() {
  const candles = await loadSymbol('BTCUSDT');
  const map = new Map();
  for (let t = 60; t < candles.length; t++) {
    const r = scanner.classify(candles.slice(0, t + 1));
    if (r.stage >= 0) map.set(candles[t].openTime, r.stage);
  }
  console.log(`BTC regime: ${map.size} hari terklasifikasi`);
  return map;
}

const btcStageByTime = await buildBtcRegime();

let done = 0;
for (const sym of SYMBOLS) {
  if (sym === 'BTCUSDT') { done++; continue; } // BTC dipakai sebagai regime, bukan sinyal
  const candles = await loadSymbol(sym);
  process.stdout.write(`[${++done}/${SYMBOLS.length}] ${sym} (${candles.length} candle)\n`);
  backtest(sym, candles, stats, btcStageByTime);
}

console.log('\n================ HASIL BACKTEST ================');
console.log(`Simbol: ${SYMBOLS.length} koin likuid · periode sinyal ~2025-05 s/d 2026-08`);
console.log(`Aturan: entry open H+1 · SL di bawah HL (1R) · TP +${TP_R}R · timeout ${MAX_DAYS} hari`);
console.log(`Total transisi tahap terdeteksi (validasi diff): ${stats._transitions}\n`);
const BUCKETS = [
  ['all', 'SEMUA sinyal'],
  ['btcOn', 'BTC risk-on (stage BTC >= 4)'],
  ['btcOff', 'BTC belum break (stage BTC <= 3)']
];
for (const st of [4, 5]) {
  console.log(`Stage ${st} (${scanner.STAGES[st].label}):`);
  for (const [key, label] of BUCKETS) {
    const s = stats[st][key];
    const closed = s.wins + s.losses + s.timeouts;
    const wr = closed ? (s.wins / closed * 100).toFixed(1) : '-';
    const avgR = s.returns.length ? (s.returns.reduce((a, b) => a + b, 0) / s.returns.length).toFixed(2) : '-';
    const sumR = s.returns.length ? s.returns.reduce((a, b) => a + b, 0).toFixed(1) : '-';
    console.log(`  ${label.padEnd(30)} trade ${String(s.n).padStart(3)} · TP ${String(s.wins).padStart(3)} · SL ${String(s.losses).padStart(3)} · t/o ${String(s.timeouts).padStart(3)} · WR ${wr}% · avg ${avgR}R · total ${sumR}R`);
  }
  console.log('');
}
