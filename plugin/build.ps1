# Zoom Flips - RuneLite Plugin Builder
# Auto-downloads Gradle, detects Java, then builds the JAR.

$ErrorActionPreference = "Continue"

# Auto-locate Java 17+ in common install paths
$roots = @(
    "C:\Program Files\Eclipse Adoptium",
    "C:\Program Files\Microsoft",
    "C:\Program Files\Java",
    "C:\Program Files\BellSoft",
    "C:\Program Files\Amazon Corretto"
)
foreach ($root in $roots) {
    if (Test-Path $root) {
        $found = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "jdk-1[1-9]|jdk-2[0-9]|jdk1[1-9]" } |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if ($found) {
            $env:JAVA_HOME = $found.FullName
            $env:PATH = $env:JAVA_HOME + "\bin;" + $env:PATH
            break
        }
    }
}

$GradleVersion  = "8.9"
$GradleZipUrl   = "https://services.gradle.org/distributions/gradle-" + $GradleVersion + "-bin.zip"
$GradleLocalDir = Join-Path $PSScriptRoot ".gradle-dist"
$GradleBin      = Join-Path $GradleLocalDir ("gradle-" + $GradleVersion + "\bin\gradle.bat")

# Check Java
Write-Host ""
Write-Host "==> Checking Java version..." -ForegroundColor Cyan

$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if (-not $javaCmd) {
    Write-Host "  ERROR: Java not found. Install Java 17 from:" -ForegroundColor Red
    Write-Host "  https://adoptium.net/temurin/releases/?version=17" -ForegroundColor Yellow
    Write-Host "  Then re-open PowerShell and run this script again." -ForegroundColor Yellow
    exit 1
}

$javaOut = (& java -version 2>&1) | Out-String
$firstLine = ($javaOut -split "`n")[0].Trim()
Write-Host "    $firstLine"

$major = 0
if ($javaOut -match 'version "1\.(\d+)') {
    $major = [int]$Matches[1]
} elseif ($javaOut -match 'version "(\d+)') {
    $major = [int]$Matches[1]
}

if ($major -gt 0 -and $major -lt 11) {
    Write-Host "  ERROR: Java $major is too old. Need Java 11+. Install Java 17:" -ForegroundColor Red
    Write-Host "  https://adoptium.net/temurin/releases/?version=17" -ForegroundColor Yellow
    exit 1
}
Write-Host "    Java OK (version $major)." -ForegroundColor Green

# Download Gradle if needed
if (-not (Test-Path $GradleBin)) {
    Write-Host ""
    Write-Host "==> Downloading Gradle $GradleVersion (one-time, ~120MB)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $GradleLocalDir | Out-Null
    $zipPath = Join-Path $GradleLocalDir ("gradle-" + $GradleVersion + "-bin.zip")
    try {
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($GradleZipUrl, $zipPath)
        Write-Host "    Downloaded. Extracting..." -ForegroundColor Green
        Expand-Archive -Path $zipPath -DestinationPath $GradleLocalDir -Force
        Remove-Item $zipPath
        Write-Host "    Gradle ready." -ForegroundColor Green
    } catch {
        Write-Host "  ERROR downloading Gradle: $_" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "==> Gradle $GradleVersion already present." -ForegroundColor Green
}

# Build
Write-Host ""
Write-Host "==> Building plugin JAR..." -ForegroundColor Cyan
Write-Host ""
Set-Location $PSScriptRoot

& $GradleBin clean build 2>&1 | ForEach-Object { Write-Host "  $_" }

if ($LASTEXITCODE -eq 0) {
    $jar = Get-ChildItem (Join-Path $PSScriptRoot "build\libs\*.jar") -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host "  BUILD SUCCESSFUL!" -ForegroundColor Green
    if ($jar) {
        Write-Host ""
        Write-Host "  JAR file:" -ForegroundColor Yellow
        Write-Host "  $($jar.FullName)" -ForegroundColor White
    }
    Write-Host ""
    Write-Host "  To install in RuneLite:" -ForegroundColor Yellow
    Write-Host "  1. Start RuneLite with --developer-mode flag" -ForegroundColor White
    Write-Host "  2. Configuration -> Plugin Hub -> Load local plugin" -ForegroundColor White
    Write-Host "  3. Select the JAR file shown above" -ForegroundColor White
    Write-Host "==========================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  BUILD FAILED. Check errors above." -ForegroundColor Red
    exit 1
}
