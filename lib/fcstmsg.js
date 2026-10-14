// kma-weather-mcp / lib/fcstmsg.js
//
// 동네예보 통보문(API허브 VilageFcstMsgService) — 기상개황·육상예보·해상예보 + 예보구역정보(FcstZoneInfoService).
//
//   getWthrSituation(stnId)  관서별 기상개황 문장(wfSv1 종합, wn 특보사항, wr 예비특보)
//   getLandFcst(regId)       도시 구역의 반나절 단위 예보: 날씨·하늘코드·강수형태·강수확률·기온(오전=최저, 오후=최고)·풍향·풍속강도
//   getSeaFcst(regId)        해상 구역의 반나절 단위 예보: 날씨·풍향·풍속(m/s 범위)·파고(m 범위)
//   getFcstZoneCd            예보구역 755개의 좌표·상위구역·유효기간
//
// ── 명세(활용가이드 241128) ─────────────────────────────────────────────────
// ★ 발표 05·11·17시. numEf(발효번호)의 시작이 발표시각에 따라 다르다:
//   05시~11시 전 발표 → 0=오늘오전 / 11시~17시 전 → 0=오늘오후 / 17시~익일05시 전 → 0=오늘오후(=오늘밤), 이후 반나절씩.
//   (2024-11-28부터 17시 발표는 그글피, 05·11시 발표는 글피까지)
// ★ ta: 오전 칸은 예상 최저기온, 오후 칸은 예상 최고기온. 05시 발표의 오늘오전 최저·17시 발표의 오늘오후 최고는 제공하지 않는다.
// ★ wdTnd 1 "-"(풍향1~풍향2), 2 "후"(풍향1 후 풍향2). wsIt 1 약간 강·2 강·3 매우 강(빈 값 = 강하지 않음).
// ★ rnYn 0 없음·1 비·2 비/눈·3 눈·4 소나기. wfCd DB01 맑음·DB03 구름많음·DB04 흐림.
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ 육상예보는 도시(C) 코드에서만 자료가 나왔다 — 육상광역(A) 11D10000·육상국지(B) 11B20400은 코드 03(실측 1건씩).
//   해상예보는 해상광역(H)·해상국지(I) 모두 나왔다.
// ★ 기상개황의 wn(특보사항)은 "날씨누리를 참고하라"는 안내문, wr(예비특보)는 "o 없음" 같은 짧은 요약이었다
//   → 특보 본문을 대신하지 못한다(본문은 kma_warnings, 이력은 kma_warning_history).
// ★★ getFcstZoneCd의 totalCount는 실제 전체가 아니라 요청한 numOfRows만큼 찍힌다(numOfRows=3 → 3, 2000 → 755).
//   fetchAll의 totalCount 대조가 통하지 않으므로 한 번에 크게(2000) 받는다.

import { UpstreamError, nowKst } from "./common.js";
import { kmaCall } from "./kma.js";
import MSG from "../data/fcstmsg.js"; // [구분, 지역명, 코드]
import { distKm } from "./hub.js";

const squash = (s) => String(s || "").replace(/[\s.·]+/g, "").toLowerCase();
const ROWS = MSG.map(([k, name, code]) => ({ kind: k, name, code }));
export const MSG_KIND = { S: "기상개황 관서", A: "육상광역", B: "육상국지", C: "도시(육상예보)", H: "해상광역", I: "해상국지" };
export const SITUATION_STN = Object.fromEntries(ROWS.filter((r) => r.kind === "S").map((r) => [r.code, r.name]));
const C_SET = new Set(ROWS.filter((r) => r.kind === "C").map((r) => r.code));

export function findMsgRegions(query, kinds = null, limit = 30) {
  const q = squash(query);
  const hit = ROWS.filter((r) => (!kinds || kinds.includes(r.kind)) && (!q || squash(r.name).includes(q) || r.code.toLowerCase() === q));
  return { total: hit.length, rows: hit.slice(0, limit).map((r) => ({ 코드: r.code, 지역: r.name, 구분: MSG_KIND[r.kind] })) };
}
export function msgRegion(code) {
  return ROWS.find((r) => r.code === String(code)) || null;
}
export function isCityCode(code) {
  return C_SET.has(String(code));
}
/** 이름이 정확히 같은 구역(같은 구분 안에서) */
export function msgByExactName(name, kinds) {
  const q = squash(name);
  return ROWS.filter((r) => kinds.includes(r.kind) && squash(r.name) === q);
}

