const { fetchWithRetry, logAxiosError } = require('./httpClient');
// 사용 중인 파서/정규화 모듈 불러오기 가정
const { parseRssXml } = require('./xmlParser'); // 프로젝트에 맞게 교체
const { fetchFromNewsAPI } = require('./newsapi'); // 최후 페일백(이미 구현돼 있다면 사용)

const FALLBACKS_WORLD = [
  // 1순위: 기존
  'https://feeds.reuters.com/reuters/worldNews',
  // 2순위: 대체 경로(변경될 수 있으니 운영 중 확인)
  'https://www.reuters.com/markets/world/rss'
];

async function fetchReutersWorld() {
  let lastErr;
  for (const url of FALLBACKS_WORLD) {
    try {
      const res = await fetchWithRetry(url, 3);
      const xml = res?.data;
      if (!xml) continue;
      return parseRssXml(xml, { source: 'Reuters' });
    } catch (e) {
      lastErr = e;
      logAxiosError(e, { source: 'Reuters', url });
      // ENOTFOUND/네트워크 계열은 다음 후보로 페일오버
      if (!['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT'].includes(e?.code)) {
        // 다른 유형이면 중단
        break;
      }
    }
  }
  // 최후: NewsAPI/GNews 등으로 백업 (키가 없으면 빈 배열 반환)
  try {
    return await fetchFromNewsAPI({ source: 'reuters', topic: 'world' });
  } catch (e) {
    logAxiosError(e, { source: 'Reuters', stage: 'final-fallback' });
    throw lastErr || e;
  }
}

module.exports = { fetchReutersWorld };

