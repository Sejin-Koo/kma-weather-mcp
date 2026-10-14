// kma-weather-mcp / lib/geo.js
//
// 위치 해석 — 지역명·좌표를 기상청 각 API가 요구하는 코드로 바꾼다.
//   · 동네예보 격자(nx, ny)        : 위경도 → 격자는 기상청 표준 람베르트 정각원추도법(LCC)으로 계산하고,
//                                    지역명 → 격자는 기상청 격자 파일(3,838개 행정구역)을 쓴다.
//   · 생활기상지수 areaNo           : 같은 파일의 행정구역코드 10자리가 곧 areaNo다.
//   · 특보구역·중기예보구역          : 이름 포함 검색 + 행정구역 기준 추정(추정은 추정이라고 표시한다).
//
// 격자 변환식 상수(기상청 공개 변환 코드): RE=6371.00877km, GRID=5km, SLAT1=30, SLAT2=60, OLON=126, OLAT=38, XO=43, YO=136.

import AREAS from "../data/areas.js"; // [코드,1단계,2단계,3단계,nx,ny,경도,위도]
import WARN_ZONES from "../data/warnzones.js"; // [코드,구역명,상위코드,정식명칭]
import MID_REGIONS from "../data/midregions.js"; // [코드,구역명,특성]
import TOUR from "../data/tour.js";
import CCTV from "../data/cctv.js"; // [id,노선,지점명]

const RAD = Math.PI / 180;
const RE = 6371.00877 / 5.0;
const SLAT1 = 30 * RAD;
const SLAT2 = 60 * RAD;
const OLON = 126 * RAD;
const OLAT = 38 * RAD;
const XO = 43;
const YO = 136;
const SN = Math.log(Math.cos(SLAT1) / Math.cos(SLAT2)) / Math.log(Math.tan(Math.PI * 0.25 + SLAT2 * 0.5) / Math.tan(Math.PI * 0.25 + SLAT1 * 0.5));
const SF = (Math.pow(Math.tan(Math.PI * 0.25 + SLAT1 * 0.5), SN) * Math.cos(SLAT1)) / SN;
const RO = (RE * SF) / Math.pow(Math.tan(Math.PI * 0.25 + OLAT * 0.5), SN);

/** 위경도(도) → 동네예보 격자 */
export function toGrid(lat, lon) {
  const ra = (RE * SF) / Math.pow(Math.tan(Math.PI * 0.25 + lat * RAD * 0.5), SN);
  let theta = lon * RAD - OLON;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= SN;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(RO - ra * Math.cos(theta) + YO + 0.5) };
}

export const GRID_RANGE = { nx: [1, 149], ny: [1, 253] };
export function validGrid(nx, ny) {
  return Number.isInteger(nx) && Number.isInteger(ny) && nx >= 1 && nx <= 149 && ny >= 1 && ny <= 253;
}

// ── 행정구역 ────────────────────────────────────────────────────────────────
const ALIAS_L1 = {
  서울특별시: ["서울"], 부산광역시: ["부산"], 대구광역시: ["대구"], 인천광역시: ["인천"], 광주광역시: ["광주"], 대전광역시: ["대전"], 울산광역시: ["울산"],
  세종특별자치시: ["세종"], 경기도: ["경기"], 강원특별자치도: ["강원", "강원도"], 충청북도: ["충북"], 충청남도: ["충남"], 전북특별자치도: ["전북", "전라북도"],
  전라남도: ["전남"], 경상북도: ["경북"], 경상남도: ["경남"], 제주특별자치도: ["제주", "제주도"],
  전남광주통합특별시: ["전남", "전라남도", "광주", "광주광역시"],
};
// 2026 행정구역 통합: 기상청 격자 파일(20260701)은 전라남도·광주광역시를 '전남광주통합특별시'로 묶었으나
// 중기예보·특보 구역표는 옛 시도 체계 그대로다 → 구역 추정에는 옛 시도명으로 되돌려 쓴다.
const GWANGJU_GU = ["동구", "서구", "남구", "북구", "광산구"];
function legacyL1(r) {
  if (r.l1 !== "전남광주통합특별시") return r.l1;
  return GWANGJU_GU.includes((r.l2 || "").trim()) ? "광주광역시" : "전라남도";
}
const squash = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