// ── 시도 → 기상개황 관서 ────────────────────────────────────────────────────
const L1_STN = {
  서울특별시: "109", 인천광역시: "109", 경기도: "109",
  부산광역시: "159", 울산광역시: "159", 경상남도: "159",
  대구광역시: "143", 경상북도: "143",
  광주광역시: "156", 전라남도: "156", 전남광주통합특별시: "156",
  전북특별자치도: "146",
  대전광역시: "133", 세종특별자치시: "133", 충청남도: "133",
  충청북도: "131",
  강원특별자치도: "105",
  제주특별자치도: "184",
};
export function situationStnForL1(l1) {
  return L1_STN[l1] || null;
}

// ── 예보구역정보(좌표) — 24시간 캐시 ────────────────────────────────────────
let zoneCache = null;
export async function fcstZones(meter) {
  if (zoneCache && Date.now() - zoneCache.at < 24 * 3600e3) {
    if (meter) meter.cacheHits++;
    return zoneCache.rows;
  }
  const r = await kmaCall("FZONE", "getFcstZoneCd", { numOfRows: 2000, pageNo: 1 }, { meter, timeoutMs: 15000 });
  const rows = r.items.map((z) => ({ code: String(z.regId), name: z.regName, sp: z.regSp, up: z.regUp || null, lat: Number(z.lat), lon: Number(z.lon), tmSt: String(z.tmSt), tmEd: String(z.tmEd), stnF3: z.stnF3 ?? null }));
  if (rows.length < 100) throw new UpstreamError(`예보구역정보가 ${rows.length}건만 왔습니다(형식 변경 가능성).`, "UPSTREAM");
  zoneCache = { at: Date.now(), rows };
  return rows;
}

/** 좌표 → 가장 가까운 도시(C) 구역(통보문 코드표에 있는 것, 지금 유효한 것) */
export async function nearestCityZone(lat, lon, meter, n = 3) {
  const now = nowKst().toISOString().replace(/\D/g, "").slice(0, 12);
  const rows = (await fcstZones(meter)).filter((z) => z.sp === "C" && C_SET.has(z.code) && z.lat && z.lon && z.tmEd >= now);
  return rows
    .map((z) => ({ ...z, 거리km: Math.round(distKm(lat, lon, z.lat, z.lon) * 10) / 10 }))
    .sort((a, b) => a.거리km - b.거리km)
    .slice(0, n);
}

// ── 해석 ────────────────────────────────────────────────────────────────────
const DIR = { N: "북", NNE: "북북동", NE: "북동", ENE: "동북동", E: "동", ESE: "동남동", SE: "남동", SSE: "남남동", S: "남", SSW: "남남서", SW: "남서", WSW: "서남서", W: "서", WNW: "서북서", NW: "북서", NNW: "북북서" };
const RN = { 0: "없음", 1: "비", 2: "비/눈", 3: "눈", 4: "소나기" };
const WF = { DB01: "맑음", DB03: "구름많음", DB04: "흐림" };
const WS = { 1: "약간 강", 2: "강", 3: "매우 강" };
const REL = ["오늘", "내일", "모레", "글피", "그글피", "그글피 다음날"];

function wind(o) {
  const d1 = DIR[o.wd1] || o.wd1 || null;
  const d2 = DIR[o.wd2] || o.wd2 || null;
  if (!d1 && !d2) return null;
  if (!d2 || d1 === d2) return d1;
  return String(o.wdTnd) === "2" ? `${d1} 후 ${d2}` : `${d1}~${d2}`;
}

