# Figma Bridge installer for Windows.
#
#   irm https://raw.githubusercontent.com/nextster/figma-bridge/main/install.ps1 | iex
#
# Pass a command or options through a script block:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nextster/figma-bridge/main/install.ps1))) uninstall
#
# The body runs in its own scope so `iex` neither leaks variables into the
# caller's session nor closes the window on failure.
& {
  Set-StrictMode -Version 3.0
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repository = if ($env:FIGMA_BRIDGE_REPOSITORY) { $env:FIGMA_BRIDGE_REPOSITORY } else { 'nextster/figma-bridge' }
  $ref = if ($env:FIGMA_BRIDGE_REF) { $env:FIGMA_BRIDGE_REF } else { 'main' }
  $sourceDir = $env:FIGMA_BRIDGE_SOURCE_DIR
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  $stateDir = if ($env:FIGMA_BRIDGE_STATE_DIR) { $env:FIGMA_BRIDGE_STATE_DIR } else { Join-Path $userProfile '.figma-bridge' }
  $nodeVersion = '24.19.0'
  # Official v24.19.0 SHASUMS256.txt values from nodejs.org.
  $nodeChecksums = @{
    'x64' = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
    'arm64' = '8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f'
  }

  $arguments = @($args)
  $command = 'install'
  if ($arguments.Count -gt 0 -and @('install', 'update', 'uninstall') -contains $arguments[0]) {
    $command = $arguments[0]
    $arguments = @($arguments | Select-Object -Skip 1)
  }

  function Test-Windows {
    return [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
  }

  # Returns the real node.exe behind a candidate, or $null. Version-manager
  # .cmd shims cannot be launched by MCP clients.
  function Resolve-CompatibleNode([string] $candidate) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    try {
      $version = [string] (& $candidate --version)
    } catch {
      return $null
    }
    if ($version -notmatch '^v(\d+)\.' -or [int] $Matches[1] -lt 22) { return $null }
    $executable = $candidate
    if ($executable -notmatch '\.exe$') {
      try {
        $executable = [string] (& $candidate -p 'process.execPath')
      } catch {
        return $null
      }
      if ($executable -notmatch '\.exe$' -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $null }
    }
    return $executable
  }

  function Find-Node {
    if ($env:FIGMA_BRIDGE_FORCE_PORTABLE_NODE -eq '1') { return $null }
    $pathNode = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @(
      $env:FIGMA_BRIDGE_NODE,
      (Join-Path (Join-Path $stateDir 'node') 'node.exe'),
      $(if ($pathNode) { $pathNode.Source } else { $null })
    )
    foreach ($candidate in $candidates) {
      $resolved = Resolve-CompatibleNode $candidate
      if ($resolved) { return $resolved }
    }
    return $null
  }

  function Get-NodeArchitecture {
    $architecture = $null
    try {
      $architecture = [string] [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    } catch {
      $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch -Regex ($architecture) {
      '^(X64|AMD64)$' { return 'x64' }
      '^(Arm64|ARM64)$' { return 'arm64' }
      default { throw "Unsupported Windows architecture: $architecture" }
    }
  }

  function Invoke-Download([string] $uri, [string] $destination) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $destination
  }

  function Expand-Zip([string] $archive, [string] $destination) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $tar = if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32\tar.exe' } else { $null }
    if ($tar -and (Test-Path -LiteralPath $tar -PathType Leaf)) {
      # bsdtar ships with Windows 10 1803+ and extracts large archives much faster.
      & $tar -xf $archive -C $destination
      if ($LASTEXITCODE -ne 0) { throw "Could not extract $archive" }
    } else {
      Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
    }
  }

  function Install-PortableNode {
    $nodeArch = Get-NodeArchitecture
    $expectedSha256 = $nodeChecksums[$nodeArch]
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $stage = Join-Path $stateDir (".node-install." + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    try {
      $archiveName = "node-v$nodeVersion-win-$nodeArch.zip"
      $archive = Join-Path $stage $archiveName
      Write-Host "Installing verified Node.js v$nodeVersion runtime..."
      Invoke-Download "https://nodejs.org/dist/v$nodeVersion/$archiveName" $archive
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expectedSha256) {
        throw 'Node.js archive checksum mismatch.'
      }
      $extractDir = Join-Path $stage 'extract'
      Expand-Zip $archive $extractDir
      $extracted = Join-Path $extractDir "node-v$nodeVersion-win-$nodeArch"
      if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe') -PathType Leaf)) {
        throw 'Node.js archive does not contain node.exe.'
      }
      $target = Join-Path $stateDir 'node'
      $backup = Join-Path $stateDir ("node.backup." + $PID)
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
      try {
        Move-Item -LiteralPath $extracted -Destination $target
      } catch {
        if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) {
          Move-Item -LiteralPath $backup -Destination $target
        }
        throw
      }
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
      return (Join-Path $target 'node.exe')
    } finally {
      if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
  }

  # Runs npm with the selected Node.js so a different node on PATH cannot be used.
  function Invoke-Npm([string] $node, [string] $directory, [string[]] $npmArguments) {
    $npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
    Push-Location -LiteralPath $directory
    try {
      if (Test-Path -LiteralPath $npmCli -PathType Leaf) {
        & $node $npmCli @npmArguments
      } else {
        $npm = Get-Command -Name 'npm.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npm) { throw "npm was not found next to $node." }
        & $npm.Source @npmArguments
      }
      if ($LASTEXITCODE -ne 0) { throw "npm $($npmArguments -join ' ') failed with exit code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
  }

  if (-not (Test-Windows)) {
    throw 'install.ps1 is the Windows installer. On macOS run install.sh instead.'
  }

  $node = Find-Node
  if (-not $node) { $node = Install-PortableNode }

  $temporaryDir = $null
  try {
    if (-not $sourceDir) {
      if ($repository -notmatch '^[A-Za-z0-9._/-]+$') { throw 'Invalid repository.' }
      if ($ref -notmatch '^[A-Za-z0-9._/-]+$') { throw 'Invalid ref.' }
      $temporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("figma-bridge-" + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Force -Path $temporaryDir | Out-Null
      $archive = Join-Path $temporaryDir 'source.zip'
      Write-Host "Downloading Figma Bridge ($repository@$ref)..."
      Invoke-Download "https://codeload.github.com/$repository/zip/$ref" $archive
      $extractDir = Join-Path $temporaryDir 'source'
      Expand-Zip $archive $extractDir
      $roots = @(Get-ChildItem -LiteralPath $extractDir -Directory)
      if ($roots.Count -ne 1) { throw 'Downloaded repository archive has an unexpected layout.' }
      $sourceDir = $roots[0].FullName
    }
    $setup = Join-Path (Join-Path $sourceDir 'scripts') 'setup.mjs'
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Downloaded source does not contain scripts/setup.mjs.' }

    # Node and npm write progress to stderr; keep native stderr from becoming a terminating error.
    $ErrorActionPreference = 'Continue'
    if ($command -eq 'uninstall') {
      & $node $setup --uninstall @arguments
    } else {
      Write-Host 'Installing dependencies...'
      Invoke-Npm $node $sourceDir @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
      Invoke-Npm $node (Join-Path $sourceDir 'figma-plugin') @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
      & $node $setup @arguments
    }
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw "Figma Bridge $command failed with exit code $exitCode." }
  } finally {
    if ($temporaryDir -and (Test-Path -LiteralPath $temporaryDir)) {
      Remove-Item -LiteralPath $temporaryDir -Recurse -Force
    }
  }
} @args
