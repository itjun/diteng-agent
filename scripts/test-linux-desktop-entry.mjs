import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function load(file) {
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(require, module, module.exports);
  return module.exports;
}

const api = load('src/main/linux-desktop-entry.ts');

/**
 * 独立还原 GNOME 实际读到的命令：GKeyFile 反转义 → 先展开 % → 再按 shell 分词。
 * 不复用生产代码，用来核对写进文件的 Exec。
 */
function parseDesktopExec(exec) {
  let text = '';
  for (let index = 0; index < exec.length; index += 1) {
    if (exec[index] !== '\\') {
      text += exec[index];
      continue;
    }
    const next = exec[index + 1];
    const mapped = { '\\': '\\', s: ' ', n: '\n', t: '\t', r: '\r' }[next];
    assert.ok(mapped != null, `GKeyFile 不能接受 \\${next ?? ''}`);
    text += mapped;
    index += 1;
  }
  let expanded = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '%' && index + 1 < text.length) {
      assert.equal(text[index + 1], '%', `百分号没有写成 %%：${text}`);
      expanded += '%';
      index += 1;
      continue;
    }
    expanded += text[index];
  }
  const args = [];
  let current = '';
  let mode = 'none';
  let started = false;
  for (let index = 0; index < expanded.length; index += 1) {
    const char = expanded[index];
    if (mode === 'single') {
      if (char === '\'') mode = 'none';
      else current += char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    if (char === '\'') {
      mode = 'single';
      started = true;
      continue;
    }
    if (char === '\\') {
      current += expanded[index + 1];
      started = true;
      index += 1;
      continue;
    }
    current += char;
    started = true;
  }
  assert.equal(mode, 'none');
  if (started) args.push(current);
  return args;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'diteng-desktop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataHome = join(root, 'home');
  const systemDir = join(root, 'usr', 'share', 'applications');
  const iconSource = join(root, 'icon.png');
  writeFileSync(iconSource, 'png-bytes-v1');
  return { root, dataHome, systemDir, iconSource };
}

function sync(fx, overrides = {}) {
  return api.syncLinuxDesktopEntry({
    platform: 'linux',
    isPackaged: true,
    execPath: '/opt/portable/diteng-agent',
    iconSource: fx.iconSource,
    dataHome: fx.dataHome,
    systemApplicationDirs: [fx.systemDir],
    ...overrides,
  });
}

function userDesktop(fx) {
  return join(fx.dataHome, 'applications', 'diteng-agent.desktop');
}

function userIcon(fx) {
  return join(fx.dataHome, 'icons', 'hicolor', '512x512', 'apps', 'diteng-agent.png');
}

/** b102310 写出的原文：除 Exec 外逐行固定，且不做引号与百分号转义。 */
function legacyEntry(execPath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=diteng agent',
    `Exec=${execPath}`,
    'Icon=diteng-agent',
    'Terminal=false',
    'Categories=Office;',
    'StartupWMClass=diteng-agent',
    'Comment=帝擎 ERP 桌面客户端',
    '',
  ].join('\n');
}

function writeSystem(fx, name = 'diteng-agent.desktop', content = '[Desktop Entry]\nType=Application\nExec="/opt/diteng agent/diteng-agent" %U\n') {
  mkdirSync(fx.systemDir, { recursive: true });
  const path = join(fx.systemDir, name);
  writeFileSync(path, content);
  return path;
}

function putUserFile(fx, content) {
  mkdirSync(dirname(userDesktop(fx)), { recursive: true });
  writeFileSync(userDesktop(fx), content);
}

function execOf(content) {
  const line = content.split('\n').find((item) => item.startsWith('Exec='));
  assert.ok(line);
  return line.slice('Exec='.length);
}

/** 独立解析后取出真正启动的程序：含 % 时前面是 /usr/bin/env --。 */
function launchedPath(encoded) {
  const args = parseDesktopExec(encoded);
  if (args.length === 1) return args[0];
  assert.deepEqual(args.slice(0, 2), ['/usr/bin/env', '--']);
  assert.equal(args.length, 3);
  return args[2];
}

function tryLink(t, target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if (['EPERM', 'EINVAL', 'ENOTSUP', 'EACCES'].includes(error.code)) {
      t.skip(`当前环境不能创建符号链接（${error.code}）`);
      return false;
    }
    throw error;
  }
}

