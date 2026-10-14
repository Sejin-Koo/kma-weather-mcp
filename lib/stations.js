// kma-weather-mcp / lib/stations.js
//
// 기상청 API허브 지점정보 — stn_inf.php?inf=<SFC|UV>&stn=&tm=YYYYMMDDHHMI&help=0&authKey=…
//   SFC: 지상관측소(ASOS) — 열: STN_ID LON LAT STN_SP HT HT_PA HT_TA HT_WD HT_RN STN_AD STN_KO STN_EN FCT_ID LAW_ID BASIN LAW_ADDR
//   UV : 자외선 관측소    — 열: STN_ID LON LAT STN_SP(빈칸) HT STN_AD STN_KO STN_EN FCT_ID LAW_ID (FCT_ID·LAW_ID는 비기도 한다)
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ 같은 요청이 어떤 때는 1~3초에 오고 어떤 때는 7~14초 무응답으로 끊긴다(파라미터와 무관하게 간헐적 —
//   inf=SFC·UV, tm 있음·없음 각각 성공과 실패가 섞여 나왔다). 그래서 짧은 제한시간 + 최대 3회 시도.
//   처음 "inf=SFC는 504"로 기록했던 것은 이 간헐 실패를 한 번 만난 것이었다(정정).
// ★ tm(그 시점에 운영 중이던 지점 구성)은 반영된다: SFC 2022-11-30 96곳 / 현재 97곳(296 북부산 추가),
//   UV 2015-01-01 6곳 / 2022-03·2022-11·현재 15곳. 처음 "UV는 tm이 무시된다"고 적은 것은 2022-03과 현재의
//   구성이 같았기 때문이다(정정).
// ★ SFC의 STN_EN에 공백이 들어간 지점이 있다(정선군·강진군 — "… Gun"). 공백 분리로 읽으면 FCT_ID 자리에 "Gun"이
//   들어가므로, FCT_ID(영숫자 8자)·LAW_ID(10자리)를 기준으로 뒤에서부터 맞추는 정규식을 쓴다.
// ★ SFC의 FCT_ID는 중기기온(getMidTa) 도시 구역코드와 같은 체계다(97곳 중 94곳이 중기 구역표의 도시 코드와 일치,
//   지점명과 구역명이 다른 곳은 북춘천→춘천·북부산→부산처럼 가까운 도시로 배정돼 있다). 기상청이 지점마다 매긴 값이므로
//   이름 일치 추정보다 근거가 낫다 — 다만 "그 관측소의" 배정이지 조회 지역의 배정은 아니다(거리를 함께 밝힐 것).
// ★ EUC-KR 고정폭 텍스트, "#START7777" ~ "#7777END". 오류는 HTTP 401/403 + JSON.

import { UpstreamError, httpGet, envKey, scrub } from "./common.js";

const URL_BASE = "https://apihub.kma.go.kr/api/typ01/url/stn_inf.php";
const TTL = 12 * 3600e3;
const cache = new Map(); // `${inf}:${tm}` → { at, rows }
export const STATION_KINDS = { SFC: "지상관측소(ASOS)", UV: "자외선 관측소" };

const RE_SFC =
  /^\s*(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s+([0-9A-Z]{8}|-+)\s+(\d{10}|-+)\s+(\S+)\s*(.*?)\s*$/;
const RE_UV = /^\s*(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(?:(\S+)\s+)??(-?[\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/;
const dash = (v) => (v && !/^-+$/.test(v) ? v : null);

export function parseStations(inf, text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (inf === "SFC") {
      const m = line.match(RE_SFC);
      if (!m) continue;
      rows.push({
        지점: Number(m[1]), 지점명: m[11], 영문명: dash(m[12]), 경도: Number(m[2]), 위도: Number(m[3]), 해발고도m: Number(m[5]),
        관리관서: Number(m[10]), 예보구역코드: dash(m[13]), 법정동코드: dash(m[14]), 주소: m[16] || null,
      });
    } else {
      const m = line.match(RE_UV);
      if (!m) continue;
      rows.push({ 지점: Number(m[1]), 지점명: m[7], 경도: Number(m[2]), 위도: Number(m[3]), 해발고도m: Number(m[5]), 예보구역코드: dash(m[9]) });
    }
  }
  return rows;
}

/** 지점 목록. tm(YYYYMMDDHHMI)을 주면 그 시점 구성. 12시간 캐시, 간헐 무응답 대비 최대 3회 시도 */
export async function fetchStations(inf = "SFC", { tm = null, meter } = {}) {
  if (!STATION_KINDS[inf]) throw new UpstreamError(`지점 종류는 ${Object.keys(STATION_KINDS).join("·")} 중 하나입니다: ${inf}`, "BAD_PARAM");
  if (tm && !/^\d{12}$/.test(tm)) throw new UpstreamError(`지점정보 tm은 YYYYMMDDHHMI(12자리)여야 합니다: "${tm}"`, "BAD_PARAM");
  const ck = `${inf}:${tm || ""}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return { rows: hit.rows, cached: true };
  const key = envKey("KMA_APIHUB_KEY");
  if (!key) throw new UpstreamError("지점정보는 기상청 API허브 키(KMA_APIHUB_KEY)가 필요합니다.", "NO_KEY");
  const source = `기상청 API허브 지점정보(stn_inf ${inf})`;
  // 빈 값 파라미터(stn=, tm=)는 보내지 않는다
  const url = `${URL_BASE}?inf=${inf}${tm ? `&tm=${tm}` : ""}&help=0&authKey=${encodeURIComponent(key)}`;
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await httpGet(url, { meter, source, encoding: "euc-kr", timeoutMs: 7000 });
      if (res.status >= 500) {
        lastErr = new UpstreamError(`${source}: HTTP ${res.status}`, "UPSTREAM");
        res = null;
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      if (e.code !== "TIMEOUT" && e.code !== "UPSTREAM") throw e;
    }
  }
  if (!res) throw new UpstreamError(`${lastErr ? lastErr.message : source + " 응답 없음"} (3회 시도 — 이 API는 간헐적으로 무응답이 난다. 잠시 후 다시 시도)`, lastErr?.code || "UPSTREAM");
  const { status, text } = res;
  if (status >= 400 || /^\s*\{/.test(text)) {
    const kind = status === 401 ? "BAD_KEY" : status === 403 ? "UNAPPROVED" : status === 429 ? "RATE_LIMIT" : "UPSTREAM";
    throw new UpstreamError(`${source}: HTTP ${status}${status === 403 ? " — API허브에서 지점정보 활용신청 승인 여부를 확인하세요" : ""}`, kind);
  }
  if (!text.includes("#START7777")) throw new UpstreamError(`${source}: 예상하지 못한 응답: ${scrub(text.slice(0, 120))}`, "UPSTREAM");
  const rows = parseStations(inf, text);
  if (!rows.length) throw new UpstreamError(`${source}: 지점 행을 하나도 읽지 못했습니다(형식 변경 가능성)`, "UPSTREAM");
  cache.set(ck, { at: Date.now(), rows });
  return { rows, cached: false };
}

/** 위경도에서 가까운 지점 n곳(평면 근사, km) */
export function nearestStations(stations, lat, lon, n = 3, filter = null) {
  const cosl = Math.cos((lat * Math.PI) / 180);
  return stations
    .filter((s) => (filter ? filter(s) : true))
    .map((s) => ({ ...s, 거리km: Math.round(Math.sqrt((s.위도 - lat) ** 2 + ((s.경도 - lon) * cosl) ** 2) * 111 * 10) / 10 }))
    .sort((a, b) => a.거리km - b.거리km)
    .slice(0, n);
}

/** 지점명·번호 검색 */
export function findStations(stations, query) {
  const q = String(query || "").replace(/\s+/g, "").toLowerCase();
  if (!q) return stations;
  if (/^\d+$/.test(q)) return stations.filter((s) => String(s.지점) === q);
  return stations.filter((s) => (s.지점명 + (s.영문명 || "") + (s.주소 || "")).replace(/\s+/g, "").toLowerCase().includes(q));
}
