/*
 * scanner.js — logika scan struktur 1D Binance USDT-M Futures.
 * Jalan di browser (window.Scanner) maupun Node (module.exports).
 * Semua data dari endpoint publik fapi.binance.com, tanpa API key.
 */
(function (global) {
  'use strict';

  var BASE = 'https://fapi.binance.com';

  var STAGES = {
    0: { label: 'Downtrend',     hint: 'Masih LL/LH — bukan kandidat' },
    1: { label: 'Basing',        hint: 'LL berhenti, area pantau' },
    2: { label: 'HL Terbentuk',  hint: 'Watchlist prioritas' },
    3: { label: 'Menuju Break',  hint: 'Deket LH terakhir' },
    4: { label: 'Break',         hint: 'Struktur berubah — konfirmasi' },
    5: { label: 'Retest',        hint: 'Pullback ke LH — area entry' },
    6: { label: 'Uptrend',       hint: 'HH+HL sudah berjalan' }
  };

  function getJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status + ' — ' + url);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  function fetchSymbols() {
    return getJSON(BASE + '/fapi/v1/exchangeInfo').then(function (info) {
      return info.symbols
        .filter(function (s) {
          // Stablecoin/asset pegged (USDC, FDUSD, USD1, AEUR, ...) gak punya
          // "struktur" — sinyalnya murni noise, jadi dikecualikan.
          return s.status === 'TRADING' && s.quoteAsset === 'USDT' &&
            s.contractType === 'PERPETUAL' && !/(USD|EUR)/.test(s.baseAsset);
        })
        .map(function (s) { return s.symbol; });
    });
  }

  function fetchTicker24h() {
    return getJSON(BASE + '/fapi/v1/ticker/24hr').then(function (raw) {
      var map = {};
      raw.forEach(function (t) { map[t.symbol] = t; });
      return map;
    });
  }

  /* Funding rate semua simbol sekaligus — premiumIndex bulk, cukup 1 request. */
  function fetchFundingAll() {
    return getJSON(BASE + '/fapi/v1/premiumIndex').then(function (raw) {
      var map = {};
      (Array.isArray(raw) ? raw : []).forEach(function (x) {
        map[x.symbol] = x.lastFundingRate != null ? +x.lastFundingRate : null;
      });
      return map;
    });
  }

  /* Perubahan OI 7 hari (%) dari riwayat harian sumOpenInterestValue. */
  function oiChangeFromHist(hist) {
    if (!hist || hist.length < 2) return null;
    var first = +hist[0].sumOpenInterestValue;
    var last = +hist[hist.length - 1].sumOpenInterestValue;
    if (!first) return null;
    return (last - first) / first * 100;
  }

  function fetchOIChange(symbol) {
    return getJSON(BASE + '/futures/data/openInterestHist?symbol=' + symbol + '&period=1d&limit=8')
      .then(oiChangeFromHist)
      .catch(function () { return null; });
  }

  function fetchKlines(symbol, limit) {
    return getJSON(BASE + '/fapi/v1/klines?symbol=' + symbol + '&interval=1d&limit=' + (limit || 300))
      .then(function (raw) {
        var now = Date.now();
        return raw
          // buang candle terakhir kalau belum close (hari ini masih jalan)
          .filter(function (k) { return k[6] <= now; })
          .map(function (k) {
            return {
              openTime: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4],
              volume: +k[5], closeTime: k[6], quoteVolume: +k[7], trades: +k[8]
            };
          });
      });
  }

  /*
   * Pivot: swing high = candle yang high-nya lebih tinggi dari `left` candle
   * di kirinya dan `right` candle di kanannya (begitu juga low-nya untuk swing low).
   * Ini definisi struktur paling sederhana yang konsisten untuk klasifikasi HH/HL/LH/LL.
   */
  function findPivots(candles, left, right) {
    left = left || 3; right = right || 3;
    var highs = [], lows = [];
    for (var i = left; i < candles.length - right; i++) {
      var isH = true, isL = true;
      for (var j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) highs.push({ i: i, price: candles[i].h });
      if (isL) lows.push({ i: i, price: candles[i].l });
    }
    return { highs: highs, lows: lows };
  }

  /* RSI standar Wilder. Index 0..period-1 bernilai null. */
  function calcRSI(closes, period) {
    period = period || 14;
    var out = new Array(closes.length);
    for (var z = 0; z < out.length; z++) out[z] = null;
    if (closes.length <= period) return out;
    var gain = 0, loss = 0, i, d;
    for (i = 1; i <= period; i++) {
      d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (i = period + 1; i < closes.length; i++) {
      d = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
      loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /*
   * Klasifikasi struktur dari candle 1D yang sudah close.
   * Urutan tahap rally: 0 downtrend → 1 basing → 2 HL terbentuk → 3 menuju break
   * → 4 break LH → 5 retest → (6 uptrend berjalan).
   */
  function classify(candles) {
    var n = candles.length;
    if (n < 60) return { stage: -1, reason: 'Data kurang (listing baru)' };

    var piv = findPivots(candles);
    var highs = piv.highs, lows = piv.lows;
    if (highs.length < 2 || lows.length < 2) return { stage: -1, reason: 'Struktur belum terbaca' };

    var lastH = highs[highs.length - 1], prevH = highs[highs.length - 2];
    var lastL = lows[lows.length - 1], prevL = lows[lows.length - 2];
    var lastClose = candles[n - 1].c;

    var rsiArr = calcRSI(candles.map(function (c) { return c.c; }));
    var rsi = rsiArr[n - 1];

    // Divergence bullish: harga bikin low lebih rendah, RSI di titik low-nya malah lebih tinggi.
    var divergence = lastL.price < prevL.price &&
      rsiArr[lastL.i] != null && rsiArr[prevL.i] != null &&
      rsiArr[lastL.i] > rsiArr[prevL.i] + 1;

    var out = {
      stage: 0,
      rsi: Math.round(rsi * 10) / 10,
      divergence: divergence,
      lastLH: lastH.price,
      distToLH: (lastH.price - lastClose) / lastClose * 100,
      lastLL: lastL.price,
      lastLHdate: candles[lastH.i].closeTime,
      lastLLdate: candles[lastL.i].closeTime,
      daysSinceBreak: null,
      // Swing low terbaru (gap kecil dari candle terakhir) = HL baru saja terkonfirmasi.
      // Pivot butuh 3 candle di kanan, jadi gap minimum 3; ambang 4 = terkonfirmasi ≤1 hari.
      freshHL: (n - 1 - lastL.i) <= 4
    };

    // HH + HL: uptrend sudah jalan, konfirmasi struktur penuh.
    if (lastH.price > prevH.price && lastL.price > prevL.price) {
      out.stage = 6;
      return out;
    }

    // Close harian di atas swing high terakhir: struktur downtrend rusak.
    if (lastClose > lastH.price) {
      var breakIdx = -1;
      for (var i = lastH.i + 1; i < n; i++) {
        if (candles[i].c > lastH.price) { breakIdx = i; break; }
      }
      out.daysSinceBreak = n - 1 - breakIdx;
      // Retest: break sudah beberapa candle, harga pernah turun nyentuh area LH lagi.
      if (out.daysSinceBreak >= 2) {
        var touched = false;
        for (var k = breakIdx + 1; k < n; k++) {
          if (candles[k].l <= lastH.price * 1.02) { touched = true; break; }
        }
        out.stage = (touched && lastClose <= lastH.price * 1.05) ? 5 : 4;
      } else {
        out.stage = 4;
      }
      return out;
    }

    // Low terakhir lebih tinggi dari low sebelumnya: higher low terbentuk.
    if (lastL.price > prevL.price) {
      out.stage = out.distToLH <= 5 ? 3 : 2;
      return out;
    }

    // Masih LL, tapi LL terakhirnya sudah lama + RSI lemah/divergence: basing.
    var daysSinceLL = n - 1 - lastL.i;
    if (daysSinceLL >= 14 && (out.rsi < 45 || divergence)) out.stage = 1;
    return out;
  }

  /*
   * Scan semua perp USDT. opts: concurrency, minVol24h, maxSymbols, oiEnrich,
   * onProgress(done,total).
   * Koin dengan volume 24 jam di bawah minVol24h dilewati tanpa fetch klines.
   * Setelah struktur: funding rate massal (semua koin) + OI 7 hari (koin tahap 2+).
   */
  function scanAll(opts) {
    opts = opts || {};
    var concurrency = opts.concurrency || 12;
    var minVol = opts.minVol24h != null ? opts.minVol24h : 3e6;
    var onProgress = opts.onProgress || function () {};

    return Promise.all([fetchSymbols(), fetchTicker24h()]).then(function (r) {
      var symbols = r[0], tickers = r[1];
      var queue = symbols.slice();
      if (opts.maxSymbols) queue = queue.slice(0, opts.maxSymbols);
      var total = queue.length;
      var results = [], done = 0, failed = 0;

      function worker() {
        return new Promise(function (resolve) {
          function next() {
            if (!queue.length) return resolve();
            var sym = queue.shift();
            var t = tickers[sym];
            var p;
            if (!t || +t.quoteVolume < minVol) {
              p = Promise.resolve();
            } else {
              p = fetchKlines(sym).then(function (candles) {
                var res = classify(candles);
                if (res.stage >= 0) {
                  results.push({
                    symbol: sym,
                    price: candles[candles.length - 1].c,
                    stage: res.stage,
                    stageLabel: STAGES[res.stage].label,
                    rsi: res.rsi,
                    divergence: res.divergence,
                    freshHL: res.freshHL,
                    lastLH: res.lastLH,
                    distToLH: res.distToLH,
                    lastLL: res.lastLL,
                    daysSinceBreak: res.daysSinceBreak,
                    quoteVolume: +t.quoteVolume,
                    change24h: +t.priceChangePercent,
                    // Kinerja 30 hari (%), dipakai untuk RS vs BTC di akhir scan.
                    perf30d: candles.length >= 31
                      ? Math.round((candles[candles.length - 1].c / candles[candles.length - 31].c - 1) * 1000) / 10
                      : null
                  });
                }
              }).catch(function () { failed++; });
            }
            p.then(function () {
              done++;
              onProgress(done, total);
              next();
            });
          }
          next();
        });
      }

      var workers = [];
      for (var i = 0; i < concurrency; i++) workers.push(worker());

      return Promise.all(workers)
        .then(function () {
          // Funding rate: 1 request massal (premiumIndex) untuk semua simbol.
          return fetchFundingAll().then(function (fmap) {
            results.forEach(function (x) { x.funding = fmap[x.symbol] != null ? fmap[x.symbol] : null; });
          }).catch(function () {
            results.forEach(function (x) { x.funding = null; });
          });
        })
        .then(function () {
          // OI 7 hari: hanya koin tahap 2+ yang diperkaya (hemat request).
          var targets = opts.oiEnrich === false ? [] : results.filter(function (x) { return x.stage >= 2; });
          if (!targets.length) return;
          var grand = total + targets.length;
          var q = targets.slice();
          function oiWorker() {
            return new Promise(function (resolve) {
              function next() {
                if (!q.length) return resolve();
                var x = q.shift();
                fetchOIChange(x.symbol).then(function (v) { x.oi7d = v; }).then(function () {
                  done++;
                  onProgress(done, grand);
                  next();
                });
              }
              next();
            });
          }
          var ws = [];
          for (var w = 0; w < concurrency; w++) ws.push(oiWorker());
          return Promise.all(ws);
        })
        .then(function () {
          // RS 30 hari = kinerja koin dikurangi kinerja BTC, plus regime market
          // dari posisi struktur BTC (alt rally biasanya menunggu BTC break dulu).
          var btc = null;
          for (var i = 0; i < results.length; i++) {
            if (results[i].symbol === 'BTCUSDT') { btc = results[i]; break; }
          }
          var btcPerf = btc && btc.perf30d != null ? btc.perf30d : null;
          results.forEach(function (x) {
            x.rs30 = (btcPerf != null && x.perf30d != null)
              ? Math.round((x.perf30d - btcPerf) * 10) / 10
              : null;
          });
          results.sort(function (a, b) { return b.stage - a.stage || b.quoteVolume - a.quoteVolume; });
          return {
            scannedAt: Date.now(),
            total: total,
            failed: failed,
            minVol: minVol,
            btc: btc ? { stage: btc.stage, stageLabel: btc.stageLabel, perf30d: btc.perf30d } : null,
            results: results
          };
        });
    });
  }

  var api = {
    STAGES: STAGES,
    HOT_FUNDING: 0.001, // 0,1% per 8 jam = ambang "funding panas" (rawan long squeeze)
    RS_STRONG: 10,      // ambang RS kuat: koin mengungguli BTC ≥10 poin persentase (30 hari)
    scanAll: scanAll,
    classify: classify,
    calcRSI: calcRSI,
    findPivots: findPivots,
    fetchKlines: fetchKlines,
    fetchFundingAll: fetchFundingAll,
    fetchOIChange: fetchOIChange,
    oiChangeFromHist: oiChangeFromHist
  };

  global.Scanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
