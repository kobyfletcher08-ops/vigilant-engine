$ErrorActionPreference = 'Stop'
$repo = $env:GITHUB_REPOSITORY
$tag = 'v0.3.0'
$files = @('VigilantEngine-Native-0.3.0-x64.exe','VigilantEngine-Native-0.3.0-x64.zip','SHA256SUMS.txt','benchmark.json')
foreach ($file in $files) { if (-not (Test-Path "release/$file")) { throw "Missing release asset: $file" } }
$notes = @'
Native Rust rewrite of Vigilant Engine for Windows x64. No Node.js or Electron runtime.

- All 64 DEX Screener catalogue chains, dynamically accepted new API chain IDs and any returned DEX platform.
- Concurrent native fetching, 30-token batches, request coalescing, caching and rate-limit cooldowns.
- Separate authenticated DEX Screener and RPC proxy settings. Rotating market proxies use fresh connections per outgoing fetch.
- BSC / Arbitrum V2 flash-loan execution; Solana standard-SPL Raydium / PumpSwap with atomic Kamino flash loans.
- Local encrypted wallet import, legacy encrypted backup migration, simulation and explicit transaction review.

Download either the EXE or the portable ZIP; the ZIP includes the same EXE and instructions. Microsoft Edge WebView2 Runtime is required and normally installed on Windows 10/11. Keep the adjacent VigilantEngine-Rust-Data folder when updating.

Market coverage does not imply execution on every protocol. Public API rankings cover discovered pools, not an exhaustive global gainers feed. Proxy rotation does not remove API quotas. The existing EVM executor's 2% developer share of positive gross profit is disclosed in the app. No profit or instant blockchain confirmation is guaranteed.

The source was tested with native unit/integration tests and the actual Windows WebView2 application before packaging. See the attached synthetic local-analysis benchmark; it does not measure network refresh speed. No funded transaction was executed during validation. The EXE is unsigned; SHA-256 hashes are attached.
'@
$existing = (gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json) | Where-Object { $_.tag_name -eq $tag }
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing releases' }
if ($existing -and -not $existing.draft) { throw 'A published release already has this tag; refusing to overwrite it' }
if ($existing) { $release = $existing } else {
    @{ tag_name=$tag; target_commitish=$env:GITHUB_SHA; name='Vigilant Engine Native 0.3.0 — Rust Windows'; body=$notes; draft=$true; prerelease=$false } | ConvertTo-Json | Set-Content -Encoding utf8 release/release-request.json
    $release = gh api --method POST "repos/$repo/releases" --input release/release-request.json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the draft release' }
}
foreach ($file in $files) {
    gh release upload $tag "release/$file" --repo $repo --clobber
    if ($LASTEXITCODE -ne 0) { throw "Could not upload $file" }
}
$uploaded = gh api "repos/$repo/releases/$($release.id)" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not verify uploaded release assets' }
foreach ($file in $files) {
    $asset = $uploaded.assets | Where-Object { $_.name -eq $file }
    $local = Get-Item "release/$file"
    $digest = 'sha256:' + (Get-FileHash $local.FullName -Algorithm SHA256).Hash.ToLower()
    if (-not $asset -or $asset.size -ne $local.Length -or $asset.digest -ne $digest) { throw "Uploaded size or SHA-256 mismatch: $file" }
}
@{ draft=$false; make_latest='true'; body=$notes } | ConvertTo-Json | Set-Content -Encoding utf8 release/publish-request.json
gh api --method PATCH "repos/$repo/releases/$($release.id)" --input release/publish-request.json
if ($LASTEXITCODE -ne 0) { throw 'Could not publish the verified release' }
