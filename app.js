/*
 * app.js — UI, cache 12 jam, dan fallback mode.
 * Mode "direct": scan jalan di browser. Kalau jaringan memblokir Binance,
 * otomatis pindah ke function /api/scan (hanya aktif kalau di-deploy lengkap ke Vercel).
 */
(function () {
  'use strict';
  var S = window.Scanner;
  var CACHE_KEY = 'futscan_v1';
  var TTL = 12 * 3600 * 1000;

  var FILTERS = [
    { id: 'all',   label: 'Semua',           test: function () { return true; } },
    { id: 'rose',  label: '🆕 Naik tahap',   test: function (r) { return !!(r.rose || r.rosePrev); } },
    { id: 'entry', label: 'Entry (4–5)',     test: function (r) { return r.stage >= 4 && r.stage <= 5; } },
    { id: 'watch', label: 'Watchlist (2–3)', test: function (r) { return r.stage >= 2 && r.stage <= 3; } },
    { id: 'base',  label: 'Basing (1)',      test: function (r) { return r.stage === 1; } },
    { id: 'up',    label: 'Uptrend (6)',     test: function (r) { return r.stage === 6; } },
    { id: 'rs',    label: 'RS kuat (≥+' + S.RS_STRONG + ')', test: function (r) { return r.rs30 != null && r.rs30 >= S.RS_STRONG; } }
  ];

  var data = null, filter = 'all', query = '';

  var $ = function (id) { return document.getElementById(id); };

  function fmtPrice(p) {
    if (p >= 1000) return p.toLocaleString('id-ID', { maximumFractionDigits: 1 });
    if (p >= 1) return p.toFixed(4);
    return p.toPrecision(4);
  }
  function fmtVol(v) { return v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : '$' + (v / 1e6).toFixed(1) + 'M'; }
  function fmtPct(x) { return (x >= 0 ? '+' : '') + x.toFixed(1) + '%'; }
  function fmtTime(ts) {
    return new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function showErr(msg) { var e = $('err'); e.textContent = msg; e.classList.add('on'); }
  function hideErr() { $('err').classList.remove('on'); }

  function rowHTML(r) {
    var st = S.STAGES[r.stage];
    var parts = [];
    parts.push('Harga <b>' + fmtPrice(r.price) + '</b>');
    parts.push('RSI <b>' + r.rsi + '</b>');
    if (r.stage === 4 || r.stage === 5) {
      parts.push('break <b>' + r.daysSinceBreak + ' candle</b> lalu');
    } else if (r.stage >= 1 && r.stage <= 3) {
      parts.push('ke LH <b>' + r.distToLH.toFixed(1) + '%</b>');
    }
    if (r.funding != null) {
      var fr = r.funding * 100;
      parts.push('FR <b' + (fr >= S.HOT_FUNDING * 100 ? ' class="down"' : '') + '>' + fr.toFixed(3) + '%</b>');
    }
    if (r.oi7d != null) {
      parts.push('OI 7h <b class="' + (r.oi7d >= 0 ? 'up' : 'down') + '">' + (r.oi7d >= 0 ? '+' : '') + r.oi7d.toFixed(0) + '%</b>');
    }
    if (r.rs30 != null) {
      var rsCls = r.rs30 >= S.RS_STRONG ? 'up' : (r.rs30 <= -S.RS_STRONG ? 'down' : '');
      parts.push('RS <b' + (rsCls ? ' class="' + rsCls + '"' : '') + '>' + (r.rs30 >= 0 ? '+' : '') + r.rs30 + '</b>');
    }
    if (r.change24h > 0 && r.oi7d != null && r.oi7d <= -3) {
      parts.push('<span class="div">⚠️ short covering</span>');
    }
    if (r.divergence) parts.push('<span class="div">⚡ divergence</span>');
    if (r.stage >= 2 && r.stage <= 3 && r.freshHL) parts.push('<span class="up">🆕 HL baru</span>');
    parts.push('<span class="' + (r.change24h >= 0 ? 'up' : 'down') + '">' + fmtPct(r.change24h) + ' 24j</span>');
    return '<div class="row">' +
      '<div class="l1"><span class="sym">' + r.symbol + '</span>' +
      '<span class="badge s' + r.stage + '" title="' + st.hint + '">' + st.label + '</span>' +
      (r.rose || r.rosePrev ? '<span class="badge rose">↑' +
        ((r.rose ? r.roseBy : r.stage - r.prevStage) > 1 ? (r.rose ? r.roseBy : r.stage - r.prevStage) : '') + '</span>' : '') +
      '<span class="vol">' + fmtVol(r.quoteVolume) + '</span></div>' +
      '<div class="l2">' + parts.join(' · ') + '</div></div>';
  }

  function render() {
    if (!data) return;
    var f = null;
    for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].id === filter) f = FILTERS[i];
    var q = query.trim().toUpperCase();
    var rows = data.results.filter(function (r) {
      return f.test(r) && (!q || r.symbol.indexOf(q) !== -1);
    });
    var btcTxt = data.btc
      ? ' · BTC: ' + data.btc.stageLabel + ' (30h ' + (data.btc.perf30d >= 0 ? '+' : '') + data.btc.perf30d + '%)'
      : '';
    $('count').textContent = rows.length + ' koin ditampilkan · dari ' + data.results.length +
      ' koin ter-scan (total ' + data.total + ' perp) · scan ' + fmtTime(data.scannedAt) +
      ' · mode: ' + (data.mode === 'server' ? 'server Vercel' : 'browser langsung') + btcTxt;
    $('list').innerHTML = rows.map(rowHTML).join('') ||
      '<div class="row" style="color:var(--dim)">Gak ada koin di filter ini.</div>';
  }

  function renderChips() {
    $('chips').innerHTML = FILTERS.map(function (f) {
      return '<button class="chip' + (f.id === filter ? ' on' : '') + '" data-f="' + f.id + '">' + f.label + '</button>';
    }).join('');
  }

  function setBusy(b) { $('rescan').disabled = b; $('barwrap').classList.toggle('on', b); }

  function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {} }
  function loadCache() {
    try { var raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }

  /* Diff vs scan sebelumnya: tandai koin yang naik tahap (tersimpan per device di localStorage). */
  function handleScanResult(res) {
    var prev = loadCache();
    if (prev && prev.results) {
      var prevMap = {};
      prev.results.forEach(function (p) { prevMap[p.symbol] = p.stage; });
      (res.results || []).forEach(function (r) {
        var ps = prevMap[r.symbol];
        if (ps != null && r.stage > ps) { r.rose = true; r.roseBy = r.stage - ps; }
      });
    }
    data = res;
    saveCache(); render();
    $('status').textContent = '';
    setBusy(false);
  }

  function startScan(force) {
    hideErr(); setBusy(true);
    $('bar').style.width = '0%';
    $('status').textContent = 'Ambil daftar simbol…';

    if (force !== true) {
      var cached = loadCache();
      if (cached && Date.now() - cached.scannedAt < TTL) {
        data = cached;
        render(); setBusy(false);
        $('status').textContent = 'Menampilkan hasil cache. Klik Scan ulang untuk data baru.';
        return;
      }
    }

    var opts = {
      onProgress: function (done, total) {
        $('status').textContent = 'Scan… ' + done + '/' + total;
        $('bar').style.width = (done / total * 100).toFixed(1) + '%';
      }
    };

    S.scanAll(opts).then(function (res) {
      res.mode = 'direct';
      handleScanResult(res);
    }).catch(function (eDirect) {
      // Fallback: biarkan server Vercel yang nge-scan (region SG, gak kena blokir lokal).
      $('status').textContent = 'Browser gak bisa akses Binance — coba via server…';
      fetch('./api/scan').then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (res) {
        res.mode = 'server';
        handleScanResult(res);
      }).catch(function (eServer) {
        showErr('Scan gagal. Browser: ' + eDirect.message + ' · Server: ' + eServer.message +
          ' — kalau masih dibuka lokal (file://), deploy dulu ke Vercel supaya fallback server aktif.');
        $('status').textContent = '';
        setBusy(false);
      });
    });
  }

  $('chips').addEventListener('click', function (ev) {
    var b = ev.target.closest('.chip');
    if (!b) return;
    filter = b.getAttribute('data-f');
    renderChips(); render();
  });
  $('search').addEventListener('input', function () { query = this.value; render(); });
  $('rescan').addEventListener('click', function () { startScan(true); });

  renderChips();
  startScan(false);
})();
