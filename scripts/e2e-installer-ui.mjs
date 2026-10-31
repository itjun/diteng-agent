// e2e-installer-ui.mjs — Windows 安装器自定义界面逐页截图验证
// 用法：node scripts/e2e-installer-ui.mjs [Setup.exe 路径]
// 默认取 release/ 下最新的 *Setup*.exe；截图输出到 release/installer-ui-shots/
// 以 /D=<临时目录> 启动避免触碰本机正式安装；完毕后终止进程并清理。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const releaseDir = new URL('../release/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const exe =
  args[0] ??
  (() => {
    if (!existsSync(releaseDir)) throw new Error('release/ 不存在，请先 pnpm dist:win');
    const candidates = readdirSync(releaseDir).filter(n => /Setup.*\.exe$/.test(n) && !n.includes('__uninstaller'));
    if (!candidates.length) throw new Error('release/ 下未找到 Setup exe');
    candidates.sort((a, b) => (a < b ? 1 : -1));
    return join(releaseDir, candidates[0]);
  })();

const outDir = join(releaseDir, 'installer-ui-shots');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const installDir = join(tmpdir(), 'diteng-installer-ui-test');
rmSync(installDir, { recursive: true, force: true });

console.log(`安装器: ${exe}`);
console.log(`截图目录: ${outDir}`);

// PowerShell 驱动：启动 → 移动到固定位置 → 逐步截图 + 点击/回车翻页
const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class E2EWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern void SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }
}
"@
$outDir = ${JSON.stringify(outDir)}
$p = Start-Process -FilePath ${JSON.stringify(exe)} -ArgumentList "/D=$(JSON.stringify(installDir).slice(1, -1))" -PassThru
Start-Sleep 3
$p.Refresh(); $h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw '未找到安装器窗口（静默失败或被单实例拦截）' }
[E2EWin]::SetWindowPos($h, [IntPtr]::Zero, 120, 120, 0, 0, 0x0005) | Out-Null
function Shot($name) {
  $r = New-Object E2EWin+RECT
  [E2EWin]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hg = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap($w, $hg)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hg)))
  $bmp.Save("$outDir/$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "shot $name"
}
function Click($cx, $cy) {
  $pt = New-Object E2EWin+POINT; $pt.X = $cx; $pt.Y = $cy
  [E2EWin]::ClientToScreen($h, [ref]$pt) | Out-Null
  [E2EWin]::SetCursorPos($pt.X, $pt.Y)
  Start-Sleep -Milliseconds 150
  [E2EWin]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [E2EWin]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}

[E2EWin]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 500
Shot '1-welcome'
Click 514 378; Start-Sleep 2          # 开始安装（自绘按钮）
Shot '2-mode'
Click 514 378; Start-Sleep 2          # 下一步（每用户）
Shot '3-directory'
Click 514 378; Start-Sleep 2          # 安装
Shot '4-instfiles'
Start-Sleep 6                          # 等待复制完成
Shot '5-finish'
Click 514 378; Start-Sleep 2          # 完成
try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
Write-Host 'done'
`;

execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
  stdio: 'inherit',
  timeout: 120_000,
});

console.log(`完成。截图见 ${outDir}（安装目录 ${installDir} 可手动清理）`);
