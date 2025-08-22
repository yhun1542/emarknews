#!/usr/bin/env bash
set -euo pipefail

echo "[step1] retry-axios 버전 고정 (CJS 지원 버전)"
npm install -E retry-axios@2

echo "[step2] 기존 node_modules, lockfile 정리"
rm -rf node_modules package-lock.json
npm cache verify

echo "[step3] package-lock.json 재생성"
npm install
npm dedupe

echo "[step4] 변경사항 git 커밋"
git add package.json package-lock.json
git commit -m "fix: pin retry-axios to v2 (CJS) to resolve ESM require error" || echo "no changes to commit"

echo "[done] 이제 Docker 빌드 시 npm ci --omit=dev 정상 동작합니다."