const rows = AREAS.map((a) => ({
  code: a[0], l1: a[1], l2: a[2], l3: a[3], nx: a[4], ny: a[5], lon: a[6], lat: a[7],
  level: a[3] ? 3 : a[2] ? 2 : 1,
  hay: squash([a[1], ...(ALIAS_L1[a[1]] || []), a[2], a[3]].join("")),
  full: [a[1], a[2], a[3]].filter(Boolean).join(" "),
}));

export function areaOut(r) {
  return { 행정구역코드: r.code, 지역: r.full, 격자: { nx: r.nx, ny: r.ny }, 경도: r.lon, 위도: r.lat, 단계: r.level };
}

export const AREA_COUNT = rows.length;
export function getAreaByCode(code) {
  return rows.find((r) => r.code === String(code)) || null;
}

/** 지역명 검색. 공백으로 나눈 모든 토큰이 (시도 별칭 포함) 지역명에 들어 있는 행. 상위 단계를 먼저. */
export function findAreas(query, limit = 20) {
  const toks = String(query || "").split(/[\s,]+/).map(squash).filter(Boolean);
  if (!toks.length) return { total: 0, rows: [] };
  const hit = rows.filter((r) => toks.every((t) => r.hay.includes(t)));
  // 마지막 토큰이 가장 깊은 단계의 이름과 일치하는 행을 앞에
  const last = toks[toks.length - 1];
  const exact = (r) => squash(r.l3 || r.l2 || r.l1).startsWith(last) || squash(r.l3 || r.l2 || r.l1) === last;
  hit.sort((a, b) => (exact(b) - exact(a)) || a.level - b.level || a.full.length - b.full.length);
  return { total: hit.length, rows: hit.slice(0, limit) };
}

/** 위경도에서 가장 가까운 행정구역(3단계 우선, 없으면 전체). 평면 근사 거리. */
export function nearestArea(lat, lon, n = 1) {
  const cosl = Math.cos(lat * RAD);
  const d = (r) => ((r.lat - lat) ** 2 + ((r.lon - lon) * cosl) ** 2);
  const cand = rows.filter((r) => r.level === 3);
  const sorted = (cand.length ? cand : rows).map((r) => [d(r), r]).sort((a, b) => a[0] - b[0]).slice(0, n);
  return sorted.map(([dd, r]) => ({ ...r, 거리km: Math.round(Math.sqrt(dd) * 111 * 10) / 10 }));
}

// ── 중기예보 구역 ───────────────────────────────────────────────────────────
// 육상예보(getMidLandFcst)는 광역 구역코드(특성 A), 중기기온(getMidTa)은 도시 구역코드(특성 C), 해상예보는 특성 H.
const GANGWON_YEONGDONG = ["강릉", "동해", "삼척", "속초", "고성", "양양", "태백"];
const LAND_BY_L1 = {
  서울특별시: "11B00000", 인천광역시: "11B00000", 경기도: "11B00000",
  충청북도: "11C10000", 충청남도: "11C20000", 대전광역시: "11C20000", 세종특별자치시: "11C20000",
  전북특별자치도: "11F10000", 전라남도: "11F20000", 광주광역시: "11F20000",
  경상북도: "11H10000", 대구광역시: "11H10000", 경상남도: "11H20000", 부산광역시: "11H20000", 울산광역시: "11H20000",
  제주특별자치도: "11G00000",
};
const MID = MID_REGIONS.map((m) => ({ code: m[0], name: m[1], kind: m[2] }));
const KIND_LABEL = { A: "육상예보(광역)", C: "중기기온·도시", H: "해상예보" };

export function midOut(m) {
  return { 구역코드: m.code, 구역명: m.name, 용도: KIND_LABEL[m.kind] || m.kind };
}

export function findMidRegions(query, limit = 30) {
  const q = squash(query);
  const hit = MID.filter((m) => !q || squash(m.name).includes(q) || m.code.toLowerCase() === q);
  return { total: hit.length, rows: hit.slice(0, limit).map(midOut) };
}

