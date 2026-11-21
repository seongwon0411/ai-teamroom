# AI 팀룸 서버 켜기 (본체용) — 본체를 켠 뒤 "팀룸-서버-켜기.bat"을 더블클릭하면 이 파일이 실행됨
#  1) 팀룸 서버(node server.js)를 켬   2) 외부 접속용 터널(cloudflared)을 켬   3) 새 초대 링크를 보여 주고 복사함
# 이 창은 닫아도 서버와 터널은 계속 돌아감 (본체를 끄면 같이 꺼짐)
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$port = 3000
$logDir = Join-Path $root "data"
New-Item -ItemType Directory -Force $logDir | Out-Null
function Ok($t) { Write-Host "  [완료] $t" -ForegroundColor Green }
function Info($t) { Write-Host "  $t" }
function Bad($t) { Write-Host "  [문제] $t" -ForegroundColor Red }
function ServerUp { try { (Invoke-WebRequest "http://localhost:$port/install.html" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }

Write-Host ""
Write-Host "  AI 팀룸 서버 켜기" -ForegroundColor Cyan
Write-Host ""

# ── 1. 팀룸 서버 ──
if (ServerUp) { Ok "팀룸 서버가 이미 켜져 있어요" }
else {
  $node = (Get-Command node).Source
  if (-not $node) { Bad "Node.js를 찾지 못했어요. nodejs.org 에서 설치한 뒤 다시 실행하세요."; Read-Host "Enter를 누르면 닫힙니다"; exit 1 }
  Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Minimized
  foreach ($i in 1..20) { Start-Sleep -Milliseconds 500; if (ServerUp) { break } }
  if (ServerUp) { Ok "팀룸 서버를 켰어요 (작업표시줄에 최소화된 창 — 닫으면 서버가 꺼져요)" }
  else { Bad "팀룸 서버가 켜지지 않았어요."; Read-Host "Enter를 누르면 닫힙니다"; exit 1 }
}

# ── 2. 외부 접속용 터널 ──
$public = $null
$running = Get-CimInstance Win32_Process -Filter "Name like 'cloudflared%'" | Where-Object { $_.CommandLine -like "*localhost:$port*" } | Select-Object -First 1
if ($running) {
  # 이미 켜져 있으면 지난번에 알아 둔 주소가 아직 살아 있는지 확인
  $last = (Get-Content (Join-Path $logDir "public-origin.txt") -Raw).Trim()
  if ($last) { try { if ((Invoke-WebRequest "$last/install.html" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { $public = $last } } catch {} }
  if ($public) { Ok "터널이 이미 켜져 있어요" }
  else { Stop-Process -Id $running.ProcessId -Force; Start-Sleep 1 } # 주소를 알 수 없으면 껐다가 새로 켬
}
if (-not $public) {
  $cf = @(
    (Get-Command cloudflared).Source,
    (Join-Path $root "cloudflared.exe"),
    (Join-Path $env:USERPROFILE "Downloads\cloudflared-windows-amd64.exe"),
    (Join-Path $env:USERPROFILE "Downloads\cloudflared.exe")
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $cf) {
    Bad "터널 프로그램(cloudflared)을 찾지 못했어요."
    Info "cloudflared-windows-amd64.exe 를 '다운로드' 폴더나 이 프로젝트 폴더에 두고 다시 실행하세요."
    Info "(같은 집/같은 와이파이 안에서는 터널 없이 http://localhost:$port 로 쓸 수 있어요)"
    Read-Host "Enter를 누르면 닫힙니다"; exit 1
  }
  $log = Join-Path $logDir "tunnel.log"
  Remove-Item $log -Force
  Start-Process -FilePath $cf -ArgumentList "tunnel", "--url", "http://localhost:$port" -WindowStyle Minimized -RedirectStandardError $log -RedirectStandardOutput (Join-Path $logDir "tunnel-out.log")
  Info "터널을 켜는 중… (10~30초)"
  foreach ($i in 1..80) {
    Start-Sleep -Milliseconds 500
    $m = [regex]::Match((Get-Content $log -Raw), "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($m.Success) { $public = $m.Value; break }
  }
  if (-not $public) { Bad "터널 주소를 받지 못했어요. 인터넷 연결을 확인하고 다시 실행해 보세요. (기록: $log)"; Read-Host "Enter를 누르면 닫힙니다"; exit 1 }
  # 주소가 실제로 열릴 때까지 잠깐 기다림
  foreach ($i in 1..30) { try { if ((Invoke-WebRequest "$public/install.html" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { break } } catch {}; Start-Sleep 1 }
  Ok "터널을 켰어요"
}

# ── 3. 새 초대 링크 ──
# 내가 들어가 있는 방들(팀룸 창 설정에 기억된 방)의 링크를 새 주소로 만들어 보여 줌
$cfg = Get-Content (Join-Path $env:USERPROFILE ".ai-teamroom\connector.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$ids = @()
if ($cfg) { foreach ($u in @($cfg.roomUrl) + @($cfg.rooms | ForEach-Object { $_.roomUrl })) { if ($u -match "room=([\w-]+)") { if ($ids -notcontains $Matches[1]) { $ids += $Matches[1] } } } }
$lines = @()
foreach ($id in $ids) {
  try { $st = (Invoke-WebRequest "http://localhost:$port/api/rooms/$id/state" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json; $lines += "$($st.name): $public/?room=$id" } catch {}
}
Write-Host ""
Write-Host "  새 주소: $public" -ForegroundColor Yellow
Write-Host ""
if ($lines.Count) {
  $msg = "팀룸 주소가 바뀌었어. 팀룸 창 메뉴 [방] → [+ 새 방 만들기 · 초대 링크로 들어가기]에 아래 링크를 붙여넣고 [들어가기]를 눌러 줘. (설정·공유 목록은 그대로 유지돼)`r`n" + ($lines -join "`r`n") + "`r`n처음 설치하는 사람은: $public/install.html?room=$($ids[0])"
  Set-Clipboard -Value $msg
  Write-Host "  팀원에게 보낼 안내를 복사해 뒀어요. 카톡 등에 그대로 붙여넣으면 됩니다:" -ForegroundColor Cyan
  Write-Host ""
  $msg -split "`r`n" | ForEach-Object { Write-Host "    $_" }
} else {
  Info "방 만들기·초대는 여기서: $public/"
}
Write-Host ""
Info "내 PC(본체)의 팀룸 창은 주소가 바뀌어도 그대로 쓰면 됩니다."
Info "이 창은 닫아도 됩니다. (서버·터널은 본체를 끌 때까지 켜져 있어요)"
Write-Host ""
Read-Host "Enter를 누르면 닫힙니다"
