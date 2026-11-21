# AI 팀룸 v2 — 본체에서 클라우드 VM으로 올리기 / 백업 받기
#   클라우드에-올리기.bat   → -Mode upload  (처음 설치와 업데이트 둘 다)
#   클라우드-백업-받기.bat  → -Mode backup  (VM의 방 내용을 본체로 내려받음)
# 한 번 물어본 값(VM 주소·키 파일·도메인)은 cloud-settings.json 에 적어 두고 다음부터는 묻지 않음
param(
  [ValidateSet("upload", "backup")][string]$Mode = "upload",
  [switch]$PackOnly,   # (시험용) 묶음만 만들고 올리지 않음
  [switch]$Reset       # 저장해 둔 값을 무시하고 다시 물어봄
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$v2 = Split-Path -Parent $here
$settingsFile = Join-Path $here "cloud-settings.json"
$ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
$scp = Join-Path $env:WINDIR "System32\OpenSSH\scp.exe"
$tar = Join-Path $env:WINDIR "System32\tar.exe"

function Say($text) { Write-Host ""; Write-Host "▶ $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "✗ $text" -ForegroundColor Red; exit 1 }
function Ask($question, $default) {
  $hint = ""
  if ($default) { $hint = " [$default]" }
  $answer = Read-Host "$question$hint"
  if (-not $answer) { return $default }
  return $answer.Trim().Trim('"')
}

# ───────── 설정 (처음 한 번만 물어봄) ─────────
function Get-Settings {
  $s = $null
  if ((Test-Path $settingsFile) -and -not $Reset) { try { $s = Get-Content $settingsFile -Raw | ConvertFrom-Json } catch {} }
  if ($s -and $s.ip -and $s.key -and $s.domain -and (Test-Path $s.key)) { return $s }

  Write-Host "클라우드 VM 정보를 한 번만 알려 주세요. (cloud\cloud-settings.json 에 저장돼요)" -ForegroundColor Yellow
  $ip = Ask "① VM의 공인 IP 주소 (오라클 콘솔의 Public IP)" $null
  if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Fail "IP 주소 형식이 아니에요: $ip" }
  $keySource = Ask "② VM을 만들 때 받은 개인 키 파일 (.key 파일을 이 창에 끌어다 놓고 Enter)" $null
  if (-not $keySource -or -not (Test-Path $keySource)) { Fail "키 파일을 찾을 수 없어요: $keySource" }
  $user = Ask "③ VM 사용자 이름" "ubuntu"
  $auto = ($ip -replace '\.', '-') + ".sslip.io"
  Write-Host "④ 도메인: 갖고 있는 도메인이 있으면 입력하세요 (미리 이 IP로 연결해 둔 것)."
  Write-Host "   없으면 그냥 Enter → 무료 주소 $auto 를 씁니다."
  $domain = Ask "   도메인" $auto

  # ssh는 다른 사용자도 읽을 수 있는 키 파일을 거부함 → 내 계정만 읽을 수 있는 사본을 만들어 씀 (원본은 그대로)
  $sshDir = Join-Path $env:USERPROFILE ".ssh"
  New-Item -ItemType Directory -Force $sshDir | Out-Null
  $key = Join-Path $sshDir "teamroom-cloud.key"
  if (Test-Path $key) { & icacls $key /grant "${env:USERNAME}:F" | Out-Null; Remove-Item $key -Force }
  Copy-Item $keySource $key
  & icacls $key /inheritance:r /grant:r "${env:USERNAME}:R" | Out-Null

  $s = [pscustomobject]@{ ip = $ip; user = $user; key = $key; domain = $domain.ToLower() }
  $s | ConvertTo-Json | Set-Content $settingsFile -Encoding UTF8
  return $s
}

function Remote($s, $command) {
  & $ssh -i $s.key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30 "$($s.user)@$($s.ip)" $command
  if ($LASTEXITCODE -ne 0) { Fail "VM에서 명령이 실패했어요 (코드 $LASTEXITCODE)" }
}
function Send($s, $file, $target) {
  & $scp -i $s.key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 $file "$($s.user)@$($s.ip):$target"
  if ($LASTEXITCODE -ne 0) { Fail "VM으로 파일을 보내지 못했어요. IP 주소·키 파일·오라클 보안 목록(22번 포트)을 확인하세요" }
}

# ───────── 묶음 만들기 ─────────
function New-Bundle($includeData) {
  Say "서버 파일 묶는 중"
  $stage = Join-Path $env:TEMP ("teamroom-bundle-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force $stage | Out-Null
  Copy-Item (Join-Path $v2 "server.js") $stage
  Copy-Item (Join-Path $here "package.json") $stage
  Copy-Item (Join-Path $v2 "public") $stage -Recurse
  New-Item -ItemType Directory -Force (Join-Path $stage "connector") | Out-Null
  Copy-Item (Join-Path $v2 "connector\teamroom-connector.mjs") (Join-Path $stage "connector")
  # (한글 파일 이름은 묶을 때 깨질 수 있어 영문 이름으로 넣고, VM에서 원래 이름으로 되돌림)
  $exe = Join-Path $v2 "connector\AI팀룸v2.exe"
  if (Test-Path $exe) { Copy-Item $exe (Join-Path $stage "connector\teamroom-v2.exe") }
  else { Write-Host "  (AI팀룸v2.exe 가 없어 설치 안내 페이지에서 앱을 내려받을 수 없게 됩니다)" -ForegroundColor Yellow }
  if ($includeData) {
    $data = Join-Path $v2 "data"
    if (Test-Path $data) {
      Copy-Item $data $stage -Recurse
      # 본체에서만 쓰는 것(터널 기록·임시 주소)은 뺌. 방 만들기 비밀번호는 VM에서 새로 만듦
      Get-ChildItem (Join-Path $stage "data") -File | Where-Object { $_.Name -like "*.log" -or $_.Name -eq "public-origin.txt" -or $_.Name -eq "create-password.txt" } | Remove-Item -Force
    }
  }
  $bundle = Join-Path $env:TEMP "teamroom-bundle.tar.gz"
  if (Test-Path $bundle) { Remove-Item $bundle -Force }
  & $tar -czf $bundle -C $stage .
  if ($LASTEXITCODE -ne 0) { Fail "묶음을 만들지 못했어요" }
  Remove-Item $stage -Recurse -Force
  Write-Host ("  " + [math]::Round((Get-Item $bundle).Length / 1MB, 1) + " MB")
  return $bundle
}

foreach ($tool in @($ssh, $scp, $tar)) { if (-not (Test-Path $tool)) { Fail "윈도우 기본 도구가 없어요: $tool (설정 → 앱 → 선택적 기능에서 'OpenSSH 클라이언트'를 추가하세요)" } }

if ($Mode -eq "upload") {
  if ($PackOnly) { $b = New-Bundle $true; Write-Host $b; exit 0 }
  $s = Get-Settings
  Write-Host ""
  Write-Host "본체의 방 내용(대화·문서·작업 현황)도 VM으로 옮길까요?"
  Write-Host "  · VM에 이미 방 내용이 있으면 덮어쓰지 않습니다 (처음 올릴 때만 옮겨져요)."
  $move = Ask "  옮기려면 Enter, 빈 서버로 시작하려면 n" "y"
  $bundle = New-Bundle ($move -notmatch '^[nN]')

  Say "VM으로 보내는 중 ($($s.ip))"
  Send $s $bundle "/tmp/teamroom-bundle.tar.gz"
  Send $s (Join-Path $here "install.sh") "/tmp/teamroom-install.sh"
  Remove-Item $bundle -Force

  Say "VM에서 설치하는 중 (처음에는 몇 분 걸려요)"
  Remote $s "sed -i 's/\r`$//' /tmp/teamroom-install.sh && sudo bash /tmp/teamroom-install.sh '$($s.domain)' /tmp/teamroom-bundle.tar.gz && rm -f /tmp/teamroom-bundle.tar.gz /tmp/teamroom-install.sh"

  Write-Host ""
  Write-Host "끝났습니다. 이제 할 일:" -ForegroundColor Green
  Write-Host "  1. 브라우저에서 https://$($s.domain) 이 열리는지 확인"
  Write-Host "  2. 팀룸 창 메뉴 [방] → '초대 링크로 들어가기'에 새 주소의 링크를 넣기"
  Write-Host "     (예전 방은 방 ID가 같아요:  https://$($s.domain)/?room=방ID )"
  Write-Host "  3. 팀원에게 새 링크 전달 — 이제 주소는 바뀌지 않습니다"
  Write-Host "  4. 본체의 '팀룸v2-서버-켜기.bat'은 더 이상 켜지 않아도 됩니다"
}

if ($Mode -eq "backup") {
  $s = Get-Settings
  $dir = Join-Path $here "backups"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $name = "teamroom-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".tar.gz"
  Say "VM에서 백업 만드는 중"
  Remote $s "sudo tar -czf /tmp/$name -C /opt/teamroom data && sudo chown `$(id -un) /tmp/$name && chmod 600 /tmp/$name"
  Say "내려받는 중"
  & $scp -i $s.key -o StrictHostKeyChecking=accept-new "$($s.user)@$($s.ip):/tmp/$name" (Join-Path $dir $name)
  if ($LASTEXITCODE -ne 0) { Fail "백업을 내려받지 못했어요" }
  Remote $s "rm -f /tmp/$name"
  # 본체에는 최근 10개만 둠
  Get-ChildItem $dir -Filter "teamroom-*.tar.gz" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force
  Write-Host ""
  Write-Host "백업 완료: $(Join-Path $dir $name)" -ForegroundColor Green
  Write-Host "  (방 내용과 비밀번호 정보가 들어 있으니 다른 사람에게 주지 마세요)"
}