/** 행정구역 → 중기예보 구역(추정). 정확한 기상청 구역 배정표가 아니라 이름 일치·광역 규칙으로 추정한다. */
export function midForArea(r) {
  const out = { 추정: true, 근거: "행정구역명과 중기예보 구역명의 일치·광역 규칙(기상청 공식 배정표 아님)" };
  const l1 = legacyL1(r);
  let land = LAND_BY_L1[l1];
  if (r.l1 === "강원특별자치도") {
    const base = (r.l2 || "").replace(/[시군]$/, "");
    land = GANGWON_YEONGDONG.includes(base) ? "11D20000" : "11D10000";
  }
  if (land) {
    const m = MID.find((x) => x.code === land);
    out.육상예보 = { 구역코드: land, 구역명: m ? m.name : land };
  }
  const name2 = (r.l2 || "").replace(/\s.*$/, "").replace(/(특별시|광역시|시|군|구)$/, "");
  const name1 = (l1 || "").replace(/(특별자치도|특별자치시|특별시|광역시|도)$/, "");
  const cands = [name2, name1].filter(Boolean);
  // 같은 이름의 도시 구역이 시도마다 있을 수 있다(광주: 경기 11B20702 / 광주광역시 11F20501, 고성: 강원 / 경남)
  // → 육상 광역 코드와 앞 3자리가 같은 것을 먼저 고른다
  const pre = land ? land.slice(0, 3) : null;
  for (const c of cands) {
    const same = MID.filter((x) => x.kind === "C" && x.name === c);
    const m = (pre && same.find((x) => x.code.startsWith(pre))) || same[0];
    if (m) {
      out.중기기온 = { 구역코드: m.code, 구역명: m.name, 일치: c === name2 ? "시군구명" : "시도명" };
      break;
    }
  }
  if (!out.중기기온) out.중기기온 = null;
  return out;
}

/** 구역코드 → 중기 구역 행 */
export function midByCode(code) {
  return MID.find((x) => x.code === code) || null;
}

/** 지상관측소 예보구역코드(FCT_ID, 중기기온 도시 코드 체계) → 중기기온·육상예보 구역.
 *  육상은 도시 코드 앞 4자리+0000, 없으면 앞 3자리+00000(11B·11G 등)으로 광역 구역을 찾는다. */
export function midFromForecastCode(fct) {
  if (!fct) return null;
  const temp = MID.find((x) => x.code === fct && x.kind === "C") || null;
  const landCode = [fct.slice(0, 4) + "0000", fct.slice(0, 3) + "00000"].find((c) => MID.some((x) => x.code === c && x.kind === "A"));
  const land = landCode ? midByCode(landCode) : null;
  return {
    중기기온: temp ? { 구역코드: temp.code, 구역명: temp.name } : null,
    육상예보: land ? { 구역코드: land.code, 구역명: land.name } : null,
  };
}

// ── 특보구역 ────────────────────────────────────────────────────────────────
const WZ = WARN_ZONES.map((w) => ({ code: w[0], name: w[1], up: w[2], formal: w[3] }));
const wzByCode = new Map(WZ.map((w) => [w.code, w]));
export function warnOut(w) {
  const up = wzByCode.get(w.up);
  return { 특보구역코드: w.code, 구역명: w.name, 정식명칭: w.formal, 상위구역: up ? `${up.name}(${up.code})` : w.up || null };
}
export function findWarnZones(query, limit = 30) {
  const q = squash(query);
  const hit = WZ.filter((w) => !q || squash(w.name).includes(q) || squash(w.formal).includes(q) || w.code.toLowerCase() === q);
  return { total: hit.length, rows: hit.slice(0, limit).map(warnOut) };
}
/** 행정구역 → 특보구역(추정): 시군구 정식명칭 일치를 먼저, 없으면 시도 */
export function warnForArea(r) {
  const out = [];
  const l2 = r.l2 ? r.l2.replace(/\s.*$/, "") : "";
  const l1 = legacyL1(r);
  // 시도 특보구역(최상위 바로 아래) — 이름이 같은 시군구 구역이 다른 시도에도 있어(광주·고성 등) 그 아래 것만 남긴다
  const top = WZ.filter((w) => w.up === "L1000000");
  const PZ = { 강원특별자치도: "L1020000", 전북특별자치도: "L1060000", 제주특별자치도: "L1090000" }; // 구역표는 옛 명칭(강원도·전북자치도·제주도)
  const pz = (PZ[l1] && wzByCode.get(PZ[l1])) || top.find((w) => w.formal === l1) || top.find((w) => w.name === (l1 || "").replace(/(특별자치도|특별자치시|특별시|광역시|도)$/, "")) || null;
  const under = (w) => {
    for (let x = w, i = 0; x && i < 6; x = wzByCode.get(x.up), i++) if (pz && x.code === pz.code) return true;
    return false;
  };
  if (l2) WZ.filter((w) => (w.formal === l2 || w.name === l2.replace(/(시|군)$/, "")) && (!pz || under(w))).forEach((w) => out.push(w));
  if (pz) {
    out.push(pz);
    const seen0 = new Set();
    return out.filter((w) => (seen0.has(w.code) ? false : seen0.add(w.code))).slice(0, 6).map(warnOut);
  }
  const L1 = { 서울특별시: "서울", 경기도: "경기도", 인천광역시: "인천", 강원특별자치도: "강원", 충청북도: "충북", 충청남도: "충남", 전북특별자치도: "전북", 전라남도: "전남", 경상북도: "경북", 경상남도: "경남", 제주특별자치도: "제주" };
  const key = L1[l1] || (l1 || "").replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, "");
  WZ.filter((w) => w.name === key || (w.formal || "").includes(key)).slice(0, 3).forEach((w) => out.push(w));
  const seen = new Set();
  return out.filter((w) => (seen.has(w.code) ? false : seen.add(w.code))).slice(0, 6).map(warnOut);
}

