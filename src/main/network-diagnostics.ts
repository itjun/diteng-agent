import { lookup as rawLookup } from 'node:dns';
import { connect as rawTcpConnect } from 'node:net';
import { connect as rawTlsConnect } from 'node:tls';
import { performance } from 'node:perf_hooks';
import { net } from 'electron';
import { NETWORK_GRADE_LABELS } from '../shared/types';
import type { ApiCallResult } from '../shared/types';
import type {
  NetworkDiagnosticsGrade,
  NetworkDiagnosticsPhases,
  NetworkDiagnosticsState,
  NetworkDiagnosticsTargetStat,
  NetworkDiagnosticsVerdict,
} from '../shared/types';

/**
 * 网络检测（关于本机页）：并发探测「外网基线 / 前端站点 / 后端接口 / AI 站点」，
 * 以成功率 + 中位 TTFB + 抖动（标准差）评估当前网络到服务器连接的稳定性；
 * 另对 serverBase 做 DNS/TCP/TLS 链路分解，定位慢在哪一段。
 * 探测全部走主进程（electron net.fetch 走应用真实网络栈），逐探针推流进度。
 */

const PROBE_COUNT = 8;
/** 目标内探针节流：并发打满会自拥塞，反而测不出真实稳定性 */
const PROBE_PACING_MS = 600;
const PROBE_TIMEOUT_MS = 4000;
const PHASE_TIMEOUT_MS = 4000;
/** 评级阈值：中位延迟 / 抖动（毫秒） */
const GRADE_MEDIAN_FAIR_MS = 200;
const GRADE_MEDIAN_GOOD_MS = 100;
const GRADE_JITTER_FAIR_MS = 80;
const GRADE_JITTER_GOOD_MS = 40;
const GRADE_MEDIAN_POOR_MS = 500;

export type ProbeKey = NetworkDiagnosticsTargetStat['key'];

export interface ProbeTarget {
  key: ProbeKey;
  label: string;
  url: string;
  method: 'GET' | 'POST';
  /** POST 探针的 form 编码请求体（后端 getToken 空参数，GUEST 免鉴权） */
  body?: string;
  skipped: boolean;
}

export interface ProbeSample {
  ok: boolean;
  ttfbMs: number;
  /** 仅前端目标：入口文档完整下载耗时与大小 */
  totalMs?: number;
  bytes?: number;
}

const LOCAL_HOST_PATTERN = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/** AI 站地址指向本机服务时不算网络质量目标（dev 构建为本地 AI 服务） */
export function isRemoteBase(base: string): boolean {
  try {
    return !LOCAL_HOST_PATTERN.test(new URL(base).hostname);
  } catch {
    return false;
  }
}

/**
 * 组装探测目标：外网基线复用公网 IP 服务方；前端 = ERP 站点入口文档；
 * 后端 = SvrUserLogin.getToken（GUEST 免鉴权，空参数快速返回业务失败即证明链路通）。
 */
export function buildTargets(serverBase: string, aiBase: string): ProbeTarget[] {
  const base = serverBase.trim().replace(/\/+$/, '');
  const ai = aiBase.trim().replace(/\/+$/, '');
  return [
    { key: 'internet', label: '外网连通', url: 'https://api64.ipify.org', method: 'GET', skipped: false },
    { key: 'frontend', label: '前端资源', url: `${base}/`, method: 'GET', skipped: false },
    {
      key: 'backend', label: '后端接口', url: `${base}/services/SvrUserLogin.getToken`, method: 'POST',
      body: new URLSearchParams({ dataIn: JSON.stringify({ head: {}, body: [[]] }) }).toString(),
      skipped: false,
    },
    { key: 'ai', label: 'AI 站点', url: `${ai}/`, method: 'GET', skipped: !isRemoteBase(ai) },
  ];
}

/**
 * 汇总单目标探针样本：延迟统计只计入成功探针；grade 按「已完成的样本」评估
 * （运行中随进度演进），plannedCount 为计划探针数（展示用，固定不随进度变化）。
 */