test('XDG 路径：未设置或相对路径回退到规范默认值', () => {
  const home = join(tmpdir(), 'diteng-home');
  const custom = join(tmpdir(), 'custom-data');
  assert.equal(api.resolveXdgDataHome(undefined, home), join(home, '.local', 'share'));
  assert.equal(api.resolveXdgDataHome('', home), join(home, '.local', 'share'));
  assert.equal(api.resolveXdgDataHome('   ', home), join(home, '.local', 'share'));
  assert.equal(api.resolveXdgDataHome('relative/share', home), join(home, '.local', 'share'));
  assert.equal(api.resolveXdgDataHome(`  ${custom}  `, home), custom);
  const defaults = [join('/usr/local/share', 'applications'), join('/usr/share', 'applications')];
  assert.deepEqual(api.resolveXdgSystemApplicationDirs(undefined), defaults);
  assert.deepEqual(api.resolveXdgSystemApplicationDirs(''), defaults);
  assert.deepEqual(api.resolveXdgSystemApplicationDirs('relative:also-relative'), defaults);
  assert.deepEqual(api.resolveXdgSystemApplicationDirs('relative/share:/usr/share:'), [join('/usr/share', 'applications')]);
  assert.deepEqual(api.resolveXdgSystemApplicationDirs('/usr/local/share: /usr/share'), defaults);
});

test('Exec 转义空格、引号、反斜杠和百分号，并能被 GLib 的读取顺序还原', () => {
  const backtick = '`';
  const samples = [
    ['/opt/diteng-agent', "'/opt/diteng-agent'"],
    ['/opt/My Apps/diteng-agent', "'/opt/My Apps/diteng-agent'"],
    ['/opt/100%/diteng-agent', "/usr/bin/env -- '/opt/100%%/diteng-agent'"],
    ['/opt/100% off/diteng-agent', "/usr/bin/env -- '/opt/100%% off/diteng-agent'"],
    ['/opt/%U/diteng-agent', "/usr/bin/env -- '/opt/%%U/diteng-agent'"],
    ['/opt/100%%/diteng-agent', "/usr/bin/env -- '/opt/100%%%%/diteng-agent'"],
    ['/opt/say"hi/diteng-agent', `'/opt/say"hi/diteng-agent'`],
    ['/opt/foo\\bar/diteng-agent', `'/opt/foo\\\\bar/diteng-agent'`],
    ['/opt/foo\\', `'/opt/foo\\\\'`],
    ['/opt/price$/diteng-agent', `'/opt/price$/diteng-agent'`],
    [`/opt/tick${backtick}x/diteng-agent`, `'/opt/tick${backtick}x/diteng-agent'`],
    ["/opt/it's/diteng-agent", "'/opt/it'\\\\''s/diteng-agent'"],
    ['/opt/a&b;c|d/diteng-agent', "'/opt/a&b;c|d/diteng-agent'"],
    ['/opt/~user/?a*b#c(d)/diteng-agent', "'/opt/~user/?a*b#c(d)/diteng-agent'"],
    ['/opt/<tag>/diteng-agent', "'/opt/<tag>/diteng-agent'"],
    ['/home/user/帝擎/diteng-agent', "'/home/user/帝擎/diteng-agent'"],
  ];
  for (const [path, expected] of samples) {
    assert.equal(api.formatDesktopExec(path), expected, path);
    assert.equal(launchedPath(expected), path, path);
  }
  assert.throws(() => api.formatDesktopExec('/opt/a\nb'), /无法写入/);
  assert.throws(() => api.formatDesktopExec('/opt/a\tb'), /无法写入/);
  assert.throws(() => api.formatDesktopExec('relative/diteng-agent'), /无法写入/);
});

