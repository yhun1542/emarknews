// services/rss/httpClient.js
const http = require('http');
const https = require('https');
const axios = require('axios');

const agentHttp  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });

const client = axios.create({
  timeout: Number(process.env.RSS_TIMEOUT_MS ?? 10000),
  maxRedirects: 5,
  httpAgent: agentHttp,
  httpsAgent: agentHttps,
  headers: {
    'user-agent': process.env.RSS_USER_AGENT ?? 'emarknews-bot/1.0 (+https://emarknews.com)'
  },
  responseType: 'text',
  validateStatus: (s) => s >= 200 && s < 400,
});

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await client.get(url);
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(2000 * (2 ** i), 10000);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function logAxiosError(err, ctx = {}) {
  const { code, errno, syscall, hostname, message } = err || {};
  console.error('[rss-error]', { code, errno, syscall, hostname, message, ...ctx });
}

module.exports = { client, fetchWithRetry, logAxiosError };
