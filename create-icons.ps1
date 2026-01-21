# Create placeholder icons for Chrome extension
Add-Type -AssemblyName System.Drawing

# Create 16x16 icon
$bmp16 = New-Object System.Drawing.Bitmap(16, 16)
$g16 = [System.Drawing.Graphics]::FromImage($bmp16)
$g16.Clear([System.Drawing.Color]::FromArgb(102, 126, 234))
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$font16 = New-Object System.Drawing.Font('Arial', 10, [System.Drawing.FontStyle]::Bold)
$g16.DrawString('C', $font16, $brush, 0, 0)
$bmp16.Save("$PSScriptRoot\icons\icon16.png")
$g16.Dispose()
$bmp16.Dispose()
$font16.Dispose()

# Create 48x48 icon
$bmp48 = New-Object System.Drawing.Bitmap(48, 48)
$g48 = [System.Drawing.Graphics]::FromImage($bmp48)
$g48.Clear([System.Drawing.Color]::FromArgb(102, 126, 234))
$font48 = New-Object System.Drawing.Font('Arial', 28, [System.Drawing.FontStyle]::Bold)
$g48.DrawString('CA', $font48, $brush, 2, 8)
$bmp48.Save("$PSScriptRoot\icons\icon48.png")
$g48.Dispose()
$bmp48.Dispose()
$font48.Dispose()

# Create 128x128 icon
$bmp128 = New-Object System.Drawing.Bitmap(128, 128)
$g128 = [System.Drawing.Graphics]::FromImage($bmp128)
$g128.Clear([System.Drawing.Color]::FromArgb(102, 126, 234))
$font128 = New-Object System.Drawing.Font('Arial', 72, [System.Drawing.FontStyle]::Bold)
$g128.DrawString('CA', $font128, $brush, 8, 20)
$bmp128.Save("$PSScriptRoot\icons\icon128.png")
$g128.Dispose()
$bmp128.Dispose()
$font128.Dispose()

$brush.Dispose()

Write-Host "Icons created successfully!" -ForegroundColor Green