test('免安装注册写入用户级条目和图标，重复执行不改写', (t) => {
  const fx = fixture(t);
  const first = sync(fx);
  assert.equal(first.action, 'installed');
  assert.equal(first.wroteDesktop, true);
  const desktop = userDesktop(fx);
  const content = readFileSync(desktop, 'utf8');
  assert.equal(content.endsWith('\n'), true);
  assert.equal(content.includes('X-Diteng-Agent-Managed=portable'), true);
  assert.equal(content.includes('StartupWMClass=diteng-agent'), true);
  assert.equal(launchedPath(execOf(content)), '/opt/portable/diteng-agent');
  assert.equal(readFileSync(userIcon(fx), 'utf8'), 'png-bytes-v1');
  assert.equal(existsSync(fx.systemDir), false);
  assert.deepEqual(readdirSync(dirname(desktop)), ['diteng-agent.desktop']);

  const stamp = new Date('2020-01-01T00:00:00Z');
  utimesSync(desktop, stamp, stamp);
  utimesSync(userIcon(fx), stamp, stamp);
  const second = sync(fx);
  assert.equal(second.action, 'unchanged');
  assert.equal(second.wroteDesktop, false);
  assert.ok(Math.abs(statSync(desktop).mtimeMs - stamp.getTime()) < 2000);
  assert.ok(Math.abs(statSync(userIcon(fx)).mtimeMs - stamp.getTime()) < 2000);
  assert.equal(readFileSync(desktop, 'utf8'), content);
});

test('免安装目录挪位后更新本程序条目，不覆盖用户改过的同名文件', (t) => {
  const fx = fixture(t);
  assert.equal(sync(fx, { execPath: '/opt/old/diteng-agent' }).action, 'installed');
  const moved = sync(fx, { execPath: '/opt/new place/diteng-agent' });
  assert.equal(moved.action, 'updated');
  assert.equal(launchedPath(execOf(readFileSync(userDesktop(fx), 'utf8'))), '/opt/new place/diteng-agent');

  const custom = fixture(t);
  putUserFile(custom, legacyEntry('/opt/old/diteng-agent').replace('Name=diteng agent', 'Name=我的启动器'));
  const kept = sync(custom, { execPath: '/opt/new/diteng-agent' });
  assert.equal(kept.action, 'kept-user-entry');
  assert.equal(kept.wroteDesktop, false);
  const text = readFileSync(userDesktop(custom), 'utf8');
  assert.equal(text.includes('Name=我的启动器'), true);
  assert.equal(text.includes('Exec=/opt/old/diteng-agent'), true);
  assert.equal(existsSync(userIcon(custom)), false);
});

test('含特殊字符的免安装路径写入后能解析回原路径', (t) => {
  const fx = fixture(t);
  const execPath = '/opt/100% off/say"hi/it\'s/price$/tick`x/a\\b/帝擎 <>&;*?#()~';
  const result = sync(fx, { execPath });
  assert.equal(result.action, 'installed');
  const content = readFileSync(userDesktop(fx), 'utf8');
  const execLine = content.split('\n').filter((line) => line.startsWith('Exec='));
  assert.equal(execLine.length, 1);
  assert.equal(execLine[0].includes('\n'), false);
  assert.equal(execOf(content), api.formatDesktopExec(execPath));
  assert.equal(launchedPath(execOf(content)), execPath);
  assert.equal(sync(fx, { execPath }).action, 'unchanged');
});

test('含百分号的本程序条目在安装系统包后删除，直写 %% 的外来条目保留', (t) => {
  const owned = fixture(t);
  const execPath = '/opt/100% off/diteng-agent';
  assert.equal(sync(owned, { execPath }).action, 'installed');
  assert.equal(execOf(readFileSync(userDesktop(owned), 'utf8')).startsWith('/usr/bin/env -- '), true);
  writeSystem(owned);
  assert.equal(sync(owned, { execPath }).removedDesktop, true);
  assert.equal(existsSync(userDesktop(owned)), false);

  const foreign = fixture(t);
  const direct = legacyEntry('/opt/portable/diteng-agent').replace(
    'Comment=帝擎 ERP 桌面客户端',
    'X-Diteng-Agent-Managed=portable\nComment=帝擎 ERP 桌面客户端',
  ).replace('Exec=/opt/portable/diteng-agent', 'Exec=/opt/100%%/diteng-agent');
  putUserFile(foreign, direct);
  writeSystem(foreign);
  assert.equal(sync(foreign).removedDesktop, false);
  assert.equal(readFileSync(userDesktop(foreign), 'utf8'), direct);
});

