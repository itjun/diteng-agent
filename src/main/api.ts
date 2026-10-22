import type { ApiCallResult, ApiFailure, CorpAccount, LoginResult, MqttBrokerConfig } from '../shared/types';

/**
 * 所有后端 HTTP 仅在主进程发起（渲染层经 IPC 调用），规避浏览器 CORS 限制。
 * 目标为本地 diteng-im-server 的 UserServerController（POST JSON）。
 */
const REQUEST_TIMEOUT_MS = 10_000;

function endpoint(serverBase: string, action: string): string {
  return `${serverBase.replace(/\/+$/, '')}/center/UserServer/${action}`;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * 解析 GlobalExceptionHandler 的错误结构：HTTP 400 + {"code":...,"message":...}。
 * code=-8 设备未验证（ApiException），code=0 参数/业务错误（IllegalArgumentException）。
 */
async function toFailure(response: Response): Promise<ApiFailure> {
  let code = response.status;
  let message = '';
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === 'number') code = body.code;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // 非 JSON 错误体（如 Spring 默认 500 页面），保留 HTTP 状态码
  }
  if (!message) message = `请求失败（HTTP ${response.status}）`;
  return { ok: false, code, message };
}

function networkFailure(error: unknown): ApiFailure {
  const detail = error instanceof Error ? error.message : String(error);
  // undici 的 TypeError 只有 "fetch failed"，真实原因挂在 cause（如证书、DNS、代理）
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? (error.cause as Error & { code?: string })
      : undefined;
  const causeDetail = cause
    ? `：${cause.code ?? cause.name} ${cause.message}`
    : '';
  return { ok: false, code: -1, message: `无法连接服务器：${detail}${causeDetail}` };
}

/** 密码登录；设备未验证时后端返回 HTTP 400 + code -8 */
export async function loginByPassword(
  serverBase: string,
  machineCode: string,
  loginId: string,
  password: string,
): Promise<ApiCallResult<LoginResult>> {
  try {
    const response = await postJson(endpoint(serverBase, 'loginByPassword'), {
      machineCode,
      loginId,
      password,
      device: 'pc',
    });
    if (!response.ok) return toFailure(response);
    return { ok: true, data: (await response.json()) as LoginResult };
  } catch (error) {
    return networkFailure(error);
  }
}

/** 获取图形验证码；TEXT_PLAIN 响应即码值本身（dev 固定 "0000"），5 分钟内有效 */
export async function getCheckCode(
  serverBase: string,
  machineCode: string,
): Promise<ApiCallResult<string>> {
  try {
    const response = await postJson(endpoint(serverBase, 'getCheckCode'), { machineCode });
    if (!response.ok) return toFailure(response);
    return { ok: true, data: (await response.text()).trim() };
  } catch (error) {
    return networkFailure(error);
  }
}

/**
 * 发送短信验证码（先校验图形码）；
 * dev 环境响应体直接回显短信验证码便于联调，生产返回 "true"。
 */
export async function sendVerifyCode(
  serverBase: string,
  machineCode: string,
  loginId: string,
  checkCode: string,
): Promise<ApiCallResult<string>> {
  try {
    const response = await postJson(endpoint(serverBase, 'sendVerifyCode'), {
      machineCode,
      loginId,
      checkCode,
    });
    if (!response.ok) return toFailure(response);
    return { ok: true, data: (await response.text()).trim() };
  } catch (error) {
    return networkFailure(error);
  }
}

/** 短信验证码登录：完成设备验证并换取 token，成功返回 LoginResult */
export async function getTokenBySms(
  serverBase: string,
  machineCode: string,
  loginId: string,
  verifyCode: string,
): Promise<ApiCallResult<LoginResult>> {
  try {
    const response = await postJson(endpoint(serverBase, 'getTokenBySms'), {
      machineCode,
      loginId,
      verifyCode,
      device: 'pc',
    });
    if (!response.ok) return toFailure(response);
    return { ok: true, data: (await response.json()) as LoginResult };
  } catch (error) {
    return networkFailure(error);
  }
}

/** getTokenInfo 返回的 TokenInfo（UserServerController.getTokenInfo → TokenInfo.java，仅取展示字段） */
export interface TokenInfoData {
  userId: string;
  userCode: string;
  userName: string;
  corpNo: string;
}

/**
 * 查询 Token 信息（UserServer/getTokenInfo）：返回当前 token 的用户编码与账号级用户名。
 * 依据 UserCenterService.getTokenInfo：userName 取账号表 UserName_（账号级、与账套无关），空时回落 userCode；
 * userCode 为当前 token 绑定的子账号代码。服务端有缓存，登录成功后调用一次。
 */
export async function getTokenInfo(
  serverBase: string,
  machineCode: string,
  token: string,
): Promise<ApiCallResult<TokenInfoData>> {
  try {
    const response = await postJson(endpoint(serverBase, 'getTokenInfo'), { machineCode, token });
    if (!response.ok) return toFailure(response);
    const raw = (await response.json()) as Record<string, unknown>;
    const readText = (value: unknown) => (typeof value === 'string' ? value : '');
    return {
      ok: true,
      data: {
        userId: readText(raw.userId),
        userCode: readText(raw.userCode),
        userName: readText(raw.userName),
        corpNo: readText(raw.corpNo),
      },
    };
  } catch (error) {
    return networkFailure(error);
  }
}

