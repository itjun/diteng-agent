/** 临时 userData + 私有Vite端口 + 127.0.0.1后端；不读取凭据、不接管现有应用。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { _electron } from 'playwright-core';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'diteng-coordination-e2e-'));
const corps = [ {corpNo:'100001',code:'a1',name:'甲账套',shortName:'甲'}, {corpNo:'100002',code:'a2',name:'乙账套',shortName:'乙'} ];
let corp = corps[0];
let switches = 0;
let isHttpFailure = false;
let unreadNotifications = [];
const openedNotificationUids = [];
const expectedHeaders = [];
const readBody = (req) => new Promise((resolve) => { let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>resolve(data)); });
const backend = createServer(async (req,res) => {
  const url = new URL(req.url,'http://127.0.0.1');
  const body = await readBody(req);
  const json=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(url.pathname==='/services/SvrUserLogin.getToken') {
    return json({state:1,head:{status:1,token:'mock-token',corpNo:corp.corpNo,homeForm:'FrmDefault',startPage:`${corp.corpNo}/FrmDefault`},body:[[]]});
  }
  if(url.pathname==='/center/UserServer/getTokenInfo') return json({userId:'account-a',userCode:corp.code,userName:'测试',corpNo:corp.corpNo});
  if(url.pathname==='/services/SvrAccountManage.listMyLivingUsers') return json({state:1,head:{},body:corps.map(item=>({CorpNo_:item.corpNo,Code_:item.code,Name_:item.name,ShortName_:item.shortName}))});
  if(url.pathname.endsWith('FrmMessages.mqttConfig')) return json({broker:''});
  if(url.pathname.endsWith('ImServer.getUnreadMessage')) return json({state:1,data:0});
  if(url.pathname==='/public/desktop-agent/notifications') return json({items:unreadNotifications,nextCursor:null});
  if(url.pathname==='/services/SvrTerminal.getNuewToken') {
    const input=JSON.parse(new URLSearchParams(body).get('dataIn'));
    corp=corps.find(item=>item.corpNo===input.head.target_book)||corp;
    return json({state:1,head:{target_book_token:'mock-token'},body:[]});
  }
  if(url.pathname.endsWith('FrmMyMessage.desktopNotification')) openedNotificationUids.push(url.searchParams.get('uid'));
  if(url.pathname.endsWith('TFrmChooseAccount.switchUser')) {
    expectedHeaders.push(req.headers['x-diteng-expected-corp-no']);
    switches++;
    corp=corps.find(item=>item.code===new URLSearchParams(body).get('code'))||corp;
    return json(isHttpFailure?{result:false,message:'模拟响应失败'}:{result:true,url:`${url.origin.replace('http://127.0.0.1',base)}/${corp.corpNo}/FrmDefault?sid=mock-token&CLIENTID=test-device`,corpNo:corp.corpNo,userCode:corp.code},isHttpFailure?500:200);
  }
  if(url.pathname==='/center/UserServer/logout') return json({});
  res.writeHead(200,{'content-type':'text/html'});
  res.end(`<!doctype html><html><head><title>账套${corp.corpNo}</title></head><body><h1>账套${corp.corpNo}</h1><p>当前页面可见内容</p><p style="display:none">HIDDEN_SECRET_TEST</p><input value="PASSWORD_SECRET_TEST"><script>window.sendAccountChannel=()=>sessionStorage.setItem('broadcast','yes');window.testSwitch=(code)=>fetch('/100001/TFrmChooseAccount.switchUser?sid=mock-token&CLIENTID=test-device',{method:'POST',body:new URLSearchParams({code})}).then(r=>r.json()).then(data=>{sessionStorage.setItem('callbacks',String(Number(sessionStorage.getItem('callbacks')||0)+1));sendAccountChannel();if(data.result)location.href=data.url;return data;}).catch(()=>({cancelled:true}));</script></body></html>`);
});
await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${backend.address().port}`;
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const vitePort=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
writeFileSync(join(directory,'config.json'),JSON.stringify({configVersion:2,serverBase:base,aiBase:base,machineCode:'test-device',autoLogin:false,rememberPassword:false}));
// 使用预先完成的 pnpm build 产物；本脚本不改写 dist，允许与独立源码检查共用稳定构建。
const vite=spawn(join(root,'node_modules/.bin/vite'),['--host','127.0.0.1','--port',String(vitePort),'--strictPort'],{cwd:root,stdio:'pipe'});
let viteLogs='';vite.stderr.on('data',data=>viteLogs+=data);vite.stdout.on('data',data=>viteLogs+=data);
const viteUrl=`http://127.0.0.1:${vitePort}`;
let electron;
const waitFor=async(test,timeout=15000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await test())return;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error('等待条件超时');};
try {
  await waitFor(async()=>{try{return (await fetch(viteUrl)).ok;}catch{return false;}});
  const executablePath=process.env.DITENG_E2E_EXECUTABLE;
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  if(executablePath)delete env.DITENG_AGENT_DEV_URL;else env.DITENG_AGENT_DEV_URL=viteUrl;
  electron=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:['.']),`--user-data-dir=${directory}`],cwd:root,env,timeout:25000});
  assert.equal(realpathSync(await electron.evaluate(({app})=>app.getPath('userData'))),realpathSync(directory));
  await electron.evaluate(({dialog})=>{globalThis.__confirmMode='cancel';globalThis.__confirmWaiters=[];dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(!options.message.startsWith('切换到'))return {response:0};if(globalThis.__confirmMode==='wait')return new Promise(resolve=>globalThis.__confirmWaiters.push(resolve));return {response:globalThis.__confirmMode==='allow'?1:0};};});
  const login=await electron.firstWindow();await login.waitForFunction(()=>Boolean(window.diteng));
  const loginEntryUrl=login.url();
  if(executablePath)assert.match(loginEntryUrl,/^file:/);
  await login.evaluate(base=>{void window.diteng.login({serverBase:base,loginId:'test',password:'test-only',rememberPassword:false});},base);
  let main;
  await waitFor(async()=>{main=electron.windows().find(page=>page.url().includes('#/main'));return Boolean(main);});
  await main.waitForSelector('[data-testid="new-tab"]');
  await waitFor(()=>electron.evaluate(({webContents})=>webContents.getAllWebContents().some(item=>item.getType()==='webview'&&item.getURL().includes('FrmDefault'))));
  const guestIds=()=>electron.evaluate(({webContents})=>webContents.getAllWebContents().filter(item=>item.getType()==='webview').map(item=>item.id));
  const execute=(id,script)=>electron.evaluate(({webContents},{id,script})=>webContents.fromId(id).executeJavaScript(script),{id,script});
  const source=(await guestIds())[0];
  await waitFor(()=>execute(source,`typeof window.testSwitch==='function'`));
  const cancelled=await execute(source,`window.testSwitch('a2')`);
  assert.equal(cancelled.cancelled,true);assert.equal(switches,0);assert.equal((await main.evaluate(()=>window.diteng.getSession())).corpNo,'100001');
  console.log('PASS 原请求前取消：服务端0次切换，页面和身份保持');
  await main.getByTestId('new-tab').click();await main.getByTestId('quicklink-erp').click();await waitFor(async()=> (await guestIds()).length===2);
  await electron.evaluate(()=>{globalThis.__confirmMode='wait';});
  await execute(source,`void window.testSwitch('a2')`);
  await waitFor(()=>electron.evaluate(()=>globalThis.__confirmWaiters.length===1));
  assert.equal(switches,0);
  await electron.evaluate(()=>{globalThis.__confirmWaiters.shift()({response:1});});
  await waitFor(async()=> (await main.evaluate(()=>window.diteng.getSession())).corpNo==='100002');
  await waitFor(async()=> (await guestIds()).length===1);
  assert.equal((await guestIds())[0],source);assert.equal(switches,1);assert.deepEqual(expectedHeaders,['100001']);
  await waitFor(()=>execute(source,`location.pathname.startsWith('/100002/')`));
  assert.equal(await execute(source,`sessionStorage.getItem('callbacks')`),'1');
  assert.equal(await execute(source,`sessionStorage.getItem('broadcast')`),null);
  console.log('PASS 切换期间另一个标签活跃：只保留原发起guest，原fetch回调执行一次，旧广播被屏蔽');
  isHttpFailure=true;
  await electron.evaluate(()=>{globalThis.__confirmMode='allow';});
  await execute(source,`void window.testSwitch('a1')`);
  await waitFor(async()=> (await main.evaluate(()=>window.diteng.getSession())).corpNo==='100001');
  await waitFor(()=>execute(source,`location.pathname.startsWith('/100001/')`));
  assert.equal(switches,2);assert.deepEqual(expectedHeaders,['100001','100002']);
  console.log('PASS HTTP 500但token已变：权威核验后落到新账套，未保留旧身份页');
  await main.getByTestId('toolbar-chat').click();
  await waitFor(async()=> (await guestIds()).length===2);
  const aiGuest=(await guestIds()).find(id=>id!==source);
  const aiUrl=new URL(await execute(aiGuest,'location.href'));
  assert.equal(aiUrl.origin,base);assert.equal(aiUrl.pathname,'/100001/chat');
  assert.equal(aiUrl.searchParams.get('sid'),'mock-token');
  assert.equal(await main.evaluate(()=>typeof window.diteng.agent),'undefined');
  await main.bringToFront();
  await main.getByTestId('toolbar-chat').focus();
  // CDP Input.dispatchKeyEvent 不经过 Electron before-input-event；用原生输入入口验证快捷键。
  await electron.evaluate(({BrowserWindow})=>{
    const owner=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('#/main'));
    owner.focus();owner.webContents.focus();
    owner.webContents.sendInputEvent({type:'keyDown',keyCode:'W',modifiers:['meta']});
    owner.webContents.sendInputEvent({type:'keyUp',keyCode:'W',modifiers:['meta']});
  });
  await waitFor(async()=> (await guestIds()).length===1);
  console.log('PASS 工具栏打开 Web AI 普通网页标签，无本地 AI API');
  // 仅在临时进程内捕获已有服务实例，驱动真实HTTP补查/窗口/IPC链路。
  await electron.evaluate(({app})=>{const {MqttService}=process.mainModule.require(`${app.getAppPath()}/dist/main/mqtt-service.js`);const original=MqttService.prototype.getState;MqttService.prototype.getState=function(){globalThis.__testMqtt=this;MqttService.prototype.getState=original;return original.call(this);};});
  await main.evaluate(()=>window.diteng.getMqttState());
  unreadNotifications=[{uid:'test-urgent-1',corpNo:'100002',userCode:'a2',level:2,subject:'第一条紧急通知',content:'离线恢复内容1',sendTime:'2026-10-24T11:00:00+08:00'},{uid:'test-urgent-2',corpNo:'100002',userCode:'a2',level:2,subject:'第二条紧急通知',content:'离线恢复内容2',sendTime:'2026-10-24T11:01:00+08:00'},{uid:'test-logger',corpNo:'100002',userCode:'a2',level:3,subject:'日志不置顶',content:'日志',sendTime:'2026-10-24T11:02:00+08:00'}];
  await electron.evaluate(()=>globalThis.__testMqtt.recoverUnread());
  let popup;await waitFor(async()=>{popup=electron.windows().find(page=>page.url().includes('#/notify-popup'));return Boolean(popup);});
  await popup.getByTestId('important-popup').waitFor();
  assert.match(await popup.getByTestId('important-popup').innerText(),/第一条紧急通知/);
  assert.match(await popup.getByTestId('important-popup').innerText(),/待处理 2 条/);
  assert.equal(await popup.evaluate(()=>typeof window.diteng.agent),'undefined');
  const nativePopup=await electron.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('#/notify-popup'));return {isAlwaysOnTop:p.isAlwaysOnTop(),isFocused:p.isFocused()};});
  assert.equal(nativePopup.isAlwaysOnTop,true);assert.equal(nativePopup.isFocused,false);
  await electron.evaluate(()=>{globalThis.__confirmMode='cancel';});
  await popup.getByTestId('important-popup').click();
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal((await main.evaluate(()=>window.diteng.getSession())).corpNo,'100001');
  assert.match(await popup.getByTestId('important-popup').innerText(),/第一条紧急通知/);
  await electron.evaluate(()=>{globalThis.__confirmMode='allow';});
  await popup.getByTestId('important-popup').click();
  await waitFor(()=>openedNotificationUids.includes('test-urgent-1'));
  assert.equal((await main.evaluate(()=>window.diteng.getSession())).corpNo,'100002');
  await waitFor(async()=>/第二条紧急通知/.test(await popup.getByTestId('important-popup').innerText()));
  await popup.getByRole('button',{name:'关闭提醒',exact:true}).click();
  await waitFor(()=>electron.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('#/notify-popup'))));
  assert.deepEqual(openedNotificationUids,['test-urgent-1']);
  console.log('PASS 真实紧急窗口不抢焦点/不覆盖/无本地AI IPC；取消切换保留提醒、确认后携UID进目标账套，关闭不打开或标读');
  await electron.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('#/main'));window.close();});
  const hidden=await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(item=>item.webContents.getURL().includes('#/main')&&!item.isVisible()));
  assert.equal(hidden,true);console.log('PASS 关窗隐藏托盘，客户端仍运行');
} catch(error) {
  console.error('隔离 E2E 失败：',error);
  throw error;
} finally {
  if(electron) {
    // 只清理本测试刚创建的临时进程，超时不影响用户应用。
    const cleanup=setTimeout(()=>electron.process().kill('SIGKILL'),5000);
    try { await electron.close().catch(()=>{}); } finally { clearTimeout(cleanup); }
  }
  vite.kill('SIGTERM');await new Promise(resolve=>backend.close(resolve));rmSync(directory,{recursive:true,force:true});
}