export function summarizeSamples(target: ProbeTarget, samples: ProbeSample[], plannedCount = samples.length): NetworkDiagnosticsTargetStat {
  const successSamples = samples.filter(sample => sample.ok);
  const times = successSamples.map(sample => sample.ttfbMs).sort((a, b) => a - b);
  const median = times.length
    ? Math.floor((times[Math.floor((times.length - 1) / 2)] + times[Math.ceil((times.length - 1) / 2)]) / 2)
    : null;
  const avg = times.length ? Math.floor(times.reduce((sum, value) => sum + value, 0) / times.length) : null;
  // 抖动取成功样本标准差（总体），样本不足 2 个无法评估
  const jitter = times.length >= 2
    ? Math.floor(Math.sqrt(times.reduce((sum, value) => sum + (value - avg!) ** 2, 0) / times.length))
    : null;
  const document = target.key === 'frontend' ? successSamples.find(sample => sample.bytes !== undefined) : undefined;
  return {
    key: target.key,
    label: target.label,
    url: target.url,
    skipped: target.skipped,
    total: target.skipped ? 0 : plannedCount,
    completed: samples.length,
    success: successSamples.length,
    medianMs: median,
    avgMs: avg,
    jitterMs: jitter,
    maxMs: times.length ? Math.floor(times[times.length - 1]) : null,
    documentMs: document === undefined ? null : Math.floor(document.totalMs!),
    documentBytes: document?.bytes ?? null,
    grade: target.skipped ? 'skipped' : gradeFor(samples.length, successSamples.length, median, jitter),
  };
}

/**
 * 目标评级：不可用（全失败）< 较差（有失败或中位 > 500ms）< 一般（中位 > 200 或抖动 > 80）
 * < 良好（中位 > 100 或抖动 > 40）< 优秀。任何一次探针失败都视为稳定性缺陷。
 */
export function gradeFor(total: number, success: number, medianMs: number | null, jitterMs: number | null): NetworkDiagnosticsGrade {
  if (total > 0 && success === 0) return 'down';
  if (success < total) return 'poor';
  if (medianMs === null) return 'down';
  if (medianMs > GRADE_MEDIAN_POOR_MS) return 'poor';
  if (medianMs > GRADE_MEDIAN_FAIR_MS || (jitterMs !== null && jitterMs > GRADE_JITTER_FAIR_MS)) return 'fair';
  if (medianMs > GRADE_MEDIAN_GOOD_MS || (jitterMs !== null && jitterMs > GRADE_JITTER_GOOD_MS)) return 'good';
  return 'excellent';
}

const GRADE_ORDER: NetworkDiagnosticsGrade[] = ['excellent', 'good', 'fair', 'poor', 'down'];

/** 总体结论 = 前端/后端较差者（AI 与外网基线只作参考），建议结合基线区分本地网络与服务器链路问题 */
export function overallVerdict(targets: NetworkDiagnosticsTargetStat[]): NetworkDiagnosticsVerdict {
  const find = (key: ProbeKey) => targets.find(target => target.key === key);
  const internet = find('internet');
  const core = [find('frontend'), find('backend')]
    .filter((target): target is NetworkDiagnosticsTargetStat => Boolean(target) && !target!.skipped)
    // skipped 已在上面过滤，这里收窄为五档评级参与比较
    .map(target => target.grade as Exclude<NetworkDiagnosticsGrade, 'skipped'>);
  const grade = core.length
    ? core.reduce((worst, value) => (GRADE_ORDER.indexOf(value) > GRADE_ORDER.indexOf(worst) ? value : worst))
    : 'down';
  let advice: string;
  if (internet && internet.success === 0) {
    advice = '本机无法访问外网，请先检查网络连接（Wi-Fi / 网线 / 代理）后重新检测';
  } else if (grade === 'down') {
    advice = '外网访问正常但无法连接服务器，问题在到服务器的链路或服务端，请联系管理员';
  } else if (grade === 'poor') {
    advice = '与服务器连接不稳定（存在超时或高延迟），建议更换网络环境后重新检测';
  } else if (grade === 'fair') {
    advice = '与服务器连接速度一般，使用高峰期可能出现页面卡顿';
  } else if (grade === 'good') {
    advice = '与服务器连接良好，可正常使用';
  } else {
    advice = '与服务器连接稳定可靠';
  }
  return { grade, summary: `与服务器连接${NETWORK_GRADE_LABELS[grade]}`, advice };
}

