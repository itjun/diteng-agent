/**
 * 本地 mock 后端（仅本地 e2e，绝不对真实环境发起任何请求）。
 * 供 e2e-webview-switch.mjs 离线验证「账套切换 → 主进程会话同步 → 设置页/用户行刷新」链路。
 *
 * 覆盖端点（协议对齐 ravenclaw diteng-im-server 现行实现）：
 *   POST /services/SvrUserLogin.getToken             登录（DataSet），token 对应起始账套 250059/25005902
 *   POST /center/UserServer/getTokenInfo             token → {userId,userCode,userName,corpNo}（无 corpName，
 *                                                    与 TokenInfo.java 一致；账套简称只由 listMyLivingUsers 的 ShortName_ 提供）
 *   POST /center/UserServer/logout                   登出
 *   POST /services/SvrAccountManage.listMyLivingUsers 账套列表（CorpNo_/Code_/Name_/ShortName_）
 *   POST /services/SvrTerminal.getNuewToken          换票（返回 T_MOCK_<目标账套号>）
 *   POST /{corpNo}/TFrmChooseAccount.switchUser     经典页切账套：按 body code 校验目标子账号，
 *                                                    把 query sid（当前 token）在 mock 里原地改绑到目标账套
 *                                                    （模拟服务端 updateTokenOptions），返回 {result,url}，
 *                                                    url 为「同一 sid + 新账套号」（对齐真实页面 location.href=data.url）
 *   POST *FrmMessages.mqttConfig                     MQTT 未启用
 *   POST *ImServer.getUnreadMessage                  未读 0
 *   GET  /{corpNo}/{form}…                           ERP 占位页（页面内容不参与断言）
 *
 * token 约定（都能反查账套，供 getTokenInfo 使用）：
 *   T_MOCK_ROOT_0001               登录 token → 250059（登录时绑定）
 *   T_MOCK_250050 / T_MOCK_250059  getNuewToken 发出的目标账套 token（发出时绑定）
 *   T_MOCK_SSR_250059              合成的 SSR sid（任意以 6 位账套号结尾的 token 均可）
 * switchUser 会改写 token 绑定：同一 token 的 getTokenInfo 随之后返回新账套（对齐真实服务端）。
 *
 * 用法：node scripts/e2e-mock-server.mjs [端口=8788]（只监听 127.0.0.1）
 * 调用记录：GET /__calls 返回 JSON 明细（kind/detail/at），token 只记前缀，供断言换票/取信次数。
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8788);
const HOST = '127.0.0.1';

/** 账套列表：对齐 SvrAccountManage.listMyLivingUsers —— Name_ 为子账号名称，ShortName_ 为账套简称（UI 账套名称） */
const CORPS = [
  { corpNo: '250059', code: '25005902', name: '黄荣君', shortName: '盛世浩淼' },
  { corpNo: '250050', code: '25005001', name: '中储粮天津子账号', shortName: '中储粮(天津)' },
];

/** 账号级用户名：getTokenInfo.userName 取账号表 UserName_，与账套无关（对齐 UserCenterService.getTokenInfo） */
const ACCOUNT_USER_NAME = '黄荣君';

/** 登录 token；换出的账套 token 形如 T_MOCK_<corpNo> */
const ROOT_TOKEN = 'T_MOCK_ROOT_0001';

/** token → 账套号动态绑定：登录/换票建立，switchUser 原地改绑（对齐真实服务端只刷新同一 token 的会话选项） */
const tokenBindings = new Map();

const calls = [];

function record(kind, detail) {
  calls.push({ seq: calls.length + 1, kind, detail, at: new Date().toISOString() });
  console.log(`[mock] ${kind} ${detail ?? ''}`);
}

/** token 只记前 14 位，避免完整凭据落进日志/调用记录 */
function tokenPrefix(token) {
  const text = String(token ?? '');
  return text.length > 14 ? `${text.slice(0, 14)}…` : text || '(空)';
}

const corpByCorpNo = (corpNo) => CORPS.find((corp) => corp.corpNo === String(corpNo ?? '')) ?? null;
const corpByCode = (code) => CORPS.find((corp) => corp.code === String(code ?? '')) ?? null;

