/*
 * /api/cron-telegram — dipanggil Vercel Cron 1×/hari (00:05 UTC = 07:05 WIB,
 * tepat habis daily close). Scan semua perp lalu kirim ringkasan ke Telegram.
 *
 * Env vars (Vercel → Settings → Environment Variables):
 *   TELEGRAM_BOT_TOKEN  token bot dari @BotFather
 *   TELEGRAM_CHAT_ID    id chat tujuan (bisa dideteksi otomatis, lihat README)
 *   CRON_SECRET         opsional tapi disarankan; cron Vercel otomatis kirim
 *                       header "Authorization: Bearer <CRON_SECRET>" kalau env
 *                       var ini ada. Tanpa ini endpoint bisa dipanggil siapa saja.
 *
 * Test manual: buka /api/cron-telegram?key=<CRON_SECRET> di browser,
 * atau curl dengan header Authorization.
 */
const scanner = require('../scanner.js');

const TZ = 'Asia/Jakarta';
const MAX_COINS = 15;
const MSG_LIMIT = 4096;

function fmtVol(v) {
  return v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : '$' + (v / 1e6).toFixed(1) + 'M';
}

var HOT_FUNDING = scanner.HOT_FUNDING;

/* Event segar: break ≤2 candle lalu, atau HL yang baru terkonfirmasi. */
function freshMark(r) {
  if ((r.stage === 4 || r.stage === 5) && r.daysSinceBreak != null && r.daysSinceBreak <= 2) return '🆕 ';
  if ((r.stage === 2 || r.stage === 3) && r.freshHL) return '🆕 ';
  return '';
}

function flagsLine(r) {
  var s = [];
  if (r.funding != null) {
    var fr = r.funding * 100;
    s.push('FR ' + fr.toFixed(3) + '%' + (fr >= HOT_FUNDING * 100 ? ' ⚠️' : ''));
  }
  if (r.oi7d != null) s.push('OI 7h ' + (r.oi7d >= 0 ? '+' : '') + r.oi7d.toFixed(0) + '%');
  return s.length ? ' · ' + s.join(' · ') : '';
}

function coinLine(r) {
  var mark = freshMark(r), body;
  if (r.stage === 5) {
    body = '🎯 Retest (break ' + r.daysSinceBreak + 'c lalu) · ' + fmtVol(r.quoteVolume);
  } else if (r.stage === 4) {
    body = '✅ Break (' + r.daysSinceBreak + 'c lalu) · RSI ' + r.rsi;
  } else if (r.stage === 3) {
    body = 'Menuju Break · ' + r.distToLH.toFixed(1) + '% ke LH · RSI ' + r.rsi + (r.divergence ? ' · ⚡div' : '');
  } else {
    body = 'HL Terbentuk · ' + r.distToLH.toFixed(1) + '% ke LH · ' + fmtVol(r.quoteVolume);
  }
  // Harga naik tapi OI turun = rally cuma didorong short covering, biasanya gak awet.
  var warn = (r.change24h > 0 && r.oi7d != null && r.oi7d <= -3) ? ' · ⚠️ short covering' : '';
  return '• ' + mark + '<b>' + r.symbol + '</b> — ' + body + flagsLine(r) + warn;
}

/*
 * Susun pesan harian: prioritas tahap 5 (retest) → 4 (break) → 3 (menuju break).
 * Kalau entry zone kosong, tampilkan 3 koin tahap 2–3 yang paling dekat ke LH.
 */