/** numEf → {날짜, 구분(오전/오후), 상대} */
function slotOf(tm12, numEf) {
  const y = +tm12.slice(0, 4), m = +tm12.slice(4, 6) - 1, d = +tm12.slice(6, 8), h = +tm12.slice(8, 10);
  const base = new Date(Date.UTC(y, m, d));
  if (h < 5) base.setUTCDate(base.getUTCDate() - 1); // 17시 발표분을 자정 넘어 받은 경우와 같은 체계
  const startHalf = h >= 5 && h < 11 ? 0 : 1;
  const off = startHalf + Number(numEf);
  const day = new Date(base.getTime() + Math.floor(off / 2) * 86400000);
  const ymd = day.toISOString().slice(0, 10);
  return { 날짜: ymd, 구분: off % 2 ? "오후" : "오전", 상대: `${REL[Math.floor(off / 2)] || ""}${off % 2 ? "오후" : "오전"}` };
}
const t12 = (v) => String(v ?? "").replace(/\D/g, "").slice(0, 12);
const fmt = (t) => (t && t.length === 12 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}` : t || null);
const n = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function getSituation(stnId, meter) {
  const stn = String(stnId);
  if (!SITUATION_STN[stn]) throw new UpstreamError(`기상개황 관서(stn)는 ${Object.entries(SITUATION_STN).map(([c, nm]) => `${c} ${nm}`).join(", ")} 중 하나입니다: "${stnId}"`, "BAD_PARAM");
  const r = await kmaCall("MSG", "getWthrSituation", { numOfRows: 10, pageNo: 1, stnId: stn }, { meter });
  const it = r.items[0] || {};
  return {
    종류: "기상개황(동네예보 통보문)", 관서: `${SITUATION_STN[stn]}(${stn})`, 발표시각: fmt(t12(it.tmFc)),
    기상개황: it.wfSv1 ?? null,
    특보사항: it.wn ?? null,
    예비특보: it.wr ?? null,
    안내: "특보사항·예비특보 칸은 요약·안내문이다. 특보 본문은 kma_warnings, 과거 이력은 kma_warning_history로 본다.",
  };
}

export async function getLandText(regId, meter) {
  const code = String(regId);
  const reg = msgRegion(code);
  if (reg && reg.kind !== "C") throw new UpstreamError(`육상예보는 도시(C) 구역코드에서만 자료가 나옵니다 — "${reg.name}(${code})"는 ${MSG_KIND[reg.kind]}입니다. kma_find_code(kind=fcst_text_region)로 도시 코드를 찾거나 place를 주세요.`, "BAD_PARAM");
  const r = await kmaCall("MSG", "getLandFcst", { numOfRows: 20, pageNo: 1, regId: code }, { meter });
  const items = r.items.slice().sort((a, b) => Number(a.numEf) - Number(b.numEf));
  const tm = t12(items[0]?.announceTime);
  return {
    종류: "동네예보 통보문 육상예보", 구역: { 구역코드: code, 지역: reg?.name ?? null }, 발표시각: fmt(tm),
    예보: items.map((it) => {
      const s = slotOf(tm, it.numEf);
      const ta = n(it.ta);
      return {
        ...s, 날씨: it.wf ?? null, ...(WF[it.wfCd] && WF[it.wfCd] !== it.wf ? { 하늘: WF[it.wfCd] } : {}), 강수형태: RN[it.rnYn] ?? it.rnYn ?? null, 강수확률: n(it.rnSt),
        ...(s.구분 === "오전" ? { 최저기온: ta } : { 최고기온: ta }),
        바람: wind(it), ...(WS[it.wsIt] ? { 바람세기: WS[it.wsIt] } : {}),
      };
    }),
    해석: "오전 칸의 기온은 예상 최저기온, 오후 칸은 예상 최고기온이다. 05시 발표의 오늘 최저·17시 발표의 오늘 최고는 원천이 주지 않는다(null).",
  };
}

export async function getSeaText(regId, meter) {
  const code = String(regId);
  const reg = msgRegion(code);
  if (reg && !["H", "I"].includes(reg.kind)) throw new UpstreamError(`해상예보는 해상(H·I) 구역코드여야 합니다 — "${reg.name}(${code})"는 ${MSG_KIND[reg.kind]}입니다.`, "BAD_PARAM");
  const r = await kmaCall("MSG", "getSeaFcst", { numOfRows: 20, pageNo: 1, regId: code }, { meter });
  const items = r.items.slice().sort((a, b) => Number(a.numEf) - Number(b.numEf));
  const tm = t12(items[0]?.tmFc);
  const rng = (a, b, u) => (n(a) === null && n(b) === null ? null : n(a) === n(b) || n(b) === null ? `${n(a)}${u}` : `${n(a)}~${n(b)}${u}`);
  return {
    종류: "동네예보 통보문 해상예보", 구역: { 구역코드: code, 지역: reg?.name ?? null }, 발표시각: fmt(tm),
    예보: items.map((it) => ({ ...slotOf(tm, it.numEf), 날씨: it.wf ?? null, ...(WF[it.wfCd] && WF[it.wfCd] !== it.wf ? { 하늘: WF[it.wfCd] } : {}), 강수형태: RN[it.rnYn] ?? it.rnYn ?? null, 바람: wind(it), 풍속: rng(it.ws1, it.ws2, "m/s"), 파고: rng(it.wh1, it.wh2, "m") })),
  };
}
