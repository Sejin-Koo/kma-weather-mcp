// kma-weather-mcp / lib/impact.js
//
// 영향예보(폭염·한파) — 특보구역별·분야별 위험수준(0 영향없음·1 관심·2 주의·3 경고·4 위험). API허브 typ01.
//   ifs_fct_pstt.php      발표현황(구역 × 분야 × 기준일 행)
//   ifs_ilvl_zone_cnt.php 위험수준별 발표지역 수(관서 × 분야 × 수준 행, 구역코드 목록 포함)
//   ifs_ilvl_dmap.php     위험수준 분포도 PNG
//
// ── 명세 ────────────────────────────────────────────────────────────────────
// ★ 발표 매일 11:30(실측 TM_FC=…1130). TM_EF 기준일은 발표 다음날부터 2일 유효(EF_SN 1 내일·2 모레·3 둘 다).
// ★ IFPAR hw 폭염·cw 한파(생략 시 발효 중인 요소 전부).
//   IFAREA 폭염: 0 모든 분야·1 보건(일반인)·2 보건(취약인)·3 산업·4 축산업·5 농업·6 수산양식·7 기타
//          한파: 0 모든 분야·1 보건·2 산업·3 시설물·4 농축산업·5 수산양식·6 기타 (원천 기본값 1)
// ★ REG_ID는 특보구역코드다 — 2026-05-31 구역 개편 전 자료는 옛 코드로 온다 → warnhub의 구역표·일치 규칙을 쓴다.
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ 2019-08 자료도 나온다. 2025년 폭염 1년(분야 1) = 16,685행·1.2MB·6.3초, 2026-01 한파 전 분야(ef_sn 3) = 36,852행·2.6MB·10.9초
//   → 서버가 요약하고 목록은 limit까지만 돌려준다. 한 번에 366일까지.
// ★ 분포도는 PNG(1480×1600, 약 400KB)인데 Content-Type이 text/plain으로 온다 → hub.js가 매직 바이트로 판정.
// ★ 10월 중순 기준 오늘 발표분에 한파(CW) 행이 있었다(대부분 0 영향없음).

import { UpstreamError, todayKst, normalizeDate, daysBetween } from "./common.js";
import { hubGet, csvRows } from "./hub.js";
import { zoneTable, zoneLabel, zoneMatcher, ZONE_MATCH_NOTE } from "./warnhub.js";

export const IFPAR = { hw: "폭염", cw: "한파" };
export const IFAREA = {
  hw: { 0: "모든 분야", 1: "보건(일반인)", 2: "보건(취약인)", 3: "산업", 4: "축산업", 5: "농업", 6: "수산양식", 7: "기타" },
  cw: { 0: "모든 분야", 1: "보건", 2: "산업", 3: "시설물", 4: "농축산업", 5: "수산양식", 6: "기타" },
};
export const ILVL = { 0: "영향없음", 1: "관심", 2: "주의", 3: "경고", 4: "위험" };
const EF = { 1: "내일", 2: "모레" };
export const IMPACT_STN = { 108: "본청", 109: "수도권", 105: "강원", 131: "청주", 133: "대전", 146: "전주", 156: "광주", 143: "대구", 159: "부산", 184: "제주" };

