const { fetchWithRetry, logAxiosError } = require('./httpClient');
const Parser = require('rss-parser');

const parser = new Parser();

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
      
      const feed = await parser.parseString(xml);
      if (feed?.items?.length) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        return feed.items
          .map(item => {
            const publishedDate = new Date(item.isoDate || item.pubDate || new Date().toISOString());
            
            // 30일 이내 뉴스만 포함
            if (isNaN(publishedDate.getTime()) || publishedDate < thirtyDaysAgo) {
              return null;
            }
            
            return {
              title: item.title,
              link: item.link,
              source: 'Reuters',
              description: item.contentSnippet || item.content || '',
              publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
            };
          })
          .filter(item => item !== null); // null 값 필터링
      }
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
  
  // 모든 URL 실패 시 빈 배열 반환
  return [];
}

module.exports = { fetchReutersWorld };