function withCacheBuster(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}_diag=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 探针成功判据按目标区分：外网要求返回 IP 文本；前端/AI 要求 HTTP < 400；后端只要 HTTP 应答即证明服务链路通 */
async function probeOnce(target: ProbeTarget, fetchImpl: FetchLike, timeoutMs: number): Promise<ProbeSample> {
  const url = target.method === 'GET' ? withCacheBuster(target.url) : target.url;
  const start = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: target.method,
      headers: target.method === 'POST'
        ? { 'content-type': 'application/x-www-form-urlencoded' }
        : { 'Cache-Control': 'no-cache' },
      body: target.body,
      redirect: 'follow',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ttfbMs = performance.now() - start;
    if (target.key === 'backend') {
      await response.body?.cancel();
      return { ok: true, ttfbMs };
    }
    if (response.status >= 400) return { ok: false, ttfbMs };
    // 读完响应体：前端目标记录文档大小与完整下载耗时；外网目标校验响应确为 IP 文本
    const reader = response.body?.getReader();
    if (!reader) return { ok: true, ttfbMs };
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
        if (target.key === 'internet' && text.length > 64) throw new Error('外网探针响应无效');
        if (target.key === 'frontend' && bytes > 2 * 1024 * 1024) throw new Error('探测响应异常');
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const totalMs = performance.now() - start;
    if (target.key === 'internet' && !/^[0-9a-f.:]+$/i.test(text.trim())) return { ok: false, ttfbMs };
    return target.key === 'frontend' ? { ok: true, ttfbMs, totalMs, bytes } : { ok: true, ttfbMs };
  } catch {
    return { ok: false, ttfbMs: 0 };
  }
}

type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow';
  credentials?: 'omit';
  signal?: AbortSignal;
}) => Promise<ResponseLike>;

