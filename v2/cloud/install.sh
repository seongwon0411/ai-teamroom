#!/usr/bin/env bash
# AI 팀룸 v2 — 클라우드 VM(Ubuntu) 설치·업데이트 스크립트
#
# 본체의 "클라우드에-올리기.bat"이 이 파일과 서버 묶음을 VM에 올린 뒤 실행합니다. 직접 실행할 때:
#   sudo bash install.sh <도메인> <묶음.tar.gz>
#
# 하는 일 (여러 번 실행해도 안전 — 두 번째부터는 "업데이트"):
#   1. Node.js · Caddy(HTTPS) 설치
#   2. 서버 파일을 /opt/teamroom 에 풀기 (data 폴더는 이미 있으면 건드리지 않음)
#   3. 방 만들기 비밀번호 만들기 (처음 한 번)
#   4. 서버를 "자동 시작 서비스"로 등록 (VM이 재부팅돼도 저절로 켜짐)
#   5. HTTPS 프록시 설정 + 방화벽 80·443 열기
#   6. 매일 새벽 data 폴더 백업 (14일치 보관)
set -euo pipefail

DOMAIN="${1:-}"
BUNDLE="${2:-}"
APP=/opt/teamroom
DATA=$APP/data
BACKUPS=/var/backups/teamroom
RUN_USER=teamroom
PORT=3100

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "sudo 로 실행하세요: sudo bash install.sh <도메인> <묶음.tar.gz>"
[ -n "$DOMAIN" ] || die "도메인이 필요합니다"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "도메인 형식이 이상합니다: $DOMAIN"
[ -f "$BUNDLE" ] || die "서버 묶음 파일이 없습니다: $BUNDLE"
command -v apt-get >/dev/null || die "Ubuntu/Debian 계열 VM에서만 동작합니다"
command -v systemctl >/dev/null || die "systemd 가 필요합니다"
export DEBIAN_FRONTEND=noninteractive

# ───────── 1. 프로그램 설치 ─────────
say "기본 도구 설치"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg tar openssl cron >/dev/null

NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)
if [ -z "${NODE_MAJOR:-}" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  say "Node.js 22 설치"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node -v)"

if ! command -v caddy >/dev/null; then
  say "Caddy(HTTPS 프록시) 설치"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
echo "$(caddy version | head -1)"

# 스왑(디스크를 예비 메모리로): 메모리가 작은 VM에서 서버가 메모리 부족으로 죽지 않게 함 (이미 있으면 건너뜀)
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ "$(df --output=avail -BG / | tail -1 | tr -dc 0-9)" -ge 6 ]; then
  say "스왑 2GB 만들기"
  [ -f /swapfile ] || { fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; }
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-teamroom-swap.conf
  sysctl -q -p /etc/sysctl.d/99-teamroom-swap.conf || true
fi

# ───────── 2. 서버 파일 ─────────
say "서버 파일 설치 → $APP"
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin "$RUN_USER"
systemctl stop teamroom 2>/dev/null || true

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$BUNDLE" -C "$STAGE"
[ -f "$STAGE/server.js" ] && [ -f "$STAGE/package.json" ] || die "묶음 안에 server.js · package.json 이 없습니다"

mkdir -p "$APP" "$BACKUPS"
# 프로그램 파일은 새것으로 바꿈 (data 는 아래에서 따로)
rm -rf "$APP/public" "$APP/connector"
cp -a "$STAGE/server.js" "$STAGE/package.json" "$APP/"
cp -a "$STAGE/public" "$APP/"
if [ -d "$STAGE/connector" ]; then
  cp -a "$STAGE/connector" "$APP/"
  # (한글 파일 이름은 윈도우에서 묶을 때 깨질 수 있어 영문 이름으로 올린 뒤 여기서 되돌림 — 설치 안내 페이지가 이 이름으로 내려 줌)
  [ -f "$APP/connector/teamroom-v2.exe" ] && mv -f "$APP/connector/teamroom-v2.exe" "$APP/connector/AI팀룸v2.exe"
fi