/** 绑定 token → 账套号（登录/换票建立，switchUser 原地改绑） */
function bindToken(token, corp) {
  const text = String(token ?? '');
  if (text) tokenBindings.set(text, corp.corpNo);
}

/**
 * token → 账套：优先取动态绑定（登录/换票/switchUser 会写入），
 * 未绑定的合成 sid（如 T_MOCK_SSR_250059）按结尾 6 位账套号反查。
 */
function corpOfToken(token) {
  const text = String(token ?? '');
  if (!text) return null;
  const bound = tokenBindings.get(text);
  if (bound) return corpByCorpNo(bound);
  const suffix = text.match(/(\d{6})$/);
  return suffix ? corpByCorpNo(suffix[1]) : null;
}

function dataSet(head, body = [[]]) {
  return { state: 1, message: '', head, body };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

/** 解析 form 编码的 dataIn（Svr 服务协议：单字段 dataIn 存 JSON） */
async function readDataIn(req) {
  const form = new URLSearchParams(await readBody(req));
  const dataIn = form.get('dataIn');
  return dataIn ? JSON.parse(dataIn) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // 调用明细（e2e 断言 getNuewToken / getTokenInfo 次数的唯一数据源）
  if (req.method === 'GET' && url.pathname === '/__calls') {
    return send(200, calls);
  }
  if (req.method === 'GET' && url.pathname === '/__health') {
    return send(200, { ok: true, port: PORT, corps: CORPS.map((corp) => corp.corpNo) });
  }

  // 登录：head 出参对齐 SvrUserLogin.getToken.getTokenInfo（startPage 决定落点账套）
  if (req.method === 'POST' && url.pathname === '/services/SvrUserLogin.getToken') {
    const dataIn = await readDataIn(req);
    const headIn = dataIn.head ?? {};
    record('login', `userCode=${headIn.userCode ?? ''} clientId=${tokenPrefix(headIn.clientId)}`);
    // 短信验证码指令（本 e2e 不走短信流程，仅保留协议形态）
    if (headIn.verifyCode === '??????') {
      return send(200, dataSet({ status: 1 }));
    }
    const first = CORPS[0];
    // 登录建立 token 绑定（每次登录重置，保证测试确定性）：登录 token 对应起始账套
    tokenBindings.clear();
    bindToken(ROOT_TOKEN, first);
    return send(
      200,
      dataSet({
        status: 1,
        token: ROOT_TOKEN,
        user_code: first.code,
        startPage: `${first.corpNo}/FrmDefault`,
        corpNo: first.corpNo,
        homeForm: 'FrmDefault',
        forceRedirect: false,
        redirectUrl: '',
      }),
    );
  }

  // token 信息：真实接口只有 userId/userCode/userName/corpNo（无 corpName），返 faithfully 模拟
  if (req.method === 'POST' && url.pathname === '/center/UserServer/getTokenInfo') {
    const body = await readBody(req);
    let request = {};
    try {
      request = JSON.parse(body);
    } catch {
      return send(400, { code: 0, message: '请求体不是合法 JSON' });
    }
    const corp = corpOfToken(request.token);
    record(
      'getTokenInfo',
      `machineCode=${tokenPrefix(request.machineCode)} token=${tokenPrefix(request.token)} corpNo=${corp?.corpNo ?? '未知'}`,
    );
    if (!corp) {
      // 对齐真实服务：token 失效返回 HTTP 400 + {code, message}
      return send(400, { code: 0, message: 'token已失效请登录' });
    }
    return send(200, {
      userId: `U_MOCK_${corp.corpNo}`,
      userCode: corp.code,
      userName: ACCOUNT_USER_NAME,
      corpNo: corp.corpNo,
      options: {
        token: String(request.token ?? ''),
        user_id: `U_MOCK_${corp.corpNo}`,
        user_code: corp.code,
        corp_no: corp.corpNo,
        user_name: ACCOUNT_USER_NAME,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/center/UserServer/logout') {
    record('logout', '');
    return send(200, {});
  }

  // 账套列表（仅查询）：首行字段名 + 数据行，对齐 readDataSetRows 兼容形态
  if (req.method === 'POST' && url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
    const dataIn = await readDataIn(req);
    record('listMyLivingUsers', `userCode=${dataIn.head?.userCode ?? '(会话)'}`);
    return send(
      200,
      dataSet(
        {},
        [
          ['CorpNo_', 'Code_', 'Name_', 'ShortName_'],
          ...CORPS.map((corp) => [corp.corpNo, corp.code, corp.name, corp.shortName]),
        ],
      ),
    );
  }

  // 账套换票：校验为已知目标账套后，返回该账套 token（getTokenInfo 可据此反查账套）
  if (req.method === 'POST' && url.pathname === '/services/SvrTerminal.getNuewToken') {
    const dataIn = await readDataIn(req);
    const headIn = dataIn.head ?? {};
    const target = CORPS.find((corp) => corp.corpNo === String(headIn.target_book ?? ''));
    record(
      'getNuewToken',
      `current=${tokenPrefix(headIn.current_book_token)} target_book=${headIn.target_book ?? ''} 命中=${target ? '是' : '否'}`,
    );
    if (!target) return send(200, { state: -1, message: '目标账套不存在' });
    const newToken = `T_MOCK_${target.corpNo}`;
    // 换票发出的 token 绑定目标账套（getTokenInfo 随返回新账套）
    bindToken(newToken, target);
    return send(200, dataSet({ target_book_token: newToken }));
  }

  // 经典页切账套（真实页面 TFrmChooseAccount.switchUser）：服务端只刷新同一 token 的会话选项、
  // 不换 token；页面拿到 data.url 后整页跳转（同一 sid + 新账套号）。mock 同步改绑 token。
  const switchUserMatch = url.pathname.match(/^\/(\d{5,8})\/TFrmChooseAccount\.switchUser$/);
  if (req.method === 'POST' && switchUserMatch) {
    const currentCorpNo = switchUserMatch[1];
    const form = new URLSearchParams(await readBody(req));
    const targetCode = form.get('code') ?? form.get('userCode') ?? '';
    const sid = url.searchParams.get('sid') ?? '';
    const target = corpByCode(targetCode);
    record(
      'switchUser',
      `corpNo=${currentCorpNo} code=${targetCode} sid=${tokenPrefix(sid)} 命中=${target ? target.corpNo : '否'}`,
    );
    if (!sid) return send(200, { result: false, message: '登录已失效，请重新登录' });
    if (!target) return send(200, { result: false, message: '无效的用户，请重新选择' });
    // 原地改绑：同一 token 之后的 getTokenInfo 返回新账套/子账号
    bindToken(sid, target);
    const clientId = url.searchParams.get('CLIENTID') ?? 'e2e';
    const entryUrl =
      `http://${HOST}:${PORT}/${target.corpNo}/FrmDefault` +
      `?sid=${encodeURIComponent(sid)}&CLIENTID=${encodeURIComponent(clientId)}&device=pc`;
    return send(200, {
      result: true,
      message: `你已切换到 ${target.shortName || target.name}，请关闭浏览器其他标签页`,
      corpNo: target.corpNo,
      userCode: target.code,
      url: entryUrl,
    });
  }

  // MQTT 配置：明确返回未启用，mqttService 跳过连接（避免任何外部 broker 连接）
  if (req.method === 'POST' && /FrmMessages\.mqttConfig$/.test(url.pathname)) {
    record('mqttConfig', '');
    return send(200, { result: false, message: 'mock 未启用 MQTT' });
  }

  if (req.method === 'POST' && /ImServer\.getUnreadMessage$/.test(url.pathname)) {
    return send(200, { result: true, data: 0 });
  }

  // ERP 页面（/{corpNo}/{form}…）：静态占位 HTML，页面内容不参与断言
  if (req.method === 'GET' && /^\/\d{5,8}\//.test(url.pathname)) {
    const corpNo = url.pathname.split('/')[1];
    record('page', url.pathname);
    return send(
      200,
      `<!doctype html><html><head><meta charset="utf-8"><title>mock ${corpNo} ${url.pathname.split('/')[2] ?? ''}</title></head><body>mock page ${url.pathname}</body></html>`,
      'text/html; charset=utf-8',
    );
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    return send(404, '', 'text/plain');
  }

  record('unmatched', `${req.method} ${url.pathname}`);
  return send(404, { message: 'mock 未实现该端点' });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock] diteng mock server http://${HOST}:${PORT}（账套 ${CORPS.map((corp) => `${corp.corpNo}/${corp.shortName}`).join('、')}）`);
});
