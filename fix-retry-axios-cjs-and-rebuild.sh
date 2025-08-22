#!/usr/bin/env bash
set -euo pipefail

APP_IMAGE="${APP_IMAGE:-emarknews:fix-rax2}"
RAX_VERSION="${RAX_VERSION:-2.6.0}"

echo "[1/7] retry-axios CJS 버전(${RAX_VERSION})으로 강제 고정"
npm install -E "retry-axios@${RAX_VERSION}"

echo "[2/7] 락/캐시/모듈 정리 후 재생성"
rm -rf node_modules package-lock.json
npm cache verify
npm install
npm dedupe

echo "[3/7] 설치 버전 검증"
npm ls retry-axios || true
INSTALLED="$(node -p "require('./package.json').dependencies['retry-axios'] || ''")"
echo "package.json retry-axios = ${INSTALLED}"
node -e "const v=require('retry-axios/package.json').version; if(!v.startsWith('2.')){process.exit(1)}; console.log('OK retry-axios v'+v)"

echo "[4/7] 변경사항 커밋"
git add package.json package-lock.json || true
git commit -m "fix: pin retry-axios to ${RAX_VERSION} (CJS) to resolve ESM require error" || echo "no changes to commit"

echo "[5/7] Docker 캐시 완전 무효화 빌드(--no-cache)"
# Dockerfile이 루트에 있다고 가정
docker build --no-cache -t "${APP_IMAGE}" .

echo "[6/7] 컨테이너 내 require 테스트"
docker run --rm -it "${APP_IMAGE}" node -e "require('retry-axios'); console.log('require OK')"

echo "[7/7] 앱 부팅 스모크 테스트 (필요시 주석 해제)"
# docker run --rm -p 3000:3000 "${APP_IMAGE}" node server.js

echo "DONE ✅  이제 CI/배포에서 npm ci --omit=dev로 빌드해도 ESM 오류가 사라집니다."