const fmt12 = (t) => (t && t.length >= 12 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}` : t);
const fmt8 = (t) => (t && t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t);

function parsePar(v) {
  if (!v) return "";
  const s = String(v).trim().toLowerCase();
  if (s === "hw" || s === "폭염") return "hw";
  if (s === "cw" || s === "한파") return "cw";
  throw new UpstreamError(`ifpar는 hw(폭염)·cw(한파) 중 하나입니다: "${v}"`, "BAD_PARAM");
}
function areaLabel(par, a) {
  const p = String(par || "").toLowerCase();
  return (IFAREA[p] && IFAREA[p][a]) || (IFAREA.hw[a] === IFAREA.cw[a] ? IFAREA.hw[a] : `분야 ${a}`);
}

function period(from, to, basis) {
  const f = normalizeDate(from, "from") || todayKst();
  const t = normalizeDate(to, "to") || f;
  if (t < f) throw new UpstreamError(`to(${t})가 from(${f})보다 앞입니다.`, "BAD_PARAM");
  if (daysBetween(f, t) > 366) throw new UpstreamError(`한 번에 366일까지 조회합니다(1년 폭염 약 16,000행): ${f}~${t}. 기간을 나누세요.`, "BAD_PARAM");
  return basis === "tmef" ? `tmef1=${f}&tmef2=${t}` : `tmfc1=${f}&tmfc2=${t}`;
}

/**
 * 발표현황 요약. areaCodes(특보구역코드 목록)를 주면 하위·옛 구역까지 맞춰 거른다.
 * minLevel: 목록에 남길 최소 위험수준(기본 1 관심 — 0 영향없음 행은 요약에만 센다)
 */
export async function impactStatus({ from, to, basis = "tmfc", ifpar, ifarea, stn, efSn, areaCodes, minLevel = 1, limit = 100 }, meter) {
  const par = parsePar(ifpar);
  const area = ifarea === undefined || ifarea === null || ifarea === "" ? 1 : Number(ifarea);
  if (!(area >= 0 && area <= 7)) throw new UpstreamError("ifarea는 0~7입니다(0 모든 분야).", "BAD_PARAM");
  const ef = efSn ? Number(efSn) : 1;
  let q = `${period(from, to, basis)}&ifarea=${area}&ef_sn=${ef}&help=0`;
  if (par) q += `&ifpar=${par}`;
  if (stn) q += `&stn=${Number(stn)}`;
  const text = await hubGet(`/typ01/url/ifs_fct_pstt.php?${q}`, { source: "기상청 API허브 영향예보 발표현황(ifs_fct_pstt)", meter, encoding: "euc-kr", timeoutMs: 20000 });
  let rows = csvRows(text)
    .filter((p) => /^\d{12}$/.test(p[0]))
    .map((p) => ({ tmFc: p[0], tmEf: p[1], stn: p[2], reg: p[3], par: p[4].toLowerCase(), area: Number(p[5]), lvl: Number(p[6]), ef: Number(p[7]) }));
  // ★ 실측: ifpar=hw로 불러도 명세에 없는 요소 HO 행이 섞여 왔다(2025-08-05 발표 9행). 요청한 요소만 남기고 따로 알린다.
  let foreign = 0;
  if (par) {
    const keep = rows.filter((r) => r.par === par);
    foreign = rows.length - keep.length;
    rows = keep;
  }
  const map = await zoneTable(meter);
  let matched = null;
  if (areaCodes && areaCodes.length) {
    const hit = zoneMatcher(map, areaCodes);
    rows = rows.filter((r) => hit(r.reg));
    matched = [...new Set(rows.map((r) => r.reg))].map((c) => `${map.get(c)?.name || c}(${c})`);
  }
  // 요약: 요소×분야×수준별 행 수·구역 수, 기준일별 최고 수준 구역 수
  const by = {};
  for (const r of rows) {
    const k = `${IFPAR[r.par] || r.par}|${areaLabel(r.par, r.area)}|${r.lvl}`;
    by[k] = by[k] || { n: 0, z: new Set(), first: r.tmEf, last: r.tmEf };
    by[k].n++;
    by[k].z.add(r.reg);
    if (r.tmEf < by[k].first) by[k].first = r.tmEf;
    if (r.tmEf > by[k].last) by[k].last = r.tmEf;
  }
  const summary = Object.entries(by)
    .map(([k, b]) => {
      const [p, a, l] = k.split("|");
      return { 요소: p, 분야: a, 위험수준: ILVL[l] ?? l, 수준값: Number(l), 행수: b.n, 구역수: b.z.size, 첫기준일: fmt8(b.first), 마지막기준일: fmt8(b.last) };
    })
    .sort((x, y) => y.수준값 - x.수준값 || y.행수 - x.행수);
  // 구역별 최고 수준
  const peak = new Map();
  for (const r of rows) {
    const k = `${r.par}|${r.area}|${r.reg}`;
    const cur = peak.get(k);
    if (!cur || r.lvl > cur.lvl || (r.lvl === cur.lvl && r.tmEf < cur.tmEf)) peak.set(k, { ...r, days: (cur?.lvl === r.lvl ? cur.days : 0) + 1 });
    else if (r.lvl === cur.lvl) cur.days++;
  }
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const ml = Number(minLevel ?? 1);
  const listed = rows.filter((r) => r.lvl >= ml).sort((a, b) => b.tmEf.localeCompare(a.tmEf) || b.lvl - a.lvl);
  const list = listed.slice(0, n).map((r) => ({
    발표시각: fmt12(r.tmFc), 기준일: fmt8(r.tmEf), 예보일수: EF[r.ef] || r.ef, ...zoneLabel(map, r.reg), 요소: IFPAR[r.par] || r.par, 분야: areaLabel(r.par, r.area), 위험수준: ILVL[r.lvl] ?? r.lvl, 관서: IMPACT_STN[r.stn] || r.stn,
  }));
  const peaks = [...peak.values()].filter((p) => p.lvl >= Math.max(ml, 1)).sort((a, b) => b.lvl - a.lvl || b.days - a.days).slice(0, 50)
    .map((p) => ({ ...zoneLabel(map, p.reg), 요소: IFPAR[p.par] || p.par, 분야: areaLabel(p.par, p.area), 최고위험수준: ILVL[p.lvl], 그수준일수: p.days, 처음: fmt8(p.tmEf) }));
  return {
    종류: "영향예보 발표현황",
    조건: { 기간: `${basis === "tmef" ? "기준일" : "발표일"} ${from || todayKst()} ~ ${to || from || todayKst()}`, 요소: par ? IFPAR[par] : "발효 중 전체", 분야: area === 0 ? "모든 분야" : areaLabel(par || "hw", area), 예보일수: ef === 3 ? "내일+모레" : EF[ef], ...(stn ? { 관서: IMPACT_STN[stn] || stn } : {}), ...(areaCodes?.length ? { 구역: areaCodes } : {}) },
    전체행수: rows.length,
    위험수준요약: summary,
    구역별최고수준: peaks,
    목록행수: listed.length,
    반환행수: list.length,
    ...(listed.length > list.length ? { 잘림: `목록 대상 ${listed.length}행 중 ${list.length}행만 돌려줬다(요약은 전체 기준).` } : {}),
    ...(matched ? { 구역안내: ZONE_MATCH_NOTE, 맞춘구역: matched } : {}),
    ...(foreign ? { 제외행: `요청 요소(${IFPAR[par]})가 아닌 행 ${foreign}개를 뺐다(원천이 명세에 없는 요소 코드를 섞어 보냄)` } : {}),
    안내: `행은 특보구역×분야×기준일 단위다. 목록은 위험수준 ${ILVL[ml] ?? ml} 이상만(min_level로 바꾼다). 분야를 생략하면 원천 기본값 1(${IFAREA.hw[1]}/${IFAREA.cw[1]})이다. 영향예보는 특보와 별개 정보다 — 폭염·한파 특보 발효 여부는 kma_warning_history로 본다.`,
    목록: list,
  };
}

/** 위험수준별 발표지역 수 */
export async function impactCounts({ from, to, basis = "tmfc", ifpar, ifarea, stn, ilvl, efSn, limit = 100 }, meter) {
  const par = parsePar(ifpar);
  let q = `${period(from, to, basis)}&ef_sn=${efSn ? Number(efSn) : 1}&help=0`;
  if (par) q += `&ifpar=${par}`;
  if (ifarea !== undefined && ifarea !== null && ifarea !== "") q += `&ifarea=${Number(ifarea)}`;
  if (stn) q += `&stn=${Number(stn)}`;
  if (ilvl !== undefined && ilvl !== null && ilvl !== "") q += `&ilvl=${Number(ilvl)}`;
  const text = await hubGet(`/typ01/url/ifs_ilvl_zone_cnt.php?${q}`, { source: "기상청 API허브 영향예보 위험수준별 지역 수(ifs_ilvl_zone_cnt)", meter, encoding: "euc-kr", timeoutMs: 20000 });
  const map = await zoneTable(meter);
  const rows = csvRows(text)
    .filter((p) => /^\d{12}$/.test(p[0]))
    .map((p) => ({ tmFc: p[0], tmEf: p[1], stn: p[2], par: p[3].toLowerCase(), area: Number(p[4]), lvl: Number(p[5]), cnt: Number(p[6]), ids: p.slice(7, -1).filter(Boolean), ef: Number(p[p.length - 1]) }));
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sorted = rows.sort((a, b) => b.tmEf.localeCompare(a.tmEf) || b.lvl - a.lvl);
  return {
    종류: "영향예보 위험수준별 발표지역 수",
    전체행수: rows.length, 반환행수: Math.min(n, rows.length),
    ...(rows.length > n ? { 잘림: `전체 ${rows.length}행 중 ${n}행만 돌려줬다.` } : {}),
    목록: sorted.slice(0, n).map((r) => ({
      발표시각: fmt12(r.tmFc), 기준일: fmt8(r.tmEf), 예보일수: EF[r.ef] || r.ef, 관서: IMPACT_STN[r.stn] || r.stn, 요소: IFPAR[r.par] || r.par, 분야: areaLabel(r.par, r.area), 위험수준: ILVL[r.lvl] ?? r.lvl, 지역수: r.cnt,
      구역: r.ids.slice(0, 40).map((c) => map.get(c)?.name || c), ...(r.ids.length > 40 ? { 구역생략: r.ids.length - 40 } : {}),
    })),
  };
}

/** 분포도 PNG */
export async function impactMap({ tmfc, stn, ifpar, ifarea, efSn }, meter) {
  const t = normalizeDate(tmfc, "tmfc") || todayKst();
  let q = `tmfc=${t}`;
  if (stn) q += `&stn=${Number(stn)}`;
  const par = parsePar(ifpar);
  if (par) q += `&ifpar=${par}`;
  if (ifarea !== undefined && ifarea !== null && ifarea !== "") q += `&ifarea=${Number(ifarea)}`;
  if (efSn) q += `&ef_sn=${Number(efSn)}`;
  const img = await hubGet(`/typ01/url/ifs_ilvl_dmap.php?${q}`, { source: "기상청 API허브 영향예보 분포도(ifs_ilvl_dmap)", meter, encoding: "euc-kr", timeoutMs: 20000, binary: true });
  return { ...img, tmfc: fmt8(t) };
}