test('旧模板在没有系统包时升级转义，路径里的空格不再拆成参数', (t) => {
  const fx = fixture(t);
  const execPath = '/home/user/My Apps/diteng-agent';
  putUserFile(fx, legacyEntry(execPath));
  const upgraded = sync(fx, { execPath });
  assert.equal(upgraded.action, 'updated');
  const content = readFileSync(userDesktop(fx), 'utf8');
  assert.equal(content.includes('X-Diteng-Agent-Managed=portable'), true);
  assert.equal(launchedPath(execOf(content)), execPath);
  assert.equal(readFileSync(userIcon(fx), 'utf8'), 'png-bytes-v1');
  const stamp = new Date('2020-01-01T00:00:00Z');
  utimesSync(userDesktop(fx), stamp, stamp);
  assert.equal(sync(fx, { execPath }).action, 'unchanged');
  assert.ok(Math.abs(statSync(userDesktop(fx)).mtimeMs - stamp.getTime()) < 2000);
});

test('免安装后再安装系统包：删除本程序的用户级条目，系统条目保留', (t) => {
  const fx = fixture(t);
  const execPath = '/home/user/My Apps/diteng-agent';
  assert.equal(sync(fx, { execPath }).action, 'installed');
  const system = writeSystem(fx);
  const removed = sync(fx, { execPath });
  assert.equal(removed.action, 'removed-user-entry');
  assert.equal(removed.removedDesktop, true);
  assert.equal(removed.removedIcon, true);
  assert.equal(existsSync(userDesktop(fx)), false);
  assert.equal(existsSync(userIcon(fx)), false);
  assert.equal(readFileSync(system, 'utf8').includes('Exec="/opt/diteng agent/diteng-agent" %U'), true);
  assert.equal(sync(fx, { execPath }).action, 'unchanged');
});

test('系统目录里带空格的桌面文件名同样视为安装版', (t) => {
  const fx = fixture(t);
  putUserFile(fx, legacyEntry('/opt/portable/diteng-agent'));
  mkdirSync(dirname(userIcon(fx)), { recursive: true });
  writeFileSync(userIcon(fx), 'png-bytes-v1');
  const system = writeSystem(fx, 'diteng agent.desktop', legacyEntry('/opt/diteng agent/diteng-agent'));
  const removed = sync(fx);
  assert.equal(removed.removedDesktop, true);
  assert.equal(existsSync(userDesktop(fx)), false);
  assert.equal(readFileSync(system, 'utf8'), legacyEntry('/opt/diteng agent/diteng-agent'));
});

test('第二个系统目录里的条目也会让用户级入口退役', (t) => {
  const fx = fixture(t);
  putUserFile(fx, legacyEntry('/opt/portable/diteng-agent'));
  const emptyDir = join(fx.root, 'empty-applications');
  mkdirSync(emptyDir, { recursive: true });
  const system = writeSystem(fx);
  const removed = sync(fx, { systemApplicationDirs: [emptyDir, fx.systemDir] });
  assert.equal(removed.removedDesktop, true);
  assert.equal(existsSync(system), true);
  assert.equal(existsSync(userDesktop(fx)), false);
});

test('清理边界：改过的用户条目、无关文件和系统文件都不删', (t) => {
  const cases = [
    ['改了名称', legacyEntry('/opt/portable/diteng-agent').replace('Name=diteng agent', 'Name=自定义')],
    ['改了注释', legacyEntry('/opt/portable/diteng-agent').replace('Comment=帝擎 ERP 桌面客户端', 'Comment=自己写的')],
    ['多了键', legacyEntry('/opt/portable/diteng-agent').replace('Terminal=false\n', 'Terminal=false\nKeywords=erp;\n')],
    ['改了分类', legacyEntry('/opt/portable/diteng-agent').replace('Categories=Office;', 'Categories=Office;Utility;')],
    ['Exec 加了 %U', legacyEntry('/opt/portable/diteng-agent %U')],
    ['Exec 加了参数', legacyEntry('/opt/portable/diteng-agent --debug')],
    ['没有结尾换行', legacyEntry('/opt/portable/diteng-agent').replace(/\n$/, '')],
    ['使用 CRLF', legacyEntry('/opt/portable/diteng-agent').replace(/\n/g, '\r\n')],
  ];
  for (const [label, content] of cases) {
    const fx = fixture(t);
    putUserFile(fx, content);
    const unrelated = join(fx.dataHome, 'applications', 'notes.desktop');
    const spaced = join(fx.dataHome, 'applications', 'diteng agent.desktop');
    writeFileSync(unrelated, 'notes');
    writeFileSync(spaced, 'spaced');
    const system = writeSystem(fx, 'diteng-agent.desktop', legacyEntry('/opt/diteng agent/diteng-agent'));
    const result = sync(fx);
    assert.equal(result.removedDesktop, false, label);
    assert.equal(result.action, 'kept-user-entry', label);
    assert.equal(readFileSync(userDesktop(fx), 'utf8'), content, label);
    assert.equal(readFileSync(unrelated, 'utf8'), 'notes', label);
    assert.equal(readFileSync(spaced, 'utf8'), 'spaced', label);
    assert.equal(readFileSync(system, 'utf8'), legacyEntry('/opt/diteng agent/diteng-agent'), label);
  }
});

