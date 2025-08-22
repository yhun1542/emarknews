const axios = require('axios');

async function fetchFromNewsAPI(options = {}) {
  const { source, topic, country = 'us', language = 'en' } = options;
  
  if (!process.env.NEWS_API_KEY) {
    console.log('[newsapi-fallback] No API key configured, returning empty array');
    return { articles: [], meta: { total: 0, source: 'NewsAPI-fallback' } };
  }

  try {
    const params = {
      apiKey: process.env.NEWS_API_KEY,
      pageSize: 20,
      sortBy: 'publishedAt'
    };

    let url = 'https://newsapi.org/v2/everything';
    
    if (source) {
      params.sources = source;
    } else if (topic) {
      params.q = topic;
      params.language = language;
    } else {
      // 기본: 헤드라인
      url = 'https://newsapi.org/v2/top-headlines';
      params.country = country;
    }

    const response = await axios.get(url, { params, timeout: 10000 });
    
    const articles = (response.data.articles || []).map(article => ({
      title: article.title,
      description: article.description,
      content: article.content,
      url: article.url,
      urlToImage: article.urlToImage,
      source: article.source?.name || 'NewsAPI',
      publishedAt: article.publishedAt,
      category: 'general'
    }));

    return {
      articles,
      meta: {
        total: response.data.totalResults || articles.length,
        source: 'NewsAPI'
      }
    };
  } catch (error) {
    console.error('[newsapi-error]', { 
      error: error.message, 
      status: error.response?.status,
      source, topic 
    });
    return { articles: [], meta: { total: 0, source: 'NewsAPI-error' } };
  }
}

module.exports = { fetchFromNewsAPI };

