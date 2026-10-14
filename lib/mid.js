// kma-weather-mcp / lib/mid.js
//
// 중기예보 서비스(MidFcstInfoService) — 전망(getMidFcst)·육상(getMidLandFcst)·기온(getMidTa)·해상(getMidSeaFcst).
//
// ── 명세 ────────────────────────────────────────────────────────────────────
// ★ tmFc는 12자리 YYYYMMDDHHMM이고 발표는 06시·18시(0600·1800)뿐이다. **최근 24시간 자료만** 제공한다.
// ★ 6시 발표는 4~10일 후, 18시 발표는 5~10일 후까지를 담는다(발표시각에 따라 첫 일자가 다르다).
// ★ 전망 stnId: 108 전국·109 서울인천경기·105 강원·131 충북·133 대전세종충남·146 전북·156 광주전남·143 대구경북·159 부산울산경남·184 제주.
// ★ 육상예보 regId는 광역 구역코드(예 11B00000), 기온 regId는 도시 구역코드(예 11B10101), 해상은 해상구역코드.
// 응답의 필드는 일자 번호가 이름에 들어 있다(rnSt4Am, wf7Pm, taMin5, wh4AAm …). 일자별로 다시 묶어서 돌려준다.
//
// 발표 직후에는 자료가 아직 없을 수 있어(코드 03), 가장 최근 발표시각에서 없으면 한 발표 이전으로 한 번 물러선다.

import { UpstreamError, nowKst, fmtYmd, addDays, dashed } from "./common.js";
import { kmaCall } from "./kma.js";

const MID_STN = { 108: "전국", 109: "서울·인천·경기", 105: "강원", 131: "충북", 133: "대전·세종·충남", 146: "전북", 156: "광주·전남", 143: "대구·경북", 159: "부산·울산·경남", 184: "제주" };
export { MID_STN };

/** 발표시각 후보를 최신순으로 — 발표 후 30분 이후부터 제공으로 본다 */
export function tmFcCandidates(now = nowKst(), n = 3) {
  const ymd = fmtYmd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const all = [];
  for (const dd of [0, -1, -2]) {
    const d = addDays(ymd, dd);
    for (const h of ["1800", "0600"]) {
      const m = (dd === 0 ? 0 : 0) + +h.slice(0, 2) * 60;
      if (dd < 0 || m + 30 <= minutes) all.push(`${d}${h}`);
    }
  }
  return all.slice(0, n);
}

