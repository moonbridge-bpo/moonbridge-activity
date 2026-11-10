$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $desktopRoot 'src-tauri\nsis'
New-Item -ItemType Directory -Path $target -Force | Out-Null

Add-Type -AssemblyName System.Drawing
$logoPath = Join-Path $desktopRoot 'public\moonbridge-logo.png'
$logo = [System.Drawing.Image]::FromFile($logoPath)
try {
  function New-Canvas([int]$width, [int]$height) {
    return New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  }
  $navy = [System.Drawing.Color]::FromArgb(33, 26, 110)
  $gold = [System.Drawing.Color]::FromArgb(241, 185, 47)

  $header = New-Canvas 150 57
  try {
    $g = [System.Drawing.Graphics]::FromImage($header)
    try {
      $g.Clear([System.Drawing.Color]::White)
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
      $navyBrush = New-Object System.Drawing.SolidBrush($navy)
      $goldBrush = New-Object System.Drawing.SolidBrush($gold)
      $brandFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
      $subFont = New-Object System.Drawing.Font('Segoe UI', 7, [System.Drawing.FontStyle]::Bold)
      try {
        $g.FillRectangle($goldBrush, 0, 54, 150, 3)
        $g.DrawImage($logo, 8, 10, 40, 30)
        $g.DrawString('MOONBRIDGE', $brandFont, $navyBrush, 51, 13)
        $g.DrawString('ACTIVITY', $subFont, $navyBrush, 53, 31)
      } finally { $navyBrush.Dispose(); $goldBrush.Dispose(); $brandFont.Dispose(); $subFont.Dispose() }
    } finally { $g.Dispose() }
    $header.Save((Join-Path $target 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally { $header.Dispose() }

  $sidebar = New-Canvas 164 314
  try {
    $g = [System.Drawing.Graphics]::FromImage($sidebar)
    try {
      $g.Clear($navy)
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
      $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
      $goldBrush = New-Object System.Drawing.SolidBrush($gold)
      $brandFont = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
      $subFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Regular)
      try {
        $g.FillRectangle($white, 21, 30, 72, 62)
        $g.DrawImage($logo, 27, 44, 60, 43)
        $g.DrawString('MOONBRIDGE', $brandFont, $white, 18, 114)
        $g.DrawString('ACTIVITY', $subFont, $white, 19, 139)
        $g.FillRectangle($goldBrush, 19, 280, 64, 5)
      } finally { $white.Dispose(); $goldBrush.Dispose(); $brandFont.Dispose(); $subFont.Dispose() }
    } finally { $g.Dispose() }
    $sidebar.Save((Join-Path $target 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally { $sidebar.Dispose() }
} finally { $logo.Dispose() }
