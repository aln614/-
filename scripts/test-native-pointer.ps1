param(
  [int]$StartX, [int]$StartY, [int]$EndX, [int]$EndY,
  [int]$HoldMilliseconds = 1100, [int]$Repeat = 1, [int]$Steps = 12, [int]$StepMilliseconds = 30,
  [string]$ResultPath = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TestPointer {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[TestPointer]::SetProcessDPIAware() | Out-Null
$original = New-Object TestPointer+POINT
[TestPointer]::GetCursorPos([ref]$original) | Out-Null
$samples = New-Object System.Collections.Generic.List[object]
try {
  for ($run = 0; $run -lt $Repeat; $run++) {
    $x = $StartX + ($EndX - $StartX) * $run
    $y = $StartY + ($EndY - $StartY) * $run
    [TestPointer]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 180
    [TestPointer]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    for ($i = 1; $i -le $Steps; $i++) {
      [TestPointer]::SetCursorPos(($x + [int](($EndX-$StartX)*$i/$Steps)), ($y + [int](($EndY-$StartY)*$i/$Steps))) | Out-Null
      Start-Sleep -Milliseconds $StepMilliseconds
      $actual = New-Object TestPointer+POINT
      [TestPointer]::GetCursorPos([ref]$actual) | Out-Null
      $samples.Add(@{ x=$actual.X; y=$actual.Y; expectedX=($x + [int](($EndX-$StartX)*$i/$Steps)); expectedY=($y + [int](($EndY-$StartY)*$i/$Steps)) })
    }
    Start-Sleep -Milliseconds $HoldMilliseconds
    $release = New-Object TestPointer+POINT
    [TestPointer]::GetCursorPos([ref]$release) | Out-Null
    $samples.Add(@{ x=$release.X; y=$release.Y; expectedX=($x+$EndX-$StartX); expectedY=($y+$EndY-$StartY) })
    [TestPointer]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
  }
} finally {
  [TestPointer]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  [TestPointer]::SetCursorPos($original.X, $original.Y) | Out-Null
  if ($ResultPath) { $samples | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath }
}
