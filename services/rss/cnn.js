const { fetchWithRetry, logAxiosError } = require('./httpClient');
const Parser = require('rss-parser');

const parser = new Parser();

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
              source: 'CNN',
              description: item.contentSnippet || item.content || '',
              publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
            };
          })
          .filter(item => item !== null); // null 값 필터링
      }
    } catch (e) {
      lastErr = e;
      logAxiosError(e, { source: 'CNN', url });
      // 네트워크 계열이면 다음 후보로
      if (!['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT'].includes(e?.code)) break;
    }
  }
  
  // 모든 URL 실패 시 빈 배열 반환
  return [];
}

module.exports = { fetchCnnWorld };