// ── 관광 ────────────────────────────────────────────────────────────────────
const SPOTS = TOUR.spots.map((s) => ({
  theme: s[0], courseId: s[1], spotId: s[2], areaId: s[3], name: s[4], lon: s[5], lat: s[6], order: s[7], moveMin: s[8], indoor: s[9], themeName: s[10],
}));
export const TOUR_COURSE_COUNT = Object.keys(TOUR.courses).length;
export const TOUR_SPOT_COUNT = SPOTS.length;
export function findTourCourses(query, limit = 20) {
  const q = squash(query);
  const ids = Object.keys(TOUR.courses);
  // 숫자만 주면 코스ID 정확 일치를 먼저 본다(코스명 안의 숫자와 섞이지 않게)
  let hit = /^\d+$/.test(q) ? ids.filter((id) => id === q) : [];
  if (!hit.length) hit = ids.filter((id) => !q || id === q || squash(TOUR.courses[id].name).includes(q) || TOUR.courses[id].spots.some((s) => squash(s).includes(q)));
  return {
    total: hit.length,
    rows: hit.slice(0, limit).map((id) => ({ 코스ID: Number(id), 코스명: TOUR.courses[id].name, 관광지: TOUR.courses[id].spots })),
  };
}
export function tourSpotsOfCourse(courseId) {
  return SPOTS.filter((s) => s.courseId === Number(courseId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
export function findTourCities(query, limit = 30) {
  const q = squash(query);
  const hit = Object.entries(TOUR.cities).filter(([id, nm]) => !q || id === q || squash(nm).includes(q));
  return { total: hit.length, rows: hit.slice(0, limit).map(([id, nm]) => ({ 시군구ID: id, 이름: nm })) };
}

// ── CCTV ────────────────────────────────────────────────────────────────────
const CC = CCTV.map((c) => ({ id: c[0], route: c[1], name: c[2] }));
export const CCTV_COUNT = CC.length;
export function findCctv(query, limit = 30) {
  const toks = String(query || "").split(/[\s,]+/).map(squash).filter(Boolean);
  const hit = CC.filter((c) => !toks.length || toks.every((t) => squash(c.route + c.name + c.id).includes(t)));
  return { total: hit.length, rows: hit.slice(0, limit).map((c) => ({ CCTV_ID: c.id, 노선: c.route, 지점명: c.name })) };
}
export function cctvName(id) {
  const c = CC.find((x) => x.id === id);
  return c ? { 노선: c.route, 지점명: c.name } : null;
}
export function cctvRoutes() {
  const m = new Map();
  for (const c of CC) m.set(c.route, (m.get(c.route) || 0) + 1);
  return [...m.entries()].map(([노선, 지점수]) => ({ 노선, 지점수 }));
}
