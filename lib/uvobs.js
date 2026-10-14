// kma-weather-mcp / lib/uvobs.js
//
// 자외선 관측자료 — 기상청 API허브 typ01 URL 방식(kma_sfctm_uv.php). 10분 간격 실측값.
//   https://apihub.kma.go.kr/api/typ01/url/kma_sfctm_uv.php?tm=YYYYMMDDHHMI&stn=0&help=0&authKey=…
// 생활기상지수(kma_living_index)의 자외선지수는 '예측'이고, 이쪽은 '관측'이다.
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ JSON이 아니라 EUC-KR 고정폭 텍스트다. "#START7777" ~ "#7777END" 사이에서 '#'로 시작하지 않는 줄이 자료.
//   열: TM STN UVB(MED/10min) UVA(J/cm2/10min) EUV(MED/10min) UV-B지수 UV-A지수 TEMP1 TEMP2(내부온도). -999 = 결측.
// ★ tm을 비우면 '최근' 자료가 오지만 정시 자료였다(11:50 호출에 11:00 — 11:30 자료가 이미 있었는데도).
//   그래서 tm 생략 시 서버가 '지금-10분'을 10분 단위로 내린 시각부터 10분씩 두 번 거슬러 조회한다(latestUvObs).
// ★ 2022-03-21 같은 과거 시각도 조회된다(관측 아카이브).
// ★ 2026-10 기준 응답 지점 15곳(2022-03에는 104 대신 105가 있었다 — 지점 구성은 바뀐다).
// ★ 지점명을 주는 지점정보 API(stn_inf.php)는 이 키로 403(미승인)이라 지점명은 ASOS 지점번호 체계로 붙인 '추정'이다.
//   13번은 ASOS 번호가 아니어서 이름을 확인하지 못했다.
// ★ API허브 오류는 HTTP 403/401 + {"result":{"status":…,"message":…}} JSON(EUC-KR로 디코딩하면 메시지가 깨진다).

import { UpstreamError, httpGet, envKey, nowKst, scrub } from "./common.js";

const BASE = "https://apihub.kma.go.kr/api/typ01/url/kma_sfctm_uv.php";
const SOURCE = "기상청 API허브 자외선관측(kma_sfctm_uv)";

// ASOS 지점번호 기준 추정 명칭
export const UV_STN_NAME = {
  104: "북강릉", 105: "강릉", 108: "서울", 112: "인천", 115: "울릉도", 131: "청주", 132: "안면도", 133: "대전",
  138: "포항", 143: "대구", 146: "전주", 152: "울산", 156: "광주", 159: "부산", 165: "목포",
};

export const UV_GUIDE = {
  위험: "태양에 노출 시 극도로 위험. 모든 예방조치 필요. 노출된 피부는 몇 분 내에 탈 수 있음. 11~16시에는 노출을 피하고 그늘·긴 옷·모자·선글라스, SPF15 이상 차단제를 2시간마다 충분히.",
  매우높음: "태양에 노출 시 매우 위험. 추가 예방조치 필요. 피부가 빠르게 탈 수 있음. 11~16시 노출 최소화, 그늘·긴 옷·모자·선글라스, SPF15 이상 차단제.",
  높음: "태양에 노출 시 위험. 햇볕 노출 시 보호 필요. 11~16시 노출 시간을 줄이고 긴 옷·모자·선글라스, SPF15 이상 차단제.",
  보통: "노출 시 위험 보통. 외출 시 긴 옷·차단제로 주의하고, 햇볕이 강한 한낮에는 그늘에 머물 것.",
  낮음: "보통 사람은 자외선으로 인한 위험 낮음.",
};
export const uvLevel = (v) => (v === null || v === undefined ? null : v >= 11 ? "위험" : v >= 8 ? "매우높음" : v >= 6 ? "높음" : v >= 3 ? "보통" : "낮음");