test('用户级条目是符号链接时不删除、也不改写链接目标', (t) => {
  const linked = fixture(t);
  const outside = join(linked.root, 'custom.desktop');
  writeFileSync(outside, 'user managed\n');
  mkdirSync(dirname(userDesktop(linked)), { recursive: true });
  if (!tryLink(t, outside, userDesktop(linked))) return;
  writeSystem(linked);
  assert.equal(sync(linked).action, 'kept-user-entry');
  assert.equal(lstatSync(userDesktop(linked)).isSymbolicLink(), true);
  assert.equal(readFileSync(outside, 'utf8'), 'user managed\n');
});

test('同名目录不是桌面条目，不删除其中的文件', (t) => {
  const directory = fixture(t);
  mkdirSync(userDesktop(directory), { recursive: true });
  writeFileSync(join(userDesktop(directory), 'keep.txt'), 'keep');
  writeSystem(directory);
  assert.equal(sync(directory).removedDesktop, false);
  assert.equal(readFileSync(join(userDesktop(directory), 'keep.txt'), 'utf8'), 'keep');
});

test('图标只在字节一致时删除；用户换过的图标和自定义条目旁的图标保留', (t) => {
  const same = fixture(t);
  putUserFile(same, legacyEntry('/opt/portable/diteng-agent'));
  mkdirSync(dirname(userIcon(same)), { recursive: true });
  writeFileSync(userIcon(same), 'png-bytes-v1');
  writeSystem(same);
  assert.equal(sync(same).removedIcon, true);
  assert.equal(existsSync(userIcon(same)), false);

  const customIcon = fixture(t);
  putUserFile(customIcon, legacyEntry('/opt/portable/diteng-agent'));
  mkdirSync(dirname(userIcon(customIcon)), { recursive: true });
  writeFileSync(userIcon(customIcon), 'user-painted');
  writeSystem(customIcon);
  const removed = sync(customIcon);
  assert.equal(removed.removedDesktop, true);
  assert.equal(removed.removedIcon, false);
  assert.equal(readFileSync(userIcon(customIcon), 'utf8'), 'user-painted');

  const orphanDifferent = fixture(t);
  mkdirSync(dirname(userIcon(orphanDifferent)), { recursive: true });
  writeFileSync(userIcon(orphanDifferent), 'user-painted');
  writeSystem(orphanDifferent);
  assert.equal(sync(orphanDifferent).removedIcon, false);
  assert.equal(readFileSync(userIcon(orphanDifferent), 'utf8'), 'user-painted');

  const besideCustom = fixture(t);
  putUserFile(besideCustom, legacyEntry('/opt/portable/diteng-agent').replace('Name=diteng agent', 'Name=自定义'));
  mkdirSync(dirname(userIcon(besideCustom)), { recursive: true });
  writeFileSync(userIcon(besideCustom), 'png-bytes-v1');
  writeSystem(besideCustom);
  assert.equal(sync(besideCustom).action, 'kept-user-entry');
  assert.equal(readFileSync(userIcon(besideCustom), 'utf8'), 'png-bytes-v1');

  const preplaced = fixture(t);
  mkdirSync(dirname(userIcon(preplaced)), { recursive: true });
  writeFileSync(userIcon(preplaced), 'user-painted');
  assert.equal(sync(preplaced).action, 'installed');
  assert.equal(readFileSync(userIcon(preplaced), 'utf8'), 'user-painted');
});

