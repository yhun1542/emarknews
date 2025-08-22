#!/usr/bin/env bash
set -Eeuo pipefail

echo "[fix-npm-cache] start"

# 0) 새 캐시 디렉터리(매 빌드마다 새로)
TMP_CACHE="$(mktemp -d)"
export NPM_CONFIG_CACHE="$TMP_CACHE"

# 1) 오래된 캐시 잠금 제거(있다면)
if [ -d "${HOME}/.npm/_locks" ]; then
  find "${HOME}/.npm/_locks" -type f -mmin +5 -print -delete || true
fi

# 2) 캐시 점검/정리
npm cache verify || true
npm cache clean --force || true

# 3) 워크스페이스 정리
rm -rf node_modules
# package-lock.json이 존재하고 유효한지 빠르게 점검
if ! test -f package-lock.json; then
  echo "[fix-npm-cache] package-lock.json 없음 → 생성"
  npm install --package-lock-only --no-audit --no-fund
fi

# 4) 첫 설치 시도
set +e
npm ci --no-audit --no-fund --loglevel=warn --cache="$NPM_CONFIG_CACHE"
CI_EXIT=$?
set -e

# 5) 실패 시(주로 락/불일치) 재시도 루틴
if [ $CI_EXIT -ne 0 ]; then
  echo "[fix-npm-cache] npm ci 실패 → 재시도 루틴 진입"
  # 혹시 남아있을 수 있는 잠금 제거
  find "$NPM_CONFIG_CACHE/_locks" -type f -print -delete 2>/dev/null || true
  npm cache clean --force || true

  # package.json ↔ lock 불일치 가능성까지 커버
  rm -rf node_modules
  npm install --package-lock-only --no-audit --no-fund
  npm ci --no-audit --no-fund --loglevel=warn --cache="$NPM_CONFIG_CACHE"
fi

echo "[fix-npm-cache] success"

