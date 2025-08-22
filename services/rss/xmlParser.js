const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 5000,
  headers: {
    'User-Agent': 'emarknews-bot/1.0 (+https://emarknews.com)'
  }
});

async function parseRssXml(xmlString, options = {}) {
  try {
    const feed = await parser.parseString(xmlString);
    const articles = (feed.items || []).map(item => ({
      title: item.title,
      description: item.contentSnippet || item.description,
      content: item.content || item.description,
      url: item.link,
      urlToImage: item.enclosure?.url || null,
      source: options.source || 'RSS',
      publishedAt: item.pubDate || item.isoDate,
      category: item.categories?.[0] || 'general',
      guid: item.guid || item.link
    }));

    return {
      articles,
      meta: {
        title: feed.title,
        description: feed.description,
        link: feed.link,
        lastBuildDate: feed.lastBuildDate,
        total: articles.length
      }
    };
  } catch (error) {
    console.error('[xml-parser-error]', { error: error.message, source: options.source });
    throw error;
  }
}

module.exports = { parseRssXml };

