/*
 * Function /api/scan — fallback kalau browser user gak bisa akses Binance
 * (mis. ISP memblokir). Scan dijalankan di server Vercel region Singapore.
 * Result-nya di-cache di edge Vercel 10 menit biar buka berulang instan.
 */
const scanner = require('../scanner.js');

module.exports = async (req, res) => {
  try {
    const data = await scanner.scanAll({ concurrency: 20 });
    data.mode = 'server';
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Scan gagal di server: ' + e.message });
  }
};
