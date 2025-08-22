const logger = require('../../utils/logger');

// Fail-open 월드뉴스 핸들러 - 항상 콘텐츠 반환 시도
async function worldHandler(req, res) {
  try {
    // 기존 NewsService 사용 시도
    const NewsService = require('../newsService');
    const newsService = new NewsService();
    
    const result = await newsService.getNews('world', true, 1, 30);
    
    if (result.success && result.data && result.data.articles && result.data.articles.length > 0) {
      return res.json(result);
    }
    
    // 기본 NewsService 실패 시 fallback 데이터 제공
    logger.warn('Primary news service failed, providing fallback content');
    
    const fallbackData = {
      success: true,
      data: {
        articles: [
          {
            title: "EmarkNews Service Status",
            description: "뉴스 서비스가 일시적으로 업데이트 중입니다. 잠시 후 다시 시도해주세요.",
            content: "현재 뉴스 피드를 업데이트하고 있습니다. 서비스가 곧 정상화될 예정입니다.",
            url: "#",
            urlToImage: null,
            source: "EmarkNews",
            publishedAt: new Date().toISOString(),
            language: "ko",
            id: "fallback_status",
            section: "world",
            rating: 3,
            tags: ["시스템"],
            titleKo: "EmarkNews 서비스 상태",
            descriptionKo: "뉴스 서비스가 일시적으로 업데이트 중입니다."
          }
        ],
        total: 1,
        page: 1,
        timestamp: new Date().toISOString(),
        cached: false,
        fallback: true
      }
    };
    
    return res.json(fallbackData);
    
  } catch (error) {
    logger.error('World news handler error:', error);
    
    // 완전 실패 시에도 기본 응답 제공
    const emergencyData = {
      success: true,
      data: {
        articles: [
          {
            title: "Service Temporarily Unavailable",
            description: "뉴스 서비스를 복구 중입니다. 잠시만 기다려주세요.",
            content: "기술팀이 서비스 복구 작업을 진행하고 있습니다.",
            url: "#",
            urlToImage: null,
            source: "EmarkNews",
            publishedAt: new Date().toISOString(),
            language: "ko",
            id: "emergency_status",
            section: "world",
            rating: 2,
            tags: ["긴급"],
            titleKo: "서비스 일시 중단",
            descriptionKo: "뉴스 서비스를 복구 중입니다."
          }
        ],
        total: 1,
        page: 1,
        timestamp: new Date().toISOString(),
        cached: false,
        emergency: true
      }
    };
    
    return res.status(200).json(emergencyData);
  }
}

module.exports = { worldHandler };

