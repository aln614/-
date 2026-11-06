param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\build\native-glass')
)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) {
  throw "Output directory already exists: $OutputDirectory"
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('tenying-native-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work,$OutputDirectory | Out-Null
$packages = @(
  @{ Name='sdk'; Id='microsoft.windows.sdk.contracts'; Version='10.0.26100.1'; Cached='tenying-sdk-contracts.nupkg'; Hash='933D0AEE3BF2EC5AD04D2E19D27609A95EECEC4D3FF0F50B222E2E3931819EF9' },
  @{ Name='win2d'; Id='win2d.uwp'; Version='1.26.0'; Cached='tenying-win2d-1.26.0.nupkg'; Hash='F965BC5AEE9887E57F96B67B50D819B7D91870E064E3B4CD21AEF31301860FD2' },
  @{ Name='vcrt'; Id='microsoft.vcrtforwarders.140'; Version='1.1.0'; Cached='tenying-vcrt-forwarders.nupkg'; Hash='681D3A68A32EF866828F9E795E8ECD0CAC0E79184EDE54839461158F7F67A5BD' }
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($package in $packages) {
  $archive = Join-Path $work ($package.Name + '.nupkg')
  $cached = Join-Path ([IO.Path]::GetTempPath()) $package.Cached
  if ((Test-Path -LiteralPath $cached) -and (Get-FileHash -LiteralPath $cached -Algorithm SHA256).Hash -eq $package.Hash) {
    Copy-Item -LiteralPath $cached -Destination $archive
  } else {
    $url = "https://api.nuget.org/v3-flatcontainer/$($package.Id)/$($package.Version)/$($package.Id).$($package.Version).nupkg"
    Invoke-WebRequest -Uri $url -OutFile $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $package.Hash) {
    throw "Package hash mismatch: $($package.Name)"
  }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, (Join-Path $work $package.Name))
}
$sdk = Join-Path $work 'sdk\ref\netstandard2.0'
$canvas = Join-Path $work 'win2d'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
Copy-Item -LiteralPath (Join-Path $canvas 'lib\net45\Microsoft.Graphics.Canvas.winmd') -Destination $OutputDirectory
Copy-Item -LiteralPath (Join-Path $canvas 'runtimes\win10-x64\native\Microsoft.Graphics.Canvas.dll') -Destination $OutputDirectory
Copy-Item -Path (Join-Path $work 'vcrt\runtimes\win-x64\native\release\*.dll') -Destination $OutputDirectory
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'probe.exe.manifest') -Destination $OutputDirectory
& (Join-Path $framework 'csc.exe') /nologo /target:library "/out:$OutputDirectory\inproc-safe.dll" `
  "/r:$sdk\Windows.Foundation.UniversalApiContract.winmd" "/r:$sdk\Windows.Foundation.FoundationContract.winmd" `
  "/r:$OutputDirectory\Microsoft.Graphics.Canvas.winmd" "/r:$framework\System.Runtime.dll" `
  "/r:$framework\System.Numerics.dll" "/r:$framework\System.Numerics.Vectors.dll" (Join-Path $PSScriptRoot 'inproc.cs')
if ($LASTEXITCODE -ne 0) { throw "Native bridge compilation failed: $LASTEXITCODE" }
Copy-Item -LiteralPath (Join-Path $canvas 'Win2D.uwp.nuspec'),(Join-Path $work 'vcrt\Microsoft.VCRTForwarders.140.nuspec') -Destination $OutputDirectory
Write-Output "Experimental native dependencies prepared at $OutputDirectory"
Write-Output "The Win2D package declares a separate license requiring acceptance; verify redistribution terms before release."