function normTmFc(v) {
  const s = String(v ?? "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `${s}00`;
  if (s.length === 12) return s;
  throw new UpstreamError(`tmFc는 YYYYMMDDHHMM(12자리)이어야 하고 시각은 0600 또는 1800입니다: "${v}"`, "BAD_PARAM");
}

async function withTmFc(op, idParam, id, tmFc, meter) {
  const fixed = normTmFc(tmFc);
  if (fixed && !/(0600|1800)$/.test(fixed)) throw new UpstreamError(`tmFc의 시각은 0600 또는 1800이어야 합니다: "${tmFc}"`, "BAD_PARAM");
  const cands = fixed ? [fixed] : tmFcCandidates();
  let lastErr;
  for (const c of cands) {
    try {
      const r = await kmaCall("MID", op, { numOfRows: 10, pageNo: 1, [idParam]: id, tmFc: c }, { meter });
      return { tmFc: c, items: r.items, tried: cands.slice(0, cands.indexOf(c) + 1) };
    } catch (e) {
      lastErr = e;
      if (e.code === "NO_DATA" && !fixed) continue;
      if (e.code === "NO_DATA") e.message += ` (tmFc=${c}. 중기예보는 최근 24시간 발표분만 제공합니다)`;
      throw e;
    }
  }
  lastErr.message += ` (시도한 발표시각: ${cands.join(", ")})`;
  throw lastErr;
}

const hhmm = (tmFc) => `${dashed(tmFc.slice(0, 8))} ${tmFc.slice(8, 10)}:${tmFc.slice(10, 12)}`;

export async function getMidOutlook(stnId, tmFc, meter) {
  if (!MID_STN[stnId]) throw new UpstreamError(`전망 stnId는 ${Object.keys(MID_STN).join("·")} 중 하나여야 합니다: "${stnId}"`, "BAD_PARAM");
  const r = await withTmFc("getMidFcst", "stnId", stnId, tmFc, meter);
  const it = r.items[0] || {};
  return { 종류: "중기전망", 지역: MID_STN[stnId], 발표시각: hhmm(r.tmFc), 전망문: it.wfSv ?? null, 원본키: Object.keys(it) };
}

/** 육상: rnSt{N}[Am|Pm] 강수확률, wf{N}[Am|Pm] 날씨 */
export async function getMidLand(regId, tmFc, meter) {
  const r = await withTmFc("getMidLandFcst", "regId", regId, tmFc, meter);
  const it = r.items[0] || {};
  const days = {};
  const rest = {};
  for (const [k, v] of Object.entries(it)) {
    const m = k.match(/^(rnSt|wf)(\d+)(Am|Pm)?$/);
    if (!m) { rest[k] = v; continue; }
    const n = Number(m[2]);
    const slot = m[3] === "Am" ? "오전" : m[3] === "Pm" ? "오후" : "종일";
    days[n] ??= {};
    days[n][slot] ??= {};
    days[n][slot][m[1] === "rnSt" ? "강수확률" : "날씨"] = v;
  }
  return {
    종류: "중기육상예보", 구역코드: regId, 발표시각: hhmm(r.tmFc),
    발표일기준: "N일 후 = 발표일 + N일(오전/오후가 없는 일자는 종일 값)",
    일별: Object.keys(days).sort((a, b) => a - b).map((n) => ({ 발표일후: Number(n), ...days[n] })),
    ...(Object.keys(rest).length ? { 기타필드: rest } : {}),
  };
}

/** 기온: taMin{N}·taMax{N}(+ Low/High 신뢰구간) */
export async function getMidTemp(regId, tmFc, meter) {
  const r = await withTmFc("getMidTa", "regId", regId, tmFc, meter);
  const it = r.items[0] || {};
  const days = {};
  const rest = {};
  for (const [k, v] of Object.entries(it)) {
    const m = k.match(/^ta(Min|Max)(\d+)(Low|High)?$/);
    if (!m) { rest[k] = v; continue; }
    const n = Number(m[2]);
    days[n] ??= {};
    const name = (m[1] === "Min" ? "최저기온" : "최고기온") + (m[3] === "Low" ? "_예상하한" : m[3] === "High" ? "_예상상한" : "");
    days[n][name] = v;
  }
  return {
    종류: "중기기온예보", 구역코드: regId, 발표시각: hhmm(r.tmFc),
    일별: Object.keys(days).sort((a, b) => a - b).map((n) => ({ 발표일후: Number(n), ...days[n] })),
    ...(Object.keys(rest).length ? { 기타필드: rest } : {}),
  };
}

/** 해상: wh{N}[A|B][Am|Pm] 파고(m), wf{N}[Am|Pm] 날씨 */
export async function getMidSea(regId, tmFc, meter) {
  const r = await withTmFc("getMidSeaFcst", "regId", regId, tmFc, meter);
  const it = r.items[0] || {};
  const days = {};
  const rest = {};
  for (const [k, v] of Object.entries(it)) {
    const m = k.match(/^(wh|wf)(\d+)([AB])?(Am|Pm)?$/);
    if (!m) { rest[k] = v; continue; }
    const n = Number(m[2]);
    const slot = (m[3] ? `구간${m[3]}` : "") + (m[4] === "Am" ? "오전" : m[4] === "Pm" ? "오후" : m[3] ? "" : "종일");
    days[n] ??= {};
    days[n][slot || "종일"] ??= {};
    days[n][slot || "종일"][m[1] === "wh" ? "파고" : "날씨"] = v;
  }
  return {
    종류: "중기해상예보", 구역코드: regId, 발표시각: hhmm(r.tmFc),
    일별: Object.keys(days).sort((a, b) => a - b).map((n) => ({ 발표일후: Number(n), ...days[n] })),
    ...(Object.keys(rest).length ? { 기타필드: rest } : {}),
  };
}
