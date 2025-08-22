const axios = require('axios');
const urls = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',  // BBC
  'https://rss.cnn.com/rss/edition_world.rss',    // CNN (안정적 버전)
  'https://ftr.fivefilters.org/makefulltextfeed.php?url=https%3A%2F%2Fwww.reuters.com%2Fworld&max=10',  // Reuters 대체
  'https://www.aljazeera.com/xml/rss/all.xml',    // Al Jazeera
  'https://www.yna.co.kr/rss/news.xml',           // Yonhap
  'https://rss.hankyung.com/news/economy.xml',    // Hankyung
  'http://www.khan.co.kr/rss/rssdata/total_news.xml'  // Kyunghyang
];

async function testFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { timeout: 10000 });  // 타임아웃 증가 (TLS 문제 대비)
      console.log(`Success: ${url} - Status: ${res.status}`);
      return;
    } catch (err) {
      console.log(`Retry ${i+1} failed for ${url}: ${err.message}`);
    }
  }
  console.error(`Failed after retries: ${url}`);
}

Promise.all(urls.map(url => testFetch(url)));
