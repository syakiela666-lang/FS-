/*
 * Test offline logika scanner tanpa fapi.binance.com (yang keblok di beberapa jaringan).
 * Sumber data: arsip publik data.binance.vision — klines monthly + daily futures UM.
 * Jalankan: node dev/test-classify.mjs
 */
import { inflateRawSync } from 'node:zlib';
import scanner from '../scanner.js';

const MONTHLY = ['2026-06', '2026-07', '2026-08'];
const DAILY = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'ARBUSDT', 'OPUSDT', 'TIAUSDT'];

/* Zip dari data.binance.vision berisi satu file CSV — cukup parse local file header-nya. */
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

async function fetchCsv(url) {
  try {
    // accept-encoding eksplisit: tanpa ini, undici bisa minta br dan body mentahnya bukan zip.
    const res = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
    if (!res.ok) return null;
    return unzipZip(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    return null;
  }
}

function parseKlines(csv) {
  const rows = [];
  for (const line of csv.trim().split('\n').slice(1)) {
    const f = line.split(',');
    if (f.length < 8) continue;
    rows.push({
      openTime: +f[0], o: +f[1], h: +f[2], l: +f[3], c: +f[4],
      closeTime: +f[6], quoteVolume: +f[7]
    });
  }
  return rows;
}

for (const sym of SYMBOLS) {
  let rows = [];
  for (const m of MONTHLY) {
    const csv = await fetchCsv(`https://data.binance.vision/data/futures/um/monthly/klines/${sym}/1d/${sym}-1d-${m}.zip`);
    if (csv) rows = rows.concat(parseKlines(csv));
  }
  for (const d of DAILY) {
    const csv = await fetchCsv(`https://data.binance.vision/data/futures/um/daily/klines/${sym}/1d/${sym}-1d-${d}.zip`);
    if (csv) rows = rows.concat(parseKlines(csv));
  }
  const now = Date.now();
  rows = rows.filter(r => r.closeTime <= now);
  rows.sort((a, b) => a.openTime - b.openTime);

  if (rows.length < 60) {
    console.log(sym.padEnd(10), '→ data kurang (' + rows.length + ' candle), skip');
    continue;
  }
  const r = scanner.classify(rows);
  const st = scanner.STAGES[r.stage] || { label: '-' };
  console.log(
    sym.padEnd(10),
    'stage', String(r.stage).padStart(2), st.label.padEnd(14),
    '| close', String(rows[rows.length - 1].c).padEnd(10),
    '| LH', r.lastLH != null ? r.lastLH.toFixed(4) : '-',
    '| distLH', r.distToLH != null ? r.distToLH.toFixed(1) + '%' : '-',
    '| RSI', r.rsi,
    r.divergence ? '| ⚡DIV' : '',
    r.freshHL ? '| 🆕HL' : ''
  );
}
console.log('\nOK — logika klasifikasi jalan di data asli.');
