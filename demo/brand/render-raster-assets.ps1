# Demo-only raster exports of the owner's provisional two-line mark. The SVGs
# in v3/apps/web/public/brand are the editable source; these fixed sizes are
# required by Next's file-convention metadata routes.
Add-Type -AssemblyName System.Drawing

$appDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../v3/apps/web/app'))
if (-not $appDir.EndsWith('v3\apps\web\app', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to write outside the demo web app metadata directory.'
}

$magenta = [System.Drawing.ColorTranslator]::FromHtml('#A8447E')
$cream = [System.Drawing.ColorTranslator]::FromHtml('#FBF7F3')
$ink = [System.Drawing.ColorTranslator]::FromHtml('#1A1F33')

function Draw-RoundRect($g, $x, $y, $width, $height, $radius, $color) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $radius * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $width - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $width - $d, $y + $height - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $height - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = [System.Drawing.SolidBrush]::new($color)
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

function Draw-Mark($g, $x, $y, $size, $color) {
  $state = $g.Save()
  $g.TranslateTransform([single]$x, [single]$y)
  $g.ScaleTransform([single]($size / 72), [single]($size / 72))
  $pen = [System.Drawing.Pen]::new($color, 6)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawLine($pen, 27, 18, 27, 55)
  $g.DrawBezier($pen, 14, 53, 14, 40, 24, 34, 37, 34)
  $g.DrawBezier($pen, 37, 34, 49, 34, 57, 40, 60, 52)
  $dot = [System.Drawing.SolidBrush]::new($color)
  $g.FillEllipse($dot, 46.3, 17.3, 7.4, 7.4)
  $dot.Dispose()
  $pen.Dispose()
  $g.Restore($state)
}

function Draw-Icon($g, $x, $y, $size) {
  Draw-RoundRect $g $x $y $size $size ($size * 0.22) $magenta
  Draw-Mark $g $x $y $size $cream
}

function Export-Png($name, $width, $height, $kind) {
  $factor = 4
  $large = [System.Drawing.Bitmap]::new($width * $factor, $height * $factor)
  $g = [System.Drawing.Graphics]::FromImage($large)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.ScaleTransform($factor, $factor)
  if ($kind -eq 'icon') {
    $g.Clear([System.Drawing.Color]::Transparent)
    Draw-Icon $g 0 0 $width
  } else {
    $g.Clear($cream)
    Draw-Icon $g 125 205 220
    $font = [System.Drawing.Font]::new('Arial', 103, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new($ink)
    $g.DrawString('BeauClick', $font, $brush, 396, 254)
    $brush.Dispose()
    $font.Dispose()
  }
  $g.Dispose()
  $small = [System.Drawing.Bitmap]::new($width, $height)
  $out = [System.Drawing.Graphics]::FromImage($small)
  $out.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $out.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $out.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $out.DrawImage($large, 0, 0, $width, $height)
  $out.Dispose()
  $target = Join-Path $appDir $name
  $small.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
  $large.Dispose()
  Write-Output "exported $target"
}

Export-Png 'icon1.png' 16 16 'icon'
Export-Png 'icon2.png' 32 32 'icon'
Export-Png 'icon3.png' 512 512 'icon'
Export-Png 'apple-icon.png' 180 180 'icon'
Export-Png 'opengraph-image.png' 1200 630 'share'
Export-Png 'twitter-image.png' 1200 630 'share'
