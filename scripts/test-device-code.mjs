import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';
import * as nodeChildProcess from 'node:child_process';
import * as nodeCrypto from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

function load(file, stubs = {}) {
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    assert.ok(name in stubs, `未预期的依赖：${name}`);
    return stubs[name];
  }, module, module.exports);
  return module.exports;
}

const code = load('src/main/device-code.ts', {
  'node:child_process': nodeChildProcess,
  'node:crypto': nodeCrypto,
  'node:fs': nodeFs,
  'node:os': nodeOs,
  'node:path': nodePath,
});

const disk = (letter, fileSystem, serial) => ({ letter, fileSystem, serial });

test('XOR 编码向量：与 ApConst.pas Encrypt(Value, PSW, True) 的逐字节结果一致', () => {
  // 手工按字节异或推导的期望值：serial '777E7673' × 盐 '0123…'（盐长 32，逐位对齐）
  assert.equal(code.encryptVolumeCode('777E7673', '0123456789abcdef0123456789abcdef'), '0706057603030104');
  // 盐短于序列号时按 i mod len 循环：serial '777E7673' × 盐 'abcd'
  assert.equal(code.encryptVolumeCode('777E7673', 'abcd'), '5655542156545457');
  assert.equal(code.encryptVolumeCode('', 'abcd'), '');
  assert.equal(code.encryptVolumeCode('777E7673', ''), '');
});

test('盘符选择：系统盘之后第一个 NTFS/FAT32 固定盘优先，exFAT 不入选，系统盘之前的盘忽略', () => {
  const system = disk('C', 'NTFS', 'SER_C_1');
  // D 为 NTFS 数据盘 → 选中 D
  assert.equal(code.selectPreferredDisk([system, disk('D', 'NTFS', 'SER_D_1')], 'C').serial, 'SER_D_1');
  // 数据盘为 exFAT → 回落系统盘
  assert.equal(code.selectPreferredDisk([system, disk('D', 'exFAT', 'SER_D_1')], 'C').serial, 'SER_C_1');
  // 系统盘前的固定盘（B）既不入选也不推进标记；跳过 exFAT 的 D，接受 FAT32 的 F
  assert.equal(
    code.selectPreferredDisk([disk('B', 'NTFS', 'SER_B_1'), system, disk('D', 'exFAT', 'SER_D_1'), disk('F', 'FAT32', 'SER_F_1')], 'C').serial,
    'SER_F_1',
  );
  // 无合格数据盘且未列出系统盘 → null
  assert.equal(code.selectPreferredDisk([disk('D', 'exFAT', 'SER_D_1')], 'C'), null);
  assert.deepEqual(code.selectPreferredDisk([], 'C'), null);
});

test('INI 读写：读取既有节键（大小写不敏感）、替换保留其余内容、缺失时追加新节', () => {
  const original = '; 注释\r\n[OTHER]\r\nname=地藤\r\n\r\n[{DAB8ECD7-69D8-4161-A364-CA71A387C154}]\r\nMachNo=abc123\r\n';
  assert.equal(code.readIniValue(original, '{dab8ecd7-69d8-4161-a364-ca71a387c154}', 'machno'), 'abc123');
  assert.equal(code.readIniValue(original, 'OTHER', 'name'), '地藤');
  assert.equal(code.readIniValue(original, 'MISSING', 'name'), null);

  const replaced = code.upsertIniValue(original, '{DAB8ECD7-69D8-4161-A364-CA71A387C154}', 'MachNo', 'ffeeddcc');
  assert.equal(code.readIniValue(replaced, '{DAB8ECD7-69D8-4161-A364-CA71A387C154}', 'MachNo'), 'ffeeddcc');
  // 其余节与注释原样保留
  assert.ok(replaced.includes('[OTHER]'));
  assert.ok(replaced.includes('name=地藤'));
  assert.ok(replaced.startsWith('; 注释'));

  const appended = code.upsertIniValue('[OTHER]\r\nname=x\r\n', '{DAB8ECD7-69D8-4161-A364-CA71A387C154}', 'MachNo', '00112233');
  assert.equal(code.readIniValue(appended, '{DAB8ECD7-69D8-4161-A364-CA71A387C154}', 'MachNo'), '00112233');
  assert.equal(code.readIniValue(appended, 'OTHER', 'name'), 'x');
});

test('Windows 编码：选中盘序列号补零到 8 位后编码；序列号缺失或盐缺失返回空串', () => {
  const disks = [disk('C', 'NTFS', '777E7673'), disk('D', 'NTFS', 'AA1')];
  const salt = '0123456789abcdef0123456789abcdef';
  // 选中 D 盘：'AA1' 补零为 '00000AA1'
  assert.equal(code.windowsCodeFrom(disks, 'C', salt), code.encryptVolumeCode('00000AA1', salt));
  // 选中盘无序列号 → 空（对齐 GetVolumeInformation 失败时的退化路径）
  assert.equal(code.windowsCodeFrom([disk('C', 'NTFS', '777E7673'), disk('D', 'NTFS', '')], 'C', salt), '');
  assert.equal(code.windowsCodeFrom(disks, 'C', null), '');
  assert.ok(/^[0-9A-F]{16}$/.test(code.windowsCodeFrom(disks, 'C', salt)));
});

test('硬件 UUID 哈希为 16 位大写 hex（sha256 前 16 位）', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const expected = createHash('sha256').update(uuid).digest('hex').slice(0, 16).toUpperCase();
  assert.equal(code.hardwareUuidToCode(uuid), expected);
  assert.ok(/^[0-9A-F]{16}$/.test(code.hardwareUuidToCode(uuid)));
});

test('getDeviceCode：采集成功用新值，失败沿用已存值，首次即失败才随机生成', () => {
  assert.equal(code.getDeviceCode('OLD-UUID', () => '0706057603030104'), '0706057603030104');
  // 非法计算结果（空串/格式错误）沿用已存值，保住服务端设备验证绑定
  assert.equal(code.getDeviceCode('OLD-UUID', () => ''), 'OLD-UUID');
  assert.equal(code.getDeviceCode('OLD-UUID', () => 'zz'), 'OLD-UUID');
  // 采集抛异常同样兜底
  assert.equal(code.getDeviceCode('OLD-UUID', () => { throw new Error('powershell 缺失'); }), 'OLD-UUID');
  // 首次即失败：随机生成 16 位大写 hex（持久化于 config.json，此后稳定）
  assert.match(code.getDeviceCode('', () => ''), /^[0-9A-F]{16}$/);
  assert.match(code.getDeviceCode('', () => { throw new Error('offline'); }), /^[0-9A-F]{16}$/);
});
