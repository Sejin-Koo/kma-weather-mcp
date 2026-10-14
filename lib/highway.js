// kma-weather-mcp / lib/highway.js
//
// 국내 고속도로 날씨 — API허브 typ01 cgi-bin.
//   nph-land_highway_weather_txt  날씨실황(loc: 노선2 / 노선2+종류2 / 노선2+종류2+상세2자리 → 그 범위 전 지점)
//   nph-land_highway_shrt_txt     단기예보(route·start·end·tm·car → 출발시각부터 차량 속도로 계산한 지점별 도착시각의 예보)
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ 노선코드는 방향별이다(01 경부선-상행·02 경부선-하행 …, 17개 노선 × 2방향). 예보 지점코드는 그 방향의 진행 순서다.
//   start>end로 주면 오류 없이 순서만 뒤집혀 나온다 → 방향은 서버가 노선코드로 정한다(출발이 앞 순번인 방향).
// ★ 실황은 loc를 비우면 오류(<Error>)다. 노선코드(2자리)만 주면 그 노선 전 지점(경부선-상행 87개)이 온다.
//   자료 시각은 조회 시각 기준 5~10분 전이었다(15:4x 조회 → 15:35·15:40).
// ★ 예보 출발시각(tm, HHMM, 오늘)은 '지금부터 3시간 뒤까지'만 된다(20시 거부: "출발 시각은 현재 시간보다 3시간 이내여야 합니다.").
//   지난 시각(10시)은 받아줬다.
// ★★ 차량유형: 가이드는 승용차 100km/h·대형차 80km/h로 산정한다고 적었으나, 경부선 하행 양재IC→구서IC 16:00 출발이
//   승용차 19:50 도착, 대형차 19:04 도착으로 대형차가 46분 먼저 도착했다(중간 지점도 전부 대형차가 앞섬, 실측 1건) → 대형차 결과에 경고를 붙인다.
// ★ typ01 간헐 무응답은 무응답 뒤 다음 시도가 1~3초라 시간 제한을 8초로 짧게 두고 4회 시도한다
//   (3회로는 기흥IC 실황 첫 호출이 끝내 실패한 사례가 있었다 — 2026-10-14 실사용 시험).
// ★ 결측은 nan. 출력은 disp=1(CSV)로 받는다.
//   실황 열: YYMMDD_KST,HWAY_NAME,POINT_TYPE,POINT_NAME,LAT,LON,RN_OX,RN_60M,RN_DAY,RR,LTG_OX,LTG_DIST,FOG,VS,WD_10M,WS_10M,TA
//   예보 열: YYMMDD_KST,CAR_TYPE,HWAY_NAME,POINT_NAME,LAT,LON,SKY,RN1,PTY,POP,SNO,VEC,WSD,T1H,LGT

import { UpstreamError, nowKst } from "./common.js";
import { hubGet, csvRows, num, fmt12, distKm, SKY_TXT, PTY_TXT } from "./hub.js";
import HW from "../data/highway.js";

const squash = (s) => String(s || "").replace(/[\s()·.-]+/g, "").toLowerCase();
export const HW_ROUTES = HW.routes; // {코드: 노선명-방향}
const PTS = HW.points.map((p) => ({ route: p[0], pt: p[1], name: p[2], obs: p[3], type: p[4], lat: p[5], lon: p[6] }));
export const HW_POINT_COUNT = PTS.length;
const byRoute = new Map();
for (const p of PTS) {
  if (!byRoute.has(p.route)) byRoute.set(p.route, []);
  byRoute.get(p.route).push(p);
}
for (const arr of byRoute.values()) arr.sort((a, b) => Number(a.pt) - Number(b.pt));
const baseRoute = (nm) => String(nm).replace(/-(상행|하행)$/, "");

/** 노선 이름·코드 → 방향별 노선코드 목록 */
export function findRoutes(q) {
  if (!q) return [];
  const s = String(q).trim();
  if (/^\d{1,2}$/.test(s)) {
    const c = s.padStart(2, "0");
    return HW_ROUTES[c] ? [c] : [];
  }
  const k = squash(s.replace(/(고속도로|고속국도)$/, "").replace(/선$/, ""));
  const exact = Object.entries(HW_ROUTES).filter(([, nm]) => squash(nm).startsWith(k + "선") || squash(nm) === k);
  const loose = exact.length ? exact : Object.entries(HW_ROUTES).filter(([, nm]) => squash(nm).includes(k));
  return loose.map(([c]) => c);
}

