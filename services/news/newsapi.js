// services/news/newsapi.js
const axios = require('axios');

function normalize(item) {
  return {
    title: item.title,
    link: item.url,
    source: item.source?.name || 'NewsAPI',
    description: item.description || '',
    publishedAt: item.publishedAt || new Date().toISOString(),
    image: item.urlToImage || null,
  };
}

async function fetchFromNewsAPI({ topic = 'world', pageSize = 30, language = 'en' } = {}) {
  const key = process.env.NEWSAPI_KEY;
  if (!key) throw new Error('NEWSAPI_KEY not set');
  // 세계 섹션 대체: 글로벌 일반 헤드라인 + 주요 소스 우선
  const url = 'https://newsapi.org/v2/top-headlines';
  const params = {
    language,
    pageSize,
    // sources 예시: 가용성에 따라 조정 가능
    sources: 'bbc-news,reuters,associated-press,al-jazeera-english',
  };
  const res = await axios.get(url, { params, headers: { 'X-Api-Key': key } });
  if (res.data?.status !== 'ok') throw new Error('NewsAPI error');
  return (res.data.articles || []).map(normalize);
}

module.exports = { fetchFromNewsAPI };
