# 生成 Windows 安装器自定义界面底图（build/installer/*.bmp + PNG 副本）
# 设计语言：米白底 + 帝擎绿，参考 PixPin 安装器布局（标题栏/大标题/步骤清单/大进度条/插画卡片）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/make-installer-art.ps1
# 依赖：.NET System.Drawing（GDI+），读取 build/appicon.icon/Assets/brand-mark.png 与 package.json 版本号

param(
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root "build\installer" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---------- 设计令牌 ----------
$W = 620          # 窗口客户区宽（px，NSIS 非 DPI 感知，统一 1x）
$H = 420          # 窗口客户区高
$Cream     = 0xFAF8F1   # 米白底
$Ink       = 0x1F2E27   # 主文字（近黑带绿）
$Secondary = 0x5C6B63   # 次级文字
$Muted     = 0x8A968F   # 弱文字
$Brand     = 0x1C803E   # 帝擎绿（与登录按钮一致）
$BrandPale = 0xE4EFE7   # 进度条轨道 / 绿色浅底
$CardBg    = 0xEDF4EE   # 网格卡片底
$GridLine  = 0xD9E5DD   # 网格线
$CardBorder= 0xE0E8E2   # 白卡片描边
$IconGray  = 0x9DB5A6   # 清单灰图标
$White     = 0xFFFFFF

function C([int]$rgb) { [System.Drawing.Color]::FromArgb([int](0xFF000000 -bor $rgb)) }
function Rect($x, $y, $w, $h) { New-Object System.Drawing.Rectangle($x, $y, $w, $h) }

function New-Canvas {
  $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear((C $Cream))
  return @($bmp, $g)
}

function Font([single]$px, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
  # 脚本内以 px 约定字号，GraphicsUnit::Pixel 直接以像素为单位
  New-Object System.Drawing.Font("Microsoft YaHei UI", $px, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Text($g, [string]$s, $x, $y, $px, $color, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
  $g.DrawString($s, (Font $px $style), (New-Object System.Drawing.SolidBrush((C $color))), $x, $y)
}

function RoundRectPath($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($r -lt 1) {
    $p.AddRectangle((Rect $x $y $w $h))
    return $p
  }
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function FillRound($g, $x, $y, $w, $h, $r, $color) {
  $p = RoundRectPath $x $y $w $h $r
  $g.FillPath((New-Object System.Drawing.SolidBrush((C $color))), $p)
  $p.Dispose()
}

function DrawRoundBorder($g, $x, $y, $w, $h, $r, $color, [float]$width = 1.0) {
  $p = RoundRectPath $x $y $w $h $r
  $g.DrawPath((New-Object System.Drawing.Pen((C $color), $width)), $p)
  $p.Dispose()
}

# 品牌标志（含透明通道的绿色 D 标）
$markPath = Join-Path $root "build\appicon.icon\Assets\brand-mark.png"
$brandMark = [System.Drawing.Image]::FromFile($markPath)

function DrawMark($g, $x, $y, $size) {
  # brand-mark.png 非正方形时按比例居中放入 $size x $size
  $s = [Math]::Min($size / $brandMark.Width, $size / $brandMark.Height)
  $w = [int]($brandMark.Width * $s); $h = [int]($brandMark.Height * $s)
  $dx = $x + [int](($size - $w) / 2); $dy = $y + [int](($size - $h) / 2)
  $g.DrawImage($brandMark, (Rect $dx $dy $w $h))
}

# 插画卡片母题（参考图：网格底纹卡片 + 白色应用卡 + 绿色圆形箭头徽标）
function Draw-IllustrationCard($g, $x, $y, $scale) {
  $gw = [int](170 * $scale); $gh = [int](140 * $scale)   # 网格底卡
  $cw = [int](96 * $scale);  $ch = [int](96 * $scale)    # 白色应用卡
  $bw = [int](36 * $scale)                                # 徽标直径

  # 网格底卡
  FillRound $g $x $y $gw $gh 14 $CardBg
  $clip = RoundRectPath $x $y $gw $gh 14
  $g.SetClip($clip)
  $pen = New-Object System.Drawing.Pen((C $GridLine), 1)
  $step = [int](14 * $scale)
  for ($gx = $x; $gx -le ($x + $gw); $gx += $step) { $g.DrawLine($pen, $gx, $y, $gx, ($y + $gh)) }
  for ($gy = $y; $gy -le ($y + $gh); $gy += $step) { $g.DrawLine($pen, $x, $gy, ($x + $gw), $gy) }
  $g.ResetClip()
  $clip.Dispose()
  DrawRoundBorder $g $x $y $gw $gh 14 $CardBorder 1.0

  # 白色应用卡（右下略微越出底卡，形成层次）
  $cx = $x + [int](($gw - $cw) / 2) + [int](8 * $scale)
  $cy = $y + [int](($gh - $ch) / 2) - [int](6 * $scale)
  FillRound $g $cx $cy $cw $ch 12 $White
  DrawRoundBorder $g $cx $cy $cw $ch 12 $CardBorder 1.0
  DrawMark $g ($cx + [int](($cw - 56 * $scale) / 2)) ($cy + [int](12 * $scale)) ([int](56 * $scale))
  Text $g "diteng agent" ($cx + 6) ($cy + $ch - [int](24 * $scale)) ([int](11 * $scale)) $Secondary

  # 绿色圆形箭头徽标（压在应用卡右下角）
  $bx = $cx + $cw - [int]($bw / 2); $by = $cy + $ch - [int]($bw / 2)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush((C $Brand))), (Rect $bx $by $bw $bw))
  $cxm = $bx + $bw / 2; $cym = $by + $bw / 2
  $arrow = New-Object System.Drawing.Pen((C $White), [float](2.6 * $scale))
  $l = 5.5 * $scale
  $g.DrawLine($arrow, [float]($cxm - $l), [float]$cym, [float]($cxm + $l * 0.7), [float]$cym)
  $g.DrawLine($arrow, [float]($cxm + $l * 0.7 - $l * 0.7), [float]($cym - $l * 0.75), [float]($cxm + $l * 0.7), [float]$cym)
  $g.DrawLine($arrow, [float]($cxm + $l * 0.7 - $l * 0.7), [float]($cym + $l * 0.75), [float]($cxm + $l * 0.7), [float]$cym)
}

# 主色实心圆角按钮（点击响应由 NSIS 透明静态控件承担）
function Draw-PrimaryButton($g, $x, $y, $w, $h) {
  FillRound $g $x $y $w $h 10 $Brand
}

# 版本胶囊
function Draw-VersionPill($g, $x, $y, [string]$version) {
  $s = "v$version"
  $f = Font 12
  $w = [int]($s.Length * 7.6) + 26
  FillRound $g $x $y $w 26 13 $BrandPale
  Text $g $s ($x + 13) ($y + 4) 12 $Brand
  return $w
}

# ---------- 版本号 ----------
$package = Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version

# ---------- 页面：欢迎 ----------
$bmpp = New-Canvas; $bmp = $bmpp[0]; $g = $bmpp[1]
Text $g "安装 diteng agent" 40 52 26 $Ink Bold
Text $g "工作，在一个清晰的空间里。" 40 136 14 $Secondary
Draw-VersionPill $g 40 172 $version | Out-Null
Draw-IllustrationCard $g 408 84 1.0
Text $g "安装过程只需片刻，完成后可立即使用。" 40 392 12 $Muted
Draw-PrimaryButton $g 448 356 132 44
Text $g "开始安装" 478 368 15 $White
$bmp.Save((Join-Path $OutDir "welcome.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Save((Join-Path $OutDir "welcome.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ---------- 页面：安装进度 ----------
$bmpp = New-Canvas; $bmp = $bmpp[0]; $g = $bmpp[1]
Text $g "正在为你准备 diteng agent" 40 44 22 $Ink Bold
Text $g "工作，在一个清晰的空间里。" 40 122 13 $Secondary
Draw-IllustrationCard $g 424 76 0.82

# 步骤清单（图标烘焙，状态文字为运行时控件，靠颜色区分：绿=完成 深绿=进行中 灰=待办）
function Draw-CheckCircle($g, $x, $y, $size, $color) {
  $pen = New-Object System.Drawing.Pen((C $color), 1.8)
  $g.DrawEllipse($pen, (Rect $x $y $size $size))
  $k = [float]($size * 0.28)
  $cx = $x + $size / 2; $cy = $y + $size / 2
  $g.DrawLine($pen, [float]($cx - $k * 1.15), [float]($cy + $k * 0.1), [float]($cx - $k * 0.25), [float]($cy + $k * 0.95))
  $g.DrawLine($pen, [float]($cx - $k * 0.25), [float]($cy + $k * 0.95), [float]($cx + $k * 1.2), [float]($cy - $k * 0.9))
}
function Draw-FilesIcon($g, $x, $y, $size, $color) {
  $pen = New-Object System.Drawing.Pen((C $color), 1.8)
  $back = Rect $x ([int]($y + 4)) ([int]($size * 0.78)) ([int]($size * 0.78))
  $front = Rect ([int]($x + $size * 0.22)) $y ([int]($size * 0.78)) ([int]($size * 0.78))
  $p1 = RoundRectPath $back.X $back.Y $back.Width $back.Height 3
  $g.DrawPath($pen, $p1); $p1.Dispose()
  $p2 = RoundRectPath $front.X $front.Y $front.Width $front.Height 3
  $g.FillPath((New-Object System.Drawing.SolidBrush((C $Cream))), $p2)
  $g.DrawPath($pen, $p2); $p2.Dispose()
}
function Draw-MonitorIcon($g, $x, $y, $size, $color) {
  $pen = New-Object System.Drawing.Pen((C $color), 1.8)
  $p = RoundRectPath $x $y $size ([int]($size * 0.72)) 3
  $g.DrawPath($pen, $p); $p.Dispose()
  $g.DrawLine($pen, [int]($x + $size / 2), [int]($y + $size * 0.72), [int]($x + $size / 2), [int]($y + $size * 0.85))
  $g.DrawLine($pen, [int]($x + $size * 0.25), [int]($y + $size * 0.92), [int]($x + $size * 0.75), [int]($y + $size * 0.92))
}
Draw-CheckCircle $g 40 152 20 $IconGray
Draw-FilesIcon   $g 40 190 20 $IconGray
Draw-MonitorIcon $g 40 228 20 $IconGray

# 进度区
Text $g "正在安装" 40 278 14 $Ink Bold
FillRound $g 40 312 540 10 5 $BrandPale   # 轨道（真实进度条控件将被移到此处）
Text $g "正在提取文件…" 40 334 12 $Muted
Text $g "请等待安装完成。" 40 396 12 $Muted
$bmp.Save((Join-Path $OutDir "progress.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Save((Join-Path $OutDir "progress.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ---------- 页面：完成 ----------
$bmpp = New-Canvas; $bmp = $bmpp[0]; $g = $bmpp[1]
Text $g "安装完成" 40 52 24 $Ink Bold
Text $g "diteng agent 已准备就绪，随时开始工作。" 40 98 14 $Secondary
Text $g "v$version 已安装到你的电脑，可在开始菜单找到它。" 40 124 12 $Muted
Draw-IllustrationCard $g 424 96 0.82
Text $g "建议立即运行，完成账号登录。" 40 392 12 $Muted
Draw-PrimaryButton $g 448 356 132 44
Text $g "完成" 499 368 15 $White
$bmp.Save((Join-Path $OutDir "finish.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Save((Join-Path $OutDir "finish.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ---------- 页面：卸载欢迎 ----------
$bmpp = New-Canvas; $bmp = $bmpp[0]; $g = $bmpp[1]
Text $g "卸载 diteng agent" 40 52 24 $Ink Bold
Text $g "将从你的电脑移除 diteng agent。" 40 94 14 $Secondary
Text $g "个人数据与配置会被保留，重新安装后可继续使用。" 40 120 12 $Muted
Draw-IllustrationCard $g 424 96 0.82
Text $g "卸载完成后会自动清理快捷方式与注册表项。" 40 392 12 $Muted
Draw-PrimaryButton $g 448 356 132 44
Text $g "开始卸载" 478 368 15 $White
$bmp.Save((Join-Path $OutDir "un-welcome.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Save((Join-Path $OutDir "un-welcome.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ---------- 页面：表单底（安装模式/目录页共用） ----------
$bmpp = New-Canvas; $bmp = $bmpp[0]; $g = $bmpp[1]
DrawMark $g 40 40 20
Text $g "安装设置" 72 41 18 $Ink Bold
$bmp.Save((Join-Path $OutDir "form.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Save((Join-Path $OutDir "form.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ---------- 按钮位图（BS_BITMAP 真按钮用，132x44 绿色药丸 + 白字） ----------
function Draw-BtnBmp([string]$name, [string]$label) {
  $bw = 132; $bh = 44
  $b = New-Object System.Drawing.Bitmap($bw, $bh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear((C $Cream))
  FillRound $g 0 0 $bw $bh 10 $Brand
  $f = New-Object System.Drawing.Font("Microsoft YaHei UI", 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $sz = $g.MeasureString($label, $f)
  $g.DrawString($label, $f, (New-Object System.Drawing.SolidBrush((C $White))), (($bw - $sz.Width) / 2), (($bh - $sz.Height) / 2))
  $g.Dispose()
  $b.Save((Join-Path $OutDir "$name.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $b.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
}
Draw-BtnBmp "btn-start" "开始安装"
Draw-BtnBmp "btn-finish" "完成"
Draw-BtnBmp "btn-un" "开始卸载"

# ---------- 卸载完成侧栏（MUI_UNPAGE_FINISH 用，164x314） ----------
$SW = 164; $SH = 314
$bmp = New-Object System.Drawing.Bitmap($SW, $SH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear((C $Cream))
$clip = RoundRectPath 0 0 $SW $SH 0
$g.SetClip($clip)
$pen = New-Object System.Drawing.Pen((C $GridLine), 1)
for ($gx = 0; $gx -le $SW; $gx += 14) { $g.DrawLine($pen, $gx, 0, $gx, $SH) }
for ($gy = 0; $gy -le $SH; $gy += 14) { $g.DrawLine($pen, 0, $gy, $SW, $gy) }
$g.ResetClip(); $clip.Dispose()
FillRound $g 20 34 120 120 14 $White
DrawRoundBorder $g 20 34 120 120 14 $CardBorder 1.0
DrawMark $g 50 64 60
DrawMark $g 24 248 32
$g.DrawString("diteng agent", (Font 13), (New-Object System.Drawing.SolidBrush((C $Secondary))), 66, 256)
$bmp.Save((Join-Path $OutDir "un-sidebar.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Save((Join-Path $OutDir "un-sidebar.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

$brandMark.Dispose()

# 版本标记（validate-release.mjs 校验底图与 package.json 一致，防漏再生成）
Set-Content -Path (Join-Path $OutDir "art-version.txt") -Value $version -Encoding ASCII -NoNewline

Write-Host "installer art generated -> $OutDir (v$version)"
Get-ChildItem $OutDir | ForEach-Object { Write-Host ("  {0}  {1:N0} bytes" -f $_.Name, $_.Length) }
