const { fetchWithRetry, logAxiosError } = require('./httpClient');
const { parseRssXml } = require('./xmlParser');

const CNN_WORLD = [
  'http://rss.cnn.com/rss/edition_world.rss',
  // 필요 시 대체 피드 추가
];

async function fetchCnnWorld() {
  let lastErr;
  for (const url of CNN_WORLD) {
    try {
      const res = await fetchWithRetry(url, 3);
      const xml = res?.data;
      if (!xml) continue;
      return parseRssXml(xml, { source: 'CNN' });
    } catch (e) {
      lastErr = e;
      logAxiosError(e, { source: 'CNN', url });
      // 네트워크 계열이면 다음 후보로
      if (!['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT'].includes(e?.code)) break;
    }
  }
  throw lastErr || new Error('CNN world feed unavailable');
}

module.exports = { fetchCnnWorld };