/**
 * 登出并使 Token 失效（UserServer/logout）：请求体 {token}（TokenRequest.java），
 * 成功响应为空体。失败由调用方决定是否阻塞（退出登录不阻塞）。
 */
export async function logout(serverBase: string, token: string): Promise<ApiCallResult<null>> {
  try {
    const response = await postJson(endpoint(serverBase, 'logout'), { token });
    if (!response.ok) return toFailure(response);
    return { ok: true, data: null };
  } catch (error) {
    return networkFailure(error);
  }
}

/**
 * summer DataSet 服务的 JSON 响应（format=json）：{state, message, head, body}。
 * state>0 或 true 为成功；-4 表示 token 失效。body 可能是首行为字段名的二维数组，
 * 也可能是对象数组；head 为对象，metaInfo 序列化时为值数组 + meta.head 字段定义。
 */
interface DataSetResult {
  state?: number | boolean;
  message?: unknown;
  head?: unknown;
  meta?: unknown;
  body?: unknown;
}

function dataSetFailure(raw: DataSetResult): ApiFailure {
  const message = typeof raw.message === 'string' && raw.message ? raw.message : '请求失败';
  // code 透传 DataSet state（如 -4 token 失效），便于上层按语义处理
  return { ok: false, code: typeof raw.state === 'number' ? raw.state : 0, message };
}

/** 解析 DataSet head（对象直取；metaInfo 序列化时 head 为值数组，字段名在 meta.head） */
function readDataSetHead(raw: DataSetResult): Record<string, unknown> {
  if (raw.head !== null && typeof raw.head === 'object' && !Array.isArray(raw.head)) {
    return raw.head as Record<string, unknown>;
  }
  const meta = raw.meta as { head?: unknown } | null | undefined;
  const headMeta =
    meta && typeof meta === 'object' && Array.isArray(meta.head)
      ? (meta.head as Array<Record<string, unknown[]>>)
      : undefined;
  if (Array.isArray(raw.head) && headMeta) {
    const values = raw.head as unknown[];
    const mapped: Record<string, unknown> = {};
    headMeta.forEach((field, index) => {
      const fieldName = Object.keys(field)[0];
      mapped[fieldName] = values[index];
    });
    return mapped;
  }
  return {};
}

/** 解析 DataSet body 为行对象数组（兼容首行字段名的二维数组与对象数组两种形态） */
function readDataSetRows(raw: DataSetResult): Array<Record<string, unknown>> {
  const body = raw.body;
  if (!Array.isArray(body) || body.length === 0) return [];
  if (body[0] !== null && typeof body[0] === 'object' && !Array.isArray(body[0])) {
    return body as Array<Record<string, unknown>>;
  }
  if (!Array.isArray(body[0])) return [];
  const fieldNames = (body[0] as unknown[]).map(String);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < body.length; i++) {
    const values = body[i];
    if (!Array.isArray(values)) continue;
    rows.push(Object.fromEntries(fieldNames.map((name, index) => [name, values[index]])));
  }
  return rows;
}

/**
 * 调 summer DataSet 服务：POST {serverBase}/services/{path}，form 编码 dataIn；
 * sid/CLIENTID 挂 query（对齐 ERP myapp.js appendSessionQuery 的携带方式）。
 */