const num = (x) => {
  const n = Number(x);
  return !Number.isFinite(n) || n <= -900 ? null : n;
};
const pad = (n) => String(n).padStart(2, "0");
function fmt(tm) {
  return `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)} ${tm.slice(8, 10)}:${tm.slice(10, 12)}`;
}

/** 한 시각(전 지점) 조회. tm 없으면 최신 */
export async function fetchUvObs(tm, stn, meter) {
  const key = envKey("KMA_APIHUB_KEY");
  if (!key) throw new UpstreamError("자외선 관측은 기상청 API허브 키(KMA_APIHUB_KEY)가 필요합니다.", "NO_KEY");
  const url = `${BASE}?tm=${tm || ""}&stn=${stn || 0}&help=0&authKey=${encodeURIComponent(key)}`;
  // 실측 2026-10-14: 같은 요청이 한 번 25초 무응답 후 다음엔 0.3초에 왔다 → 짧은 제한시간 + 1회 재시도
  let status, text;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ status, text } = await httpGet(url, { meter, source: SOURCE, encoding: "euc-kr", timeoutMs: 12000 }));
      break;
    } catch (e) {
      if (attempt === 0 && (e.code === "TIMEOUT" || e.code === "UPSTREAM")) continue;
      throw e;
    }
  }
  if (status >= 400 || /^\s*\{/.test(text)) {
    const kind = status === 401 ? "BAD_KEY" : status === 403 ? "UNAPPROVED" : status === 429 ? "RATE_LIMIT" : "UPSTREAM";
    throw new UpstreamError(`${SOURCE}: HTTP ${status}${status === 403 ? " — API허브에서 이 API 활용신청이 승인됐는지 확인하세요" : ""}`, kind);
  }
  if (!text.includes("#START7777")) throw new UpstreamError(`${SOURCE}: 예상하지 못한 응답: ${scrub(text.slice(0, 120))}`, "UPSTREAM");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const f = t.split(/\s+/);
    if (f.length < 7 || !/^\d{12}$/.test(f[0])) continue;
    const idx = num(f[5]);
    const id = Number(f[1]);
    rows.push({
      관측시각: fmt(f[0]), 지점: id, 지점명_추정: UV_STN_NAME[id] ?? "미확인",
      자외선지수: idx, 단계: uvLevel(idx), UVA지수: num(f[6]),
      UVB_MED10분: num(f[2]), UVA_Jcm2_10분: num(f[3]), EUV_MED10분: num(f[4]),
    });
  }
  return rows;
}

/** tm 정규화: YYYYMMDDHHMI(12) 또는 YYYYMMDDHH(10) → 10분 단위 내림 */
export function normUvTm(v) {
  if (!v) return null;
  let s = String(v).replace(/\D/g, "");
  if (s.length === 10) s += "00";
  if (!/^\d{12}$/.test(s)) throw new UpstreamError(`tm은 YYYYMMDDHHMI(12자리)여야 합니다: "${v}"`, "BAD_PARAM");
  return s.slice(0, 11) + "0";
}

/** 현재 KST에서 n시간 전까지 1시간 간격 시각 목록(정각) */
export function hourlyBack(hours, endTm) {
  const end = endTm
    ? new Date(Date.UTC(+endTm.slice(0, 4), +endTm.slice(4, 6) - 1, +endTm.slice(6, 8), +endTm.slice(8, 10)))
    : (() => { const d = nowKst(); d.setUTCMinutes(0, 0, 0); return d; })();
  const out = [];
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 3600e3);
    out.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}00`);
  }
  return out;
}

/** 최신 10분 관측: 지금-10분 → -20분 → -30분, 그래도 없으면 tm 없이 */
export async function latestUvObs(stn, meter) {
  const now = new Date(nowKst().getTime() - 10 * 60e3);
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getTime() - i * 10 * 60e3);
    const t = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(Math.floor(d.getUTCMinutes() / 10) * 10)}`;
    const rows = await fetchUvObs(t, stn, meter);
    if (rows.length) return rows;
  }
  return fetchUvObs(null, stn, meter);
}
