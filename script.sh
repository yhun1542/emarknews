#!/bin/bash

# 1. server.js 백업 및 수정
# - rateLimit에 validate 추가 (X-Forwarded-For 검증 비활성)
# - 중복 /health 제거 (두 번째 단순 버전 삭제)
cp server.js server.js.bak
sed -i '/const limiter = rateLimit({/a\  validate: { xForwardedForHeader: false },' server.js
sed -i '/\/\/ 3) 헬스체크 (간단 버전)/,/};/d' server.js  # 중복 헬스 체크 제거

# 2. RSS URL 테스트 스크립트 생성 및 실행 (재시도 로직 포함, Reuters 대체 URL 사용)
cat << EOF > test-rss.js
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
      console.log(\`Success: \${url} - Status: \${res.status}\`);
      return;
    } catch (err) {
      console.log(\`Retry \${i+1} failed for \${url}: \${err.message}\`);
    }
  }
  console.error(\`Failed after retries: \${url}\`);
}

Promise.all(urls.map(url => testFetch(url)));
EOF

node test-rss.js

# 3. 수동 수정 지침 출력 (NewsService RSS URL 업데이트)
echo "스크립트 실행 완료. server.js 수정됨 (validate 추가, 중복 헬스 제거)."
echo "RSS 대체: ./services/newsService.js (또는 RSS 정의 파일)에서 Reuters URL을 'https://ftr.fivefilters.org/makefulltextfeed.php?url=https%3A%2F%2Fwww.reuters.com%2Fworld&max=10'로 변경하세요."
echo "CNN TLS 문제: test-rss.js 결과 확인. 실패 시, NewsService에 axios 옵션 추가 (timeout: 10000, httpsAgent: new https.Agent({ rejectUnauthorized: false })) – 보안 주의."
echo "Railway 재배포: git commit/push 후, 대시보드에서 TRUST_PROXY=1 확인. SIGTERM은 오류 throw 방지로 해결될 것임."
echo "추천: NewsService getNews()에 try-catch와 재시도 로직 추가 (위 test-rss.js처럼)."