async function postService(
  serverBase: string,
  path: string,
  head: Record<string, string>,
  token: string,
  machineCode: string,
): Promise<ApiCallResult<DataSetResult>> {
  const url = new URL(`${serverBase.replace(/\/+$/, '')}/services/${path.replace(/^\/+/, '')}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('sid', token);
  url.searchParams.set('CLIENTID', machineCode);
  const dataIn = JSON.stringify({ head: { _RecordFilter_: '', ...head }, body: [[]] });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dataIn }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return toFailure(response);
    const raw = (await response.json()) as DataSetResult;
    const isOk = raw.state === true || (typeof raw.state === 'number' && raw.state > 0);
    if (!isOk) return dataSetFailure(raw);
    return { ok: true, data: raw };
  } catch (error) {
    return networkFailure(error);
  }
}

function readStringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/**
 * 当前主账号可用账套列表（SvrAccountManage.listMyLivingUsers，会话绑定）。
 * 返回列 CorpNo_/Code_/Name_/ShortName_；仅查询，无写入。
 */
export async function listMyLivingUsers(
  serverBase: string,
  token: string,
  machineCode: string,
): Promise<ApiCallResult<CorpAccount[]>> {
  const result = await postService(serverBase, 'SvrAccountManage.listMyLivingUsers', {}, token, machineCode);
  if (!result.ok) return result;
  const corps: CorpAccount[] = readDataSetRows(result.data)
    .map((row) => ({
      corpNo: readStringField(row, 'CorpNo_'),
      code: readStringField(row, 'Code_'),
      name: readStringField(row, 'Name_'),
      shortName: readStringField(row, 'ShortName_'),
    }))
    .filter((corp) => corp.corpNo !== '');
  return { ok: true, data: corps };
}

/**
 * 账套切换换票（SvrTerminal.getNuewToken）：以 rootToken（原始登录 token）换取目标账套 token。
 * 服务端按 rootToken 记录的 machine_code_ 绑定设备，自动完成目标子账号设备验证并登记新会话；
 * 返回 head.target_book_token。目标账套已存在有效 token 时直接复用，切回原始账套返回 rootToken 本身。
 */
export async function getNuewToken(
  serverBase: string,
  dispatchToken: string,
  rootToken: string,
  machineCode: string,
  targetCorpNo: string,
): Promise<ApiCallResult<string>> {
  const result = await postService(
    serverBase,
    'SvrTerminal.getNuewToken',
    { current_book_token: rootToken, target_book: targetCorpNo },
    dispatchToken,
    machineCode,
  );
  if (!result.ok) return result;
  const newToken = readStringField(readDataSetHead(result.data), 'target_book_token');
  if (!newToken) return { ok: false, code: 0, message: '切换账套失败：未返回新令牌' };
  return { ok: true, data: newToken };
}

/**
 * 调 summer 表单方法路由：POST {serverBase}/{corpNo}/{Form}.{method}，
 * 业务参数 form 编码放 body，sid/CLIENTID/device 挂 query
 * （对齐 ERP myapp.js getFrmServiceJson + appendSessionQuery 与 im-client imPost 两种携带方式）。
 * 返回 JSON 由调用方按各表单的 JsonPage 结构解析。
 */
async function postFormAction(
  serverBase: string,
  corpNo: string,
  action: string,
  fields: Record<string, string>,
  token: string,
  machineCode: string,
): Promise<ApiCallResult<Record<string, unknown>>> {
  const url = new URL(`${serverBase.replace(/\/+$/, '')}/${corpNo}/${action.replace(/^\/+/, '')}`);
  url.searchParams.set('sid', token);
  url.searchParams.set('CLIENTID', machineCode);
  url.searchParams.set('device', 'pc');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return toFailure(response);
    const raw = (await response.json()) as Record<string, unknown>;
    // JsonPage 失败形态：{result: false, message}; result 非 false 一律视为成功
    if (raw.result === false) {
      const message = typeof raw.message === 'string' && raw.message ? raw.message : '请求失败';
      return { ok: false, code: 0, message };
    }
    return { ok: true, data: raw };
  } catch (error) {
    return networkFailure(error);
  }
}

/**
 * MQTT 连接配置（FrmMessages.mqttConfig）：返回 broker（WebSocket 地址）/username/password。
 * 服务端形态依据 diteng-im-server FrmMessages.mqttConfig：JsonPage put("broker", config.getSocket())…，
 * broker 为空表示服务端未启用 MQTT，调用方应跳过连接。
 */
export async function getMqttConfig(
  serverBase: string,
  corpNo: string,
  token: string,
  machineCode: string,
): Promise<ApiCallResult<MqttBrokerConfig>> {
  const result = await postFormAction(serverBase, corpNo, 'FrmMessages.mqttConfig', {}, token, machineCode);
  if (!result.ok) return result;
  // 兼容 {broker} 与 {data:{broker}} 两种 JsonPage 包裹形态（对齐 im-client getMessageMqttConfig 解析）
  const source =
    result.data.data !== null && typeof result.data.data === 'object' && !Array.isArray(result.data.data)
      ? (result.data.data as Record<string, unknown>)
      : result.data;
  const broker = typeof source.broker === 'string' ? source.broker.trim() : '';
  if (!broker) return { ok: false, code: 0, message: '服务端未配置 MQTT 消息通道' };
  return {
    ok: true,
    data: {
      broker,
      username: typeof source.username === 'string' ? source.username : '',
      password: typeof source.password === 'string' ? source.password : '',
    },
  };
}

/**
 * 未读消息总数（ImServer.getUnreadMessage）：按主账号 ID 统计全部子账号未读。
 * 兼容旧版 {state,data:数字} 与分组版 {state,data:[{groupId,num}]} 两种返回（对齐 im-client getUnreadMessage）。
 */
export async function getUnreadMessage(
  serverBase: string,
  corpNo: string,
  token: string,
  machineCode: string,
  userId: string,
): Promise<ApiCallResult<number>> {
  const result = await postFormAction(serverBase, corpNo, 'ImServer.getUnreadMessage', { userId }, token, machineCode);
  if (!result.ok) return result;
  const data = result.data.data;
  if (typeof data === 'number' && Number.isFinite(data)) return { ok: true, data: Math.max(0, Math.floor(data)) };
  if (Array.isArray(data)) {
    let total = 0;
    for (const row of data) {
      if (row !== null && typeof row === 'object') {
        const num = Number((row as Record<string, unknown>).num);
        if (Number.isFinite(num) && num > 0) total += num;
      }
    }
    return { ok: true, data: total };
  }
  if (typeof result.data.unread === 'number') return { ok: true, data: result.data.unread };
  return { ok: false, code: 0, message: '未读数返回格式无法解析' };
}