function formatMessage(data) {
  const res = data.results || [];
  const zone = res.filter(r => r.stage >= 3 && r.stage <= 5);
  const nStage2 = res.filter(r => r.stage === 2).length;
  const nFresh2 = res.filter(r => r.stage === 2 && r.freshHL).length;
  const nStage1 = res.filter(r => r.stage === 1).length;
  const nUp = res.filter(r => r.stage === 6).length;

  const tgl = new Date(data.scannedAt || Date.now()).toLocaleDateString('id-ID', {
    timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric'
  });

  let out = '📊 <b>Structure Scan</b> — ' + tgl + '\n';

  if (zone.length) {
    out += '\n🎯 <b>Entry zone (tahap 3–5):</b>\n';
    const shown = zone.slice(0, MAX_COINS);
    out += shown.map(coinLine).join('\n');
    if (zone.length > shown.length) out += '\n• …dan ' + (zone.length - shown.length) + ' koin lainnya';
  } else {
    out += '\n🎯 Entry zone (3–5): <b>kosong</b> hari ini.';
    const near = res.filter(r => r.stage === 3 || r.stage === 2)
      .sort((a, b) => a.distToLH - b.distToLH).slice(0, 3);
    if (near.length) out += '\n👀 Paling dekat break:\n' + near.map(coinLine).join('\n');
  }

  out += '\n\n📋 Watchlist: ' + nStage2 + ' HL terbentuk (🆕 ' + nFresh2 + ' baru) · ' + nStage1 + ' basing · ' + nUp + ' uptrend';
  if (data.failed) out += '\n⚠️ ' + data.failed + ' koin gagal discan';
  out += '\n\n<i>Bukan sinyal beli — struktur berubah, selalu pakai stop.</i>';

  return out.length <= MSG_LIMIT ? out : out.slice(0, MSG_LIMIT - 1);
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error('Telegram: ' + (body.description || ('HTTP ' + res.status)));
  }
  return body;
}

async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'];
    const queryKey = new URL(req.url, 'http://x').searchParams.get('key');
    if (auth !== 'Bearer ' + secret && queryKey !== secret) {
      res.status(401).json({ error: 'Unauthorized. Cron Vercel kirim header otomatis; untuk test manual pakai ?key=<CRON_SECRET>.' });
      return;
    }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN belum diset. Buat bot via @BotFather, lalu tambahkan env var di Vercel.' });
    return;
  }

  // Mode setup: CHAT_ID kosong → deteksi dari getUpdates supaya user tinggal copy-paste.
  if (!chatId) {
    let detected = [];
    try {
      const upd = await fetch('https://api.telegram.org/bot' + token + '/getUpdates').then(r => r.json());
      detected = [...new Set((upd.result || [])
        .map(u => u.message && u.message.chat && u.message.chat.id)
        .filter(Boolean))];
    } catch (e) { /* ditangani di bawah */ }
    if (!detected.length) {
      res.status(500).json({ error: 'TELEGRAM_CHAT_ID belum diset dan tidak ada chat terdeteksi. Kirim /start ke bot lo dulu, lalu panggil endpoint ini lagi.' });
    } else {
      res.status(500).json({ error: 'TELEGRAM_CHAT_ID belum diset. Chat ID terdeteksi: ' + detected.join(', ') + ' — set sebagai env var TELEGRAM_CHAT_ID di Vercel, lalu redeploy.' });
    }
    return;
  }

  let message;
  try {
    const data = await scanner.scanAll({ concurrency: 20 });
    data.mode = 'server';
    message = formatMessage(data);
  } catch (eScan) {
    message = '⚠️ Structure Scan gagal hari ini: ' + eScan.message;
    let tgaErr = null;
    try { await sendTelegram(token, chatId, message); } catch (e) { tgaErr = e.message; }
    res.status(500).json({ error: 'Scan gagal: ' + eScan.message, telegramError: tgaErr });
    return;
  }

  try {
    await sendTelegram(token, chatId, message);
    const zone = (data.results || []).filter(r => r.stage >= 3 && r.stage <= 5).length;
    res.status(200).json({ ok: true, sentTo: chatId, coinsInZone: zone, message: message });
  } catch (e) {
    res.status(502).json({ error: e.message, message: message });
  }
}

module.exports = handler;
module.exports.formatMessage = formatMessage;