# 방 내용(data): VM에 이미 있으면 그대로 두고, 처음일 때만 본체에서 가져온 것을 넣음
if [ -d "$DATA" ] && ls "$DATA"/*.json >/dev/null 2>&1; then
  echo "기존 방 내용(data)은 그대로 둡니다"
  [ -d "$STAGE/data" ] && echo "  (본체에서 온 data 는 쓰지 않았어요 — 덮어쓰려면 VM의 $DATA 를 지운 뒤 다시 올리세요)"
elif [ -d "$STAGE/data" ]; then
  mkdir -p "$DATA"
  cp -a "$STAGE/data/." "$DATA/"
  echo "본체의 방 내용을 옮겼습니다 ($(ls "$DATA"/*.json 2>/dev/null | wc -l)개 방)"
else
  mkdir -p "$DATA"
fi
rm -f "$DATA/public-origin.txt" # (예전 임시 주소 — 이제 고정 주소를 씀)

say "서버 부품 설치 (npm)"
(cd "$APP" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# ───────── 3. 방 만들기 비밀번호 ─────────
NEW_PASSWORD=""
if [ ! -s "$DATA/create-password.txt" ]; then
  NEW_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)
  printf '%s\n' "$NEW_PASSWORD" > "$DATA/create-password.txt"
fi

chown -R "$RUN_USER:$RUN_USER" "$APP" "$BACKUPS"
chmod 700 "$DATA"
chmod 600 "$DATA/create-password.txt"
[ -f "$DATA/secret.key" ] && chmod 600 "$DATA/secret.key"

# ───────── 4. 자동 시작 서비스 ─────────
say "자동 시작 서비스 등록"
cat > /etc/systemd/system/teamroom.service <<EOF
[Unit]
Description=AI Teamroom v2
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP
ExecStart=$(command -v node) --max-old-space-size=400 server.js
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=PUBLIC_URL=https://$DOMAIN
Restart=always
RestartSec=3
# 서버가 건드릴 수 있는 곳을 data 폴더로 제한
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q teamroom
systemctl restart teamroom

# ───────── 5. HTTPS 프록시 + 방화벽 ─────────
say "HTTPS 설정 ($DOMAIN)"
cat > /etc/caddy/Caddyfile <<EOF
# AI 팀룸 v2 — install.sh 가 만든 파일 (인증서는 Caddy가 자동으로 받고 갱신함)
$DOMAIN {
	encode gzip
	# (접속한 곳의 주소는 Caddy가 직접 알려 줌 — 밖에서 꾸며 보낸 값은 버림)
	request_header -CF-Connecting-IP
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddy 설정이 올바르지 않습니다 (도메인을 확인하세요)"
systemctl enable -q caddy
systemctl restart caddy

# 오라클 Ubuntu 이미지는 VM 안의 방화벽(iptables)도 80·443을 막아 둠 → 열고 재부팅 뒤에도 유지
if command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true
  elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4; fi
fi
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

# ───────── 6. 매일 백업 ─────────
say "매일 백업 등록 (새벽 4시, 14일치)"
cat > /usr/local/bin/teamroom-backup <<EOF
#!/usr/bin/env bash
# data 폴더(방 내용·올린 파일·비밀번호 정보)를 묶어서 보관
set -e
tar -czf "$BACKUPS/teamroom-\$(date +%Y%m%d-%H%M%S).tar.gz" -C "$APP" data
ls -1t "$BACKUPS"/teamroom-*.tar.gz | tail -n +15 | xargs -r rm -f
EOF
chmod 755 /usr/local/bin/teamroom-backup
printf '0 4 * * * root /usr/local/bin/teamroom-backup\n' > /etc/cron.d/teamroom-backup
chmod 644 /etc/cron.d/teamroom-backup
chmod 700 "$BACKUPS"

# ───────── 확인 ─────────
say "확인"
OK=""
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
[ -n "$OK" ] || { journalctl -u teamroom -n 30 --no-pager || true; die "서버가 켜지지 않았습니다 (위 기록 참고)"; }
echo "✓ 서버 실행 중"

HTTPS=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/info" >/dev/null 2>&1; then HTTPS=1; break; fi
  sleep 2
done

echo
echo "════════════════════════════════════════════"
if [ -n "$HTTPS" ]; then
  echo " ✓ 팀룸 주소:  https://$DOMAIN"
else
  echo " ! 서버는 켜졌지만 https://$DOMAIN 으로는 아직 열리지 않습니다. 확인할 것:"
  echo "    1) 도메인이 이 VM의 공인 IP를 가리키는지"
  echo "    2) 오라클 콘솔의 보안 목록(Security List)에서 80·443 포트를 열었는지"
  echo "    기록 보기: sudo journalctl -u caddy -n 50"
fi
if [ -n "$NEW_PASSWORD" ]; then
  echo
  echo " 방 만들기 비밀번호:  $NEW_PASSWORD"
  echo "   (새 방을 만들 때만 씁니다. 지금 적어 두세요 — 다시 보려면: sudo cat $DATA/create-password.txt)"
fi
echo "════════════════════════════════════════════"
echo " 상태 보기   sudo systemctl status teamroom"
echo " 기록 보기   sudo journalctl -u teamroom -f"
echo " 지금 백업   sudo teamroom-backup   →  $BACKUPS"