export function routeList() {
  const m = new Map();
  for (const [c, nm] of Object.entries(HW_ROUTES)) {
    const b = baseRoute(nm);
    if (!m.has(b)) m.set(b, []);
    m.get(b).push({ 코드: c, 방향: nm.endsWith("상행") ? "상행" : "하행", 지점수: byRoute.get(c)?.length || 0, 시점: byRoute.get(c)?.[0]?.name, 종점: byRoute.get(c)?.at(-1)?.name });
  }
  return [...m.entries()].map(([노선, 방향]) => ({ 노선, 방향 }));
}

const pOut = (p) => ({ 노선: HW_ROUTES[p.route], 노선코드: p.route, 지점: p.name, 종류: p.type, 예보지점코드: p.pt, 실황지점코드: p.obs, 위도: p.lat, 경도: p.lon });

/** 지점 검색: 이름(공백 토큰 모두 포함), routeCodes로 노선 한정 */
export function findHighwayPoints(query, routeCodes = null, limit = 30) {
  const toks = String(query || "").split(/[\s,]+/).map(squash).filter(Boolean);
  const pool = PTS.filter((p) => !routeCodes || routeCodes.includes(p.route));
  // 지점명만으로 다 맞는 지점이 있으면 그것만(노선명에 든 지명 — 예 서울양양선의 '양양' — 때문에 노선 전 지점이 걸리지 않게)
  const byName = pool.filter((p) => toks.every((t) => squash(p.name).includes(t)));
  const hit = byName.length ? byName : pool.filter((p) => toks.every((t) => squash(p.name + HW_ROUTES[p.route]).includes(t)));
  // 이름이 정확히 같은 것 먼저
  const last = toks[toks.length - 1] || "";
  hit.sort((a, b) => (squash(b.name) === last) - (squash(a.name) === last) || (squash(b.name).startsWith(last)) - (squash(a.name).startsWith(last)));
  return { total: hit.length, rows: hit.slice(0, limit).map(pOut), raw: hit };
}