interface ResponseLike {
  ok: boolean;
  status: number;
  body: {
    cancel(): Promise<void>;
    getReader(): {
      read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function raceTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** DNS 解析计时（node:dns.lookup，系统解析器含缓存，仅作分段参考） */
async function defaultDnsLookup(host: string, timeoutMs: number): Promise<number> {
  const start = performance.now();
  await raceTimeout(new Promise<void>((resolve, reject) => {
    rawLookup(host, { verbatim: true }, error => (error ? reject(error) : resolve()));
  }), timeoutMs, 'DNS 解析超时');
  return performance.now() - start;
}

function connectOnce(open: (onOpen: () => void) => { destroy: () => void; once: (event: string, listener: (error: Error) => void) => void }, timeoutMs: number): Promise<number> {
  return raceTimeout(new Promise<number>((resolve, reject) => {
    const start = performance.now();
    const handle = open(() => {
      resolve(performance.now() - start);
      handle.destroy();
    });
    handle.once('error', reject);
  }), timeoutMs, '连接超时');
}

/** TCP 连接计时：三次握手往返即网络层 RTT */
async function defaultTcpConnect(host: string, port: number, timeoutMs: number): Promise<number> {
  return connectOnce(onOpen => {
    const socket = rawTcpConnect({ host, port }, onOpen);
    socket.setTimeout(timeoutMs, () => socket.destroy());
    return socket;
  }, timeoutMs);
}

/** TLS 握手计时（仅 https 目标）：含证书校验开销 */
async function defaultTlsConnect(host: string, port: number, timeoutMs: number): Promise<number> {
  return connectOnce(onOpen => {
    const socket = rawTlsConnect({ host, port, servername: host }, onOpen);
    socket.setTimeout(timeoutMs, () => socket.destroy());
    return socket;
  }, timeoutMs);
}

/** serverBase 链路分解：各段独立计时、失败为 null（不阻塞探针） */
export async function measurePhases(
  serverBase: string,
  deps: { dnsLookup?: typeof defaultDnsLookup; tcpConnect?: typeof defaultTcpConnect; tlsConnect?: typeof defaultTlsConnect; timeoutMs?: number } = {},
): Promise<NetworkDiagnosticsPhases> {
  const timeoutMs = deps.timeoutMs ?? PHASE_TIMEOUT_MS;
  const dnsLookup = deps.dnsLookup ?? defaultDnsLookup;
  const tcpConnect = deps.tcpConnect ?? defaultTcpConnect;
  const tlsConnect = deps.tlsConnect ?? defaultTlsConnect;
  let parsed: URL;
  try {
    parsed = new URL(serverBase);
  } catch {
    return { dnsMs: null, tcpMs: null, tlsMs: null, error: '服务器地址无法解析' };
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  const errors: string[] = [];
  const [dnsMs, tcpMs, tlsMs] = await Promise.all([
    dnsLookup(host, timeoutMs).catch(() => { errors.push('DNS 解析失败'); return null; }),
    tcpConnect(host, port, timeoutMs).catch(() => { errors.push('TCP 连接失败'); return null; }),
    parsed.protocol === 'https:'
      ? tlsConnect(host, port, timeoutMs).catch(() => { errors.push('TLS 握手失败'); return null; })
      : Promise.resolve(null),
  ]);
  const ms = (value: number | null) => (value === null ? null : Math.floor(value));
  return { dnsMs: ms(dnsMs), tcpMs: ms(tcpMs), tlsMs: ms(tlsMs), error: errors.join('；') };
}

export interface NetworkDiagnosticsDeps {
  fetchImpl?: FetchLike;
  probeCount?: number;
  pacingMs?: number;
  probeTimeoutMs?: number;
  phases?: Parameters<typeof measurePhases>[1];
}

export interface NetworkDiagnosticsService {
  getState(): NetworkDiagnosticsState;
  start(input: { serverBase: string; aiBase: string }, emit: (state: NetworkDiagnosticsState) => void): Promise<ApiCallResult<null>>;
}

export function createNetworkDiagnosticsService(deps: NetworkDiagnosticsDeps = {}): NetworkDiagnosticsService {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => net.fetch(input, init));
  const probeCount = deps.probeCount ?? PROBE_COUNT;
  const pacingMs = deps.pacingMs ?? PROBE_PACING_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  let running = false;
  let state: NetworkDiagnosticsState = {
    status: 'idle', startedAt: null, completedProbes: 0, totalProbes: 0, phases: null, targets: [], overall: null,
  };
  return {
    getState: () => state,
    async start(input, emit) {
      if (running) return { ok: false, code: 0, message: '网络检测正在进行中' };
      running = true;
      try {
        const targets = buildTargets(input.serverBase, input.aiBase);
        const active = targets.filter(target => !target.skipped);
        state = {
          status: 'running',
          startedAt: Date.now(),
          completedProbes: 0,
          totalProbes: active.length * probeCount,
          phases: null,
          targets: targets.map(target => summarizeSamples(target, [], probeCount)),
          overall: null,
        };
        emit(state);
        // 链路分解与探针并发；分解结果出来后单独推流一次
        const phasesTask = measurePhases(input.serverBase, deps.phases).then(phases => {
          state = { ...state, phases };
          emit(state);
        });
        const probeTasks = active.map(async target => {
          const samples: ProbeSample[] = [];
          for (let index = 0; index < probeCount; index++) {
            if (index > 0) await sleep(pacingMs);
            samples.push(await probeOnce(target, fetchImpl, probeTimeoutMs));
            const others = state.targets.filter(item => item.key !== target.key);
            state = {
              ...state,
              completedProbes: state.completedProbes + 1,
              targets: [...others, summarizeSamples(target, samples, probeCount)].sort((a, b) => targets.findIndex(t => t.key === a.key) - targets.findIndex(t => t.key === b.key)),
            };
            emit(state);
          }
        });
        await Promise.all([phasesTask, ...probeTasks]);
        state = { ...state, status: 'done', overall: overallVerdict(state.targets) };
        emit(state);
        return { ok: true, data: null };
      } finally {
        running = false;
      }
    },
  };
}