test('图标是符号链接时不删除链接目标', (t) => {
  const linked = fixture(t);
  putUserFile(linked, legacyEntry('/opt/portable/diteng-agent'));
  const outside = join(linked.root, 'custom.png');
  writeFileSync(outside, 'custom-icon');
  mkdirSync(dirname(userIcon(linked)), { recursive: true });
  if (!tryLink(t, outside, userIcon(linked))) return;
  writeSystem(linked);
  assert.equal(sync(linked).removedDesktop, true);
  assert.equal(lstatSync(userIcon(linked)).isSymbolicLink(), true);
  assert.equal(readFileSync(outside, 'utf8'), 'custom-icon');
});

test('用户图标目录指向系统图标目录时不覆盖、也不补写系统图标', (t) => {
  const aliased = fixture(t);
  const share = join(aliased.root, 'system-share');
  const iconDir = join(share, 'icons', 'hicolor', '512x512', 'apps');
  mkdirSync(iconDir, { recursive: true });
  const systemIcon = join(iconDir, 'diteng-agent.png');
  writeFileSync(systemIcon, 'system-icon');
  mkdirSync(aliased.dataHome, { recursive: true });
  if (!tryLink(t, join(share, 'icons'), join(aliased.dataHome, 'icons'))) return;
  assert.equal(sync(aliased, { systemApplicationDirs: [join(share, 'applications')] }).action, 'installed');
  assert.equal(readFileSync(systemIcon, 'utf8'), 'system-icon');

  const created = fixture(t);
  const createdShare = join(created.root, 'system-share');
  mkdirSync(join(createdShare, 'icons'), { recursive: true });
  mkdirSync(created.dataHome, { recursive: true });
  if (!tryLink(t, join(createdShare, 'icons'), join(created.dataHome, 'icons'))) return;
  sync(created, { systemApplicationDirs: [join(createdShare, 'applications')] });
  assert.equal(existsSync(join(createdShare, 'icons', 'hicolor', '512x512', 'apps', 'diteng-agent.png')), false);
});

test('未打包和非 Linux 不注册也不清理', (t) => {
  const dev = fixture(t);
  putUserFile(dev, legacyEntry('/opt/portable/diteng-agent'));
  writeSystem(dev);
  const skipped = sync(dev, { isPackaged: false, execPath: '/workspace/node_modules/electron/dist/electron' });
  assert.equal(skipped.action, 'skipped-unpackaged');
  assert.equal(readFileSync(userDesktop(dev), 'utf8'), legacyEntry('/opt/portable/diteng-agent'));
  assert.equal(existsSync(userIcon(dev)), false);

  const mac = fixture(t);
  const result = sync(mac, { platform: 'darwin' });
  assert.equal(result.action, 'skipped-platform');
  assert.equal(existsSync(mac.dataHome), false);
});

test('控制字符和相对路径不写条目，已有条目保持原样', (t) => {
  for (const execPath of ['/opt/a\nb', '/opt/a\tb', 'relative/diteng-agent', '']) {
    const fx = fixture(t);
    const result = sync(fx, { execPath });
    assert.equal(result.action, 'skipped-unsafe-exec', JSON.stringify(execPath));
    assert.equal(result.wroteDesktop, false);
    assert.equal(existsSync(userDesktop(fx)), false);
  }
  const fx = fixture(t);
  sync(fx, { execPath: '/opt/portable/diteng-agent' });
  const before = readFileSync(userDesktop(fx), 'utf8');
  const skipped = sync(fx, { execPath: '/opt/a\nb' });
  assert.equal(skipped.action, 'skipped-unsafe-exec');
  assert.equal(readFileSync(userDesktop(fx), 'utf8'), before);
});

test('用户数据目录与系统应用目录是同一位置时不改文件', (t) => {
  const fx = fixture(t);
  const applications = join(fx.root, 'applications');
  mkdirSync(applications, { recursive: true });
  const desktop = join(applications, 'diteng-agent.desktop');
  const original = legacyEntry('/home/user/My Apps/diteng-agent');
  writeFileSync(desktop, original);
  const result = sync(fx, { dataHome: fx.root, systemApplicationDirs: [applications] });
  assert.equal(result.action, 'skipped-protected-location');
  assert.equal(result.removedDesktop, false);
  assert.equal(result.wroteDesktop, false);
  assert.equal(readFileSync(desktop, 'utf8'), original);
});