export function nearestHighwayPoints(lat, lon, n = 5, routeCodes = null) {
  return PTS.filter((p) => p.lat && (!routeCodes || routeCodes.includes(p.route)))
    .map((p) => ({ p, d: distKm(lat, lon, p.lat, p.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(({ p, d }) => ({ ...pOut(p), 거리km: Math.round(d * 10) / 10 }));
}

// ── 실황 ────────────────────────────────────────────────────────────────────
const FOG = { 1: "맑음", 2: "중상층운", 3: "알수없음", 4: "안개 확률 높음", 5: "안개", 6: "적설", 7: "사막" };
function obsRow(p) {
  const [tm, hway, type, name, lat, lon, rnOx, rn60, rnDay, rr, ltgOx, ltgDist, fog, vs, wd, ws, ta] = p;
  return {
    관측시각: fmt12(tm), 노선: hway, 종류: type, 지점: name, 위도: num(lat), 경도: num(lon),
    강수: num(rnOx) === 1 ? "있음" : num(rnOx) === 0 ? "없음" : null, 강수_60분mm: num(rn60), 일강수mm: num(rnDay), 강우강도mmh: num(rr),
    낙뢰: num(ltgOx) === 1 ? `최근 1시간 100km 이내 발생${num(ltgDist) ? ` (${num(ltgDist)}km)` : ""}` : num(ltgOx) === 0 ? "없음" : null,
    안개탐지: FOG[num(fog)] ?? null, 시정km: num(vs), 풍향deg: num(wd), 풍속ms: num(ws), 기온: num(ta),
  };
}

/** loc: 2·4·6자리 실황 코드 */
export async function highwayObs(loc, meter) {
  const l = String(loc || "").trim();
  if (!/^\d{2}(\d{2}(\d{2})?)?$/.test(l)) throw new UpstreamError(`실황 지점코드(loc)는 노선 2자리·노선+종류 4자리·전체 6자리입니다: "${loc}"`, "BAD_PARAM");
  const text = await hubGet(`/typ01/cgi-bin/url/nph-land_highway_weather_txt?loc=${l}&help=0&disp=1`, { source: "기상청 API허브 고속도로 날씨실황", meter, timeoutMs: 8000, tries: 4 });
  return csvRows(text).filter((p) => /^\d{12}$/.test(p[0])).map(obsRow);
}

// ── 예보 ────────────────────────────────────────────────────────────────────
/** 출발·도착 지점 이름 → {route, start, end} (방향 자동) */
export function resolveTrip({ route, from, to }) {
  const routes = route ? findRoutes(route) : Object.keys(HW_ROUTES);
  if (route && !routes.length) throw new UpstreamError(`노선을 찾지 못했습니다: "${route}". kma_find_code(kind=highway_route)로 노선을 확인하세요.`, "BAD_PARAM");
  const cands = [];
  for (const rc of routes) {
    const arr = byRoute.get(rc) || [];
    const f = findHighwayPoints(from, [rc], 50).raw;
    const t = findHighwayPoints(to, [rc], 50).raw;
    for (const a of f) for (const b of t) if (Number(a.pt) < Number(b.pt)) cands.push({ rc, a, b, span: Number(b.pt) - Number(a.pt), exact: (squash(a.name) === squash(from)) + (squash(b.name) === squash(to)), n: arr.length });
  }
  if (!cands.length) throw new UpstreamError(`"${from}" → "${to}" 순서로 지나는 노선·방향을 찾지 못했습니다${route ? `(노선 ${route})` : ""}. 지점명을 kma_find_code(kind=highway)로 확인하세요(예: 양재IC, 구서IC).`, "BAD_PARAM");
  cands.sort((x, y) => y.exact - x.exact || x.span - y.span);
  const c = cands[0];
  const alt = [...new Set(cands.slice(1).filter((x) => x.rc !== c.rc).map((x) => HW_ROUTES[x.rc]))].slice(0, 3);
  const same = cands.filter((x) => x.rc === c.rc);
  const altFrom = [...new Set(same.map((x) => x.a.name))].filter((n) => n !== c.a.name);
  const altTo = [...new Set(same.map((x) => x.b.name))].filter((n) => n !== c.b.name);
  return {
    route: c.rc, start: c.a, end: c.b,
    ...(alt.length ? { 다른노선후보: alt } : {}),
    ...(altFrom.length || altTo.length ? { 다른지점후보: { ...(altFrom.length ? { 출발: altFrom.slice(0, 5) } : {}), ...(altTo.length ? { 도착: altTo.slice(0, 5) } : {}), 안내: "지점명이 여러 곳에 맞았다 — 원한 곳이 아니면 정확한 지점명(IC·휴게소)을 주라" } } : {}),
  };
}

const pad = (n) => String(n).padStart(2, "0");
// 지점이 80여 곳이라 0인 강수·적설·낙뢰 칸과 좌표는 뺀다(값이 있을 때만 싣는다)
function fcRow(p) {
  const [tm, car, hway, name, lat, lon, sky, rn1, pty, pop, sno, vec, wsd, t1h, lgt] = p;
  const r = { 도착시각: fmt12(tm), 지점: name, 하늘: SKY_TXT[num(sky)] ?? null, 강수형태: PTY_TXT[num(pty)] ?? null, 강수확률: num(pop), 기온: num(t1h), 풍속ms: num(wsd), 풍향deg: num(vec) };
  if (num(rn1)) r.강수_1시간mm = num(rn1);
  if (num(sno)) r.신적설_1시간cm = num(sno);
  if (num(lgt)) r.낙뢰kA = num(lgt);
  return r;
}

export async function highwayForecast({ route, start, end, tm, car = "01" }, meter) {
  const now = nowKst();
  const hhmm = tm ? String(tm).replace(/\D/g, "").slice(-4).padStart(4, "0") : `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  if (!/^([01]\d|2[0-3])[0-5]\d$/.test(hhmm)) throw new UpstreamError(`출발시각 tm은 HHMM(오늘)입니다: "${tm}"`, "BAD_PARAM");
  const c = String(car || "01").padStart(2, "0");
  if (!["01", "02"].includes(c)) throw new UpstreamError("car는 01(승용차)·02(대형차)입니다.", "BAD_PARAM");
  const text = await hubGet(`/typ01/cgi-bin/url/nph-land_highway_shrt_txt?route=${route}&start=${start}&end=${end}&tm=${hhmm}&car=${c}&help=0&disp=1`, { source: "기상청 API허브 고속도로 단기예보", meter, timeoutMs: 8000, tries: 4 });
  return { 출발시각: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`, 차량: c === "01" ? "승용차" : "대형차", 행: csvRows(text).filter((p) => /^\d{12}$/.test(p[0])).map(fcRow) };
}

export function tripSummary(rows) {
  if (!rows.length) return null;
  // ★ 실측 2026-10-14: 출발시각·발표 갱신 시점에 따라 원천이 뒤쪽 지점(도착 약 3시간 반 이후) 또는 전 구간의 하늘·기온·바람을 nan으로 보낸다
  //   (17:20 출발 → 88지점 중 언양JCT 이후 17지점 nan, 17:0x 조회의 18:05 출발 → 전 구간 nan, 같은 경로 17:2x 조회의 18:20 출발은 전부 값 있음).
  //   강수확률만 남는 경우도 있다 → 하늘·기온이 모두 없는 행은 '값 없음'으로 따로 세고, 강수·기온 요약은 값 있는 지점만으로 낸다.
  const empty = rows.filter((r) => r.하늘 === null && r.기온 === null);
  const has = rows.filter((r) => !(r.하늘 === null && r.기온 === null));
  const temps = has.map((r) => r.기온).filter((x) => x !== null);
  const wet = has.filter((r) => r.강수형태 && r.강수형태 !== "없음");
  const thunder = has.filter((r) => r.낙뢰kA);
  const strong = has.filter((r) => (r.풍속ms ?? 0) >= 9);
  return {
    구간: `${rows[0].지점} ${rows[0].도착시각} → ${rows.at(-1).지점} ${rows.at(-1).도착시각}`,
    지점수: rows.length,
    값있는지점수: has.length,
    기온범위: temps.length ? `${Math.min(...temps)}~${Math.max(...temps)}℃` : null,
    강수지점: !has.length ? null : wet.length ? wet.slice(0, 15).map((r) => `${r.지점}(${r.도착시각.slice(11)} ${r.강수형태})`) : "값 있는 지점 중 없음",
    최대강수확률: Math.max(...rows.map((r) => r.강수확률 ?? 0)),
    ...(thunder.length ? { 낙뢰예상지점: thunder.slice(0, 10).map((r) => r.지점) } : {}),
    ...(strong.length ? { 강풍지점_9ms이상: strong.slice(0, 10).map((r) => `${r.지점}(${r.풍속ms}m/s)`) } : {}),
    ...(empty.length
      ? {
          값없음: {
            지점수: empty.length,
            구간: `${empty[0].지점}(${empty[0].도착시각.slice(11)}) ~ ${empty.at(-1).지점}(${empty.at(-1).도착시각.slice(11)})`,
            안내: empty.length === rows.length
              ? "원천이 이 출발시각의 하늘·기온·바람 값을 비워 보냈다(예보 갱신 시점에 생긴 것으로 보임) — 날씨를 '맑음'·'비 없음'으로 단정하지 말고 몇 분 뒤 다시 조회하거나 경유지 동네예보로 답하라"
              : "이 지점들은 원천 값이 비어 있다(도착시각이 예보 범위 끝을 넘은 것으로 보임) — 그 구간은 도착지 동네예보로 보완하라",
          },
        }
      : {}),
  };
}

// ★★ 실측 2026-10-14: 서울양양선(33·34)은 기상청 지점표의 지점명이 좌표와 맞지 않는다 — 좌표 순서는 서→동으로 자연스러운데
//   이름이 어긋나 있다(예: '남춘천IC' 좌표가 양양군 서면, '인제IC'가 춘천시 동산면). 실황·예보 응답의 좌표도 같다(원천 자료 문제).
export const NAME_MISMATCH_ROUTES = new Set(["33", "34"]);
export const NAME_MISMATCH_NOTE = "서울양양선은 기상청 지점표의 지점명이 실제 위치(좌표)와 어긋나 있다(예: '남춘천IC' 좌표가 양양군 서면) — 지점명보다 위도·경도로 위치를 판단하고, 지점별 수치를 특정 IC의 날씨로 단정하지 말라";
