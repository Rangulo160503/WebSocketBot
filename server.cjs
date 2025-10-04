// server.cjs
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// ✅ Tu API KEY y SECRET de Binance (NO las compartás nunca)
const API_KEY = "L8n5PunmZsageDONR4bHctMyQuFCyV22dAngeZwYX0h4YbCkkxgVnsvEJDoA7Ke7";
const API_SECRET = "EKrVpQzfEdD3Mj3t2TL78NuINEVfXzRZ59ptyMIc3kvQue2sWmdsy8erXzHoVfnN";

if (!API_KEY || !API_SECRET) {
  console.error('❌ Faltan API_KEY / API_SECRET en .env');
  process.exit(1);
}

app.use(cors({ origin: ['http://localhost:5173','http://127.0.0.1:5173'], methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());

// logger y healthcheck
app.use((req, _res, next) => { console.log('➡️', req.method, req.url); next(); });
app.get('/ping', (_req, res) => res.json({ ok: true }));

function signQuery(params) {
  const qs = new URLSearchParams(params).toString();
  const sig = CryptoJS.HmacSHA256(qs, API_SECRET).toString(CryptoJS.enc.Hex);
  return `${qs}&signature=${sig}`;
}

// GET /balance
app.get('/balance', async (_req, res) => {
  try {
    const qs = signQuery({ timestamp: Date.now(), recvWindow: 5000 });

    const r = await axios.get(`https://api.binance.com/api/v3/account?${qs}`, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });

    // 1) DEBUG: ver exactamente qué llega
    console.log('[BINANCE /account balances]:',
      (r.data?.balances || []).slice(0, 10) // muestra primeros 10 en consola
    );

    // 2) Tomar balances sin filtrar y convertir a número
    const raw = r.data?.balances || [];
    const norm = raw.map(b => ({
      asset: b.asset,
      free: parseFloat(b.free || '0'),
      locked: parseFloat(b.locked || '0'),
    }));

    // 3) Extraer explícitamente USDT y BTC (lo que usa tu UI)
    const usdt = norm.find(b => b.asset === 'USDT') || { asset: 'USDT', free: 0, locked: 0 };
    const btc  = norm.find(b => b.asset === 'BTC')  || { asset: 'BTC',  free: 0, locked: 0 };

    res.json({
      ok: true,
      balances: norm,     // lista completa (útil para depurar)
      spot: { usdt, btc } // atajo para el frontend
    });

  } catch (e) {
    console.error('[BINANCE /balance ERROR]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});


// POST /order
app.post('/order', async (req, res) => {
  try {
    const { symbol, side, quantity, type = 'MARKET', price } = req.body || {};
    if (!symbol || !side || !quantity) return res.status(400).json({ error: 'symbol, side, quantity son requeridos' });

    const base = { symbol, side, type, quantity, timestamp: Date.now(), recvWindow: 5000 };
    if (type === 'LIMIT') { if (!price) return res.status(400).json({ error: 'price requerido para LIMIT' }); base.price = price; base.timeInForce = 'GTC'; }

    const url = `https://api.binance.com/api/v3/order?${signQuery(base)}`;
    const r = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': API_KEY } });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// 404 debug
app.use((req, res) => res.status(404).json({ error: 'Not Found', path: req.path }));

app.listen(PORT, () => console.log(`🚀 Server backend corriendo en http://localhost:${PORT}`));