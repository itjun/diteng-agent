import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function load(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', output)(module, module.exports);
  return module.exports;
}
const { shareablePageUrl, pageLabel, tabLabel } = load('../src/renderer/src/shell-presentation.ts');
const { isErpLogoutUrl, withSessionParams } = load('../src/main/url-policy.ts');
const session = { serverBase: 'https://m.cdcp.site', token: 'synthetic-session', machineCode: 'synthetic-device', corpNo: '250008' };
const aiBase = 'https://ai.cdcp.site';

test('展示和复制去凭据但保留业务参数，原导航地址保持不变', () => {
  const raw = 'https://name:password@m.cdcp.site/250008/FrmItem?sid=private&CLIENTID=device&device=pc&uid=42&name=%E4%B8%AD%E6%96%87&access_token=private#sid=private';
  const safe = new URL(shareablePageUrl(raw));
  assert.equal(safe.username, ''); assert.equal(safe.password, '');
  assert.deepEqual([...safe.searchParams], [['uid', '42'], ['name', '中文']]);
  assert.equal(safe.hash, ''); assert.ok(raw.includes('sid=private'));
});
test('大小写、重复参数和服务商 Key 同样剥离', () => {
  const safe = shareablePageUrl('https://erp.test/form?SID=a&sid=b&clientid=c&refreshToken=d&API_KEY=e&password=f&authorization=g&secret=h&view=list');
  assert.equal(safe, 'https://erp.test/form?view=list');
});
test('非法地址和非网页协议不可分享', () => {
  for (const url of ['', 'invalid', 'javascript:alert(1)', 'file:///tmp/private', 'data:text/plain,private']) assert.equal(shareablePageUrl(url), '');
});
test('页面加载时不用完整地址当标题，同名标签都有区分序号', () => {
  const url = 'https://erp.test/form?sid=private';
  assert.equal(pageLabel(url, url), 'erp.test');
  assert.equal(pageLabel(url, ''), 'erp.test');
  assert.equal(pageLabel('', 'anything'), '新建标签页');
  const tabs = ['1', '2'].map(id => ({id, url, title:'首页'}));
  assert.equal(tabLabel(tabs[0], tabs), '首页 · 1');
  assert.equal(tabLabel(tabs[1], tabs), '首页 · 2');
});
test('清理后的链接重新打开时仍由主进程补上当前会话，业务参数不丢', () => {
  const safe = shareablePageUrl(`${session.serverBase}/250008/FrmItem?sid=old&CLIENTID=old&uid=42`);
  const resolved = new URL(withSessionParams(safe, session, aiBase));
  assert.equal(resolved.searchParams.get('sid'), session.token);
  assert.equal(resolved.searchParams.get('CLIENTID'), session.machineCode);
  assert.equal(resolved.searchParams.get('uid'), '42');
});
test('兼容经典和新版退出页及 exit 动作，包括同站点家族', () => {
  for (const host of ['m.cdcp.site', 'std.cdcp.site']) {
    for (const form of ['TFrmLogout', 'TFrmLogout.exit', 'FrmLogout', 'FrmLogout.exit']) {
      assert.equal(isErpLogoutUrl(`https://${host}/250008/${form}?sid=synthetic`, session, aiBase), true);
    }
  }
});
test('外域伪装、AI 站及普通业务链接不会被误当作退出', () => {
  for (const url of ['https://evil.test/250008/TFrmLogout', 'https://m.cdcp.site.evil.test/250008/TFrmLogout', `${aiBase}/250008/TFrmLogout`, `${session.serverBase}/250008/FrmDefault?next=TFrmLogout`]) assert.equal(isErpLogoutUrl(url, session, aiBase), false);
});
