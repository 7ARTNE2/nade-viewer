[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{4}\.\d{2}\.\d{2}\.\d+$')]
    [string]$Version,

    [string]$Repository = '7ARTNE2/nade-viewer',

    [string]$ManifestRelease = 'library',

    [int]$CompressionLevel = 3,

    [switch]$Publish
)

$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    throw "SourcePath must point to a MessagePack file: $SourcePath"
}
$source = Get-Item -LiteralPath $SourcePath

$zstd = Get-Command zstd -ErrorAction SilentlyContinue

$outputDirectory = $source.Directory.FullName
$compressedPath = Join-Path $outputDirectory 'library.msgpack.zst'
$manifestPath = Join-Path $outputDirectory 'library-manifest.json'
$releaseTag = "data-$Version"
$assetUrl = "https://github.com/$Repository/releases/download/$releaseTag/library.msgpack.zst"

if ($zstd) {
    & $zstd.Source "-$CompressionLevel" '--force' '--no-progress' $source.FullName '-o' $compressedPath
    if ($LASTEXITCODE -ne 0) {
        throw "zstd compression failed with exit code $LASTEXITCODE"
    }
    & $zstd.Source '--test' '--no-progress' $compressedPath
    if ($LASTEXITCODE -ne 0) {
        throw "zstd verification failed with exit code $LASTEXITCODE"
    }
} else {
    & cargo run --quiet --manifest-path "$PSScriptRoot\..\src-tauri\Cargo.toml" --example library-compress -- --input $source.FullName --output $compressedPath --level $CompressionLevel
    if ($LASTEXITCODE -ne 0) {
        throw "Rust Zstd compression failed with exit code $LASTEXITCODE"
    }
}

$compressed = Get-Item -LiteralPath $compressedPath
$manifest = [ordered]@{
    manifest_version = 2
    version = $Version
    format = 'messagepack'
    compression = 'zstd'
    url = $assetUrl
    compressed_size = $compressed.Length
    compressed_sha256 = Get-Sha256 $compressed.FullName
    uncompressed_size = $source.Length
    uncompressed_sha256 = Get-Sha256 $source.FullName
}
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json),
    [System.Text.UTF8Encoding]::new($false)
)

if (-not $Publish) {
    "Prepared $compressedPath and $manifestPath. Run again with -Publish to upload release $releaseTag."
    return
}

& gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) {
    throw 'GitHub CLI is not authenticated. Run gh auth login -h github.com before publishing.'
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& gh release view $releaseTag --repo $Repository 2>$null
$releaseExists = $LASTEXITCODE -eq 0
$ErrorActionPreference = $previousErrorActionPreference
if ($releaseExists) {
    throw "Release $releaseTag already exists. Use a new library version rather than replacing an immutable asset."
}

& gh release create $releaseTag $compressedPath --repo $Repository --title "Library $Version" --notes 'Nade Viewer Zstd MessagePack snapshot'
if ($LASTEXITCODE -ne 0) {
    throw "Unable to create release $releaseTag"
}

& gh release upload $ManifestRelease $manifestPath --repo $Repository --clobber
if ($LASTEXITCODE -ne 0) {
    throw "The data release was created, but updating $ManifestRelease/$([System.IO.Path]::GetFileName($manifestPath)) failed. Re-run gh release upload after resolving the error."
}

"Published $releaseTag and updated $ManifestRelease/library-manifest.json."
