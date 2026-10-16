// kma-weather-mcp — 기상청 날씨 MCP 서버
//
// 공공데이터포털로 활용신청·승인된 기상청 OpenAPI 6개 서비스와 기상청 API허브 계열(예보 우선 호스트·특보 이력·통보문·영향예보·고속도로·자외선 관측 등)을 도구로 묶는다.
//   단기예보(초단기실황·초단기예보·단기예보·예보버전) · 중기예보(전망·육상·기온·해상) ·
//   기상특보(10개 오퍼레이션) · 관광코스별 관광지 날씨(2) · CCTV 도로날씨(2) · 생활기상지수(자외선·대기정체)
// 저장소는 두지 않는다(매번 실시간 조회). 지역명→격자·코드 변환용 코드표만 서버에 내장한다(data/).
// 원천별 실측 함정은 lib/<모듈>.js 머리 주석에 있다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Meter, UpstreamError, scrub, envKey, normalizeDate, todayKst, addDays } from "./common.js";
import { SERVICES, hostMode } from "./kma.js";
import {
  toGrid, validGrid, findAreas, nearestArea, areaOut, getAreaByCode, midForArea, warnForArea,
  findMidRegions, midFromForecastCode, findWarnZones, findTourCourses, findTourCities, tourSpotsOfCourse, findCctv, cctvRoutes,
  AREA_COUNT, TOUR_COURSE_COUNT, TOUR_SPOT_COUNT, CCTV_COUNT,
} from "./geo.js";
import { getShort, getVersion, KIND_LABEL as SHORT_LABEL } from "./short.js";
import { getMidOutlook, getMidLand, getMidTemp, getMidSea, MID_STN } from "./mid.js";
import { getWarnings, WARN_KINDS, WARN_STN, WARN_TYPES } from "./warn.js";
import { getTourForecast, getTourClimateIndex, getRoadWeather, getLivingIndex } from "./extra.js";
import { fetchUvObs, latestUvObs, normUvTm, hourlyBack, UV_GUIDE, UV_STN_NAME, fetchUvStations, nearestUvStations } from "./uvobs.js";
import { fetchStations, nearestStations, findStations, STATION_KINDS } from "./stations.js";
import { warningEvents, warningStatusAt, weatherDocs, warningImage, WRN_CODE, STN_CODE as HUB_STN } from "./warnhub.js";
import { zoneByCoord } from "./awszone.js";
import { getSituation, getLandText, getSeaText, findMsgRegions, msgByExactName, isCityCode, nearestCityZone, situationStnForL1, SITUATION_STN, MSG_KIND } from "./fcstmsg.js";
import { impactStatus, impactCounts, impactMap, IFPAR, IFAREA, ILVL, IMPACT_STN } from "./impact.js";
import { HW_ROUTES, HW_POINT_COUNT, findRoutes, routeList, findHighwayPoints, nearestHighwayPoints, highwayObs, resolveTrip, highwayForecast, tripSummary, NAME_MISMATCH_ROUTES, NAME_MISMATCH_NOTE } from "./highway.js";
import { pastUltraForecast } from "./pointfcst.js";
import { forecastArchive, gridArchive } from "./archive.js";
import { decorateIcons } from "./icon.js";

export const SERVER_VERSION = "1.5.0";

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────
const ok = (obj) => {
  obj = decorateIcons(obj); // 날씨 필드가 있는 객체마다 `아이콘`(이모지)을 덧붙인다 — lib/icon.js
  let text = JSON.stringify(obj, null, 1);
  if (text.length > 100000) text = JSON.stringify(obj);
  return { content: [{ type: "text", text: scrub(text) }] };
};
const fail = (e, meter) => ({
  content: [
    {
      type: "text",
      text: scrub(`오류: ${e && e.message ? e.message : String(e)}`) + (e && e.code ? ` [${e.code}]` : "") + (meter ? `\n(이번 호출 원천 API 호출 수: ${meter.calls})` : ""),
    },
  ],
  isError: true,
});

/** MCP 클라이언트가 인자를 문자열로 직렬화해 보내는 경우가 있어 number/boolean은 관대하게 받는다 */
const numArg = () => z.union([z.number(), z.string()]).transform((v) => (v === "" ? undefined : Number(v))).optional();
const bool = (def = false) =>
  z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(def);
const str = () => z.union([z.string(), z.number()]).transform((v) => String(v).trim()).optional();

/** 지역명·좌표·격자 중 하나에서 위치를 확정한다 */
function resolveLocation({ place, lat, lon, nx, ny }) {
  if (nx !== undefined && ny !== undefined) {
    if (!validGrid(nx, ny)) throw new UpstreamError(`격자 범위를 벗어났습니다(nx 1~149, ny 1~253): nx=${nx}, ny=${ny}`, "BAD_PARAM");
    return { nx, ny, 방식: "격자 직접 지정" };
  }
  if (lat !== undefined && lon !== undefined) {
    if (!(lat >= 29 && lat <= 43 && lon >= 123 && lon <= 133)) throw new UpstreamError(`한반도 범위를 벗어난 좌표입니다(위도 29~43, 경도 123~133): lat=${lat}, lon=${lon}`, "BAD_PARAM");
    const g = toGrid(lat, lon);
    const near = nearestArea(lat, lon, 1)[0];
    return { ...g, 방식: "위경도→격자 변환", 가장가까운행정구역: near ? { 지역: near.full, 행정구역코드: near.code, 거리km: near.거리km } : null, area: near };
  }
  if (place) {
    const f = findAreas(place, 8);
    if (!f.total) throw new UpstreamError(`"${place}"에 맞는 행정구역이 없습니다. 시·군·구·동 이름을 줄이거나 kma_find_code(kind=location)로 찾아보세요.`, "BAD_PARAM");
    const r = f.rows[0];
    return {
      nx: r.nx, ny: r.ny, 방식: "지역명 검색", 선택된지역: r.full, 행정구역코드: r.code, area: r, ...(f.안내 ? { 해석안내: f.안내 } : {}),
      ...(f.total > 1 ? { 다른후보: f.rows.slice(1, 6).map((x) => x.full), 후보안내: `"${place}"에 ${f.total}곳이 일치해 가장 상위 단계를 골랐습니다. 다른 곳이면 더 구체적으로(예: 시·군·구+동) 주세요.` } : {}),
    };
  }
  throw new UpstreamError("위치가 필요합니다: place(지역명) 또는 lat+lon(위경도) 또는 nx+ny(격자) 중 하나를 주세요.", "BAD_PARAM");
}

const locArgs = {
  place: str().describe("지역명(예: 서울 강남구, 역삼1동, 춘천, 제주시). 행정구역(시도·시군구·읍면동) 이름의 일부를 공백으로 이어 주면 된다"),
  lat: numArg().describe("위도(도). lon과 함께 주면 격자로 변환한다"),
  lon: numArg().describe("경도(도)"),
  nx: numArg().describe("동네예보 격자 X(1~149). ny와 함께 주면 그대로 쓴다"),
  ny: numArg().describe("동네예보 격자 Y(1~253)"),
};

/**
 * 특보구역 추정(특보 이력·영향예보 공용).
 *  · lat+lon 또는 읍면동 단계 지역명 → AWS-특보구역 매칭(v2)으로 그 지점의 최하위 구역. 기간 시작·끝 시점의 구역을 모두 넣는다
 *    (구역 개편을 끼는 기간이면 옛·새 코드가 함께 들어간다).
 *  · 시도·시군구 단계 지역명 → 행정구역 이름 일치(시군구가 여러 구역으로 나뉘면 그 상위 구역 — 하위가 모두 맞춰진다).
 */
async function zonesForQuery({ place, lat, lon, from, to }, meter) {
  let area = null;
  if ((lat === undefined || lon === undefined) && place) {
    const f = findAreas(place, 3);
    if (!f.total) throw new UpstreamError(`"${place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
    area = f.rows[0];
  }
  const useCoord = lat !== undefined && lon !== undefined ? { lat, lon } : area && area.level === 3 ? { lat: area.lat, lon: area.lon } : null;
  if (useCoord) {
    const tms = [...new Set([from, to].filter(Boolean).map((t) => String(t).replace(/\D/g, "").slice(0, 8)))];
    const picks = [];
    for (const t of tms.length ? tms : [null]) {
      const z = await zoneByCoord(useCoord.lat, useCoord.lon, { tm: t ? t + "0900" : undefined, meter });
      if (z) picks.push({ 기준일: t || "현재", ...z });
    }
    if (picks.length) {
      const codes = [...new Set(picks.map((p) => p.구역.특보구역코드))];
      const uniq = codes.map((c) => {
        const ps = picks.filter((p) => p.구역.특보구역코드 === c);
        const p = ps[0];
        return { 기준일: ps.map((x) => x.기준일).join("·"), ...p.구역, 근거AWS: p.근거AWS, ...(p.이웃후보 ? { 이웃후보: p.이웃후보 } : {}) };
      });
      return { codes, note: { ...(area ? { 지역: area.full } : { 좌표: useCoord }), 방식: "좌표 → 가장 가까운 AWS의 특보구역(AWS-특보구역 매칭 v2, 기간 시작·끝 시점의 구역)", 추정특보구역: uniq, 추정: true, 안내: "이웃후보는 거리가 비슷한 다른 구역이다 — 경계 부근이면 area_code로 함께 조회하라" } };
    }
    if (!area) throw new UpstreamError(`좌표(${useCoord.lat}, ${useCoord.lon}) 25km 안에 AWS가 없어 특보구역을 정하지 못했습니다. area_code를 직접 주세요.`, "BAD_PARAM");
  }
  const zones = warnForArea(area).filter((w) => w.특보구역코드.startsWith("L"));
  if (!zones.length) throw new UpstreamError(`"${area.full}"의 특보구역을 추정하지 못했습니다. area_code를 직접 주세요(kma_find_code kind=warn_zone).`, "BAD_PARAM");
  const leaf = zones.filter((w) => w.상위구역 && !/L1000000/.test(w.상위구역));
  const use = leaf.length ? leaf : zones;
  return { codes: use.map((w) => w.특보구역코드), note: { 지역: area.full, 방식: "행정구역 이름 일치(시군구 구역 — 하위 구역 포함)", 추정특보구역: use.map((w) => `${w.구역명}(${w.특보구역코드})`), 추정: true, 안내: "읍면동까지 주거나 lat+lon을 주면 그 지점의 최하위 구역(예: 산지·평지 구분)으로 좁힌다" } };
}

/** 지역명 → 중기 육상(land)·기온(temp) 구역(이름 일치 + 가까운 지상관측소 배정으로 보완) */
async function resolveMidPlace(kind, place, meter) {
  const a = { kind, place };
  let id;
  let resolved;
  const f = findAreas(a.place, 3);
  if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
  const area = f.rows[0];
  const m = midForArea(area);
  let pick = a.kind === "land" ? m.육상예보 : m.중기기온;
  let basis = m.근거;
  // 가장 가까운 지상관측소의 예보구역코드(기상청 배정값) — 이름 일치가 실패하면 이것으로 보완, 성공해도 대조용으로 싣는다
  let ref = null;
  try {
    const { rows: st } = await fetchStations("SFC", { meter });
    const n = nearestStations(st, area.lat, area.lon, 1, (s) => !!midFromForecastCode(s.예보구역코드)?.[a.kind === "land" ? "육상예보" : "중기기온"])[0];
    if (n) {
      const mm = midFromForecastCode(n.예보구역코드);
      const cand = a.kind === "land" ? mm.육상예보 : mm.중기기온;
      ref = { 관측소: `${n.지점명}(${n.지점})`, 거리km: n.거리km, 배정구역: cand };
      if (!pick) {
        pick = cand;
        basis = `행정구역명으로는 구역을 찾지 못해, 가장 가까운 지상관측소 ${n.지점명}(${n.거리km}km)에 기상청이 배정한 예보구역을 썼다`;
      } else if (cand && cand.구역코드 !== pick.구역코드 && pick.일치 !== "시군구명") {
        ref.비고 = "이름 일치로 고른 구역과 다르다 — 지역 경계 부근이면 두 구역을 함께 보라";
      }
    }
  } catch (e) {
    ref = { 비고: `지상관측소 지점정보 조회 실패(${e.code || ""}) — 이름 일치 추정만 사용` };
  }
  if (!pick) throw new UpstreamError(`"${area.full}"에 맞는 중기${a.kind === "land" ? "육상" : "기온"} 구역을 찾지 못했습니다. kma_find_code(kind=mid_region)로 직접 고르세요.`, "BAD_PARAM");
  id = pick.구역코드;
  resolved = { 지역: area.full, 구역: pick, 추정: true, 근거: basis, ...(ref ? { 참고_가까운지상관측소: ref } : {}) };
  return { id, resolved };
}

/** 지역명·좌표 → 도시(C) 예보구역(동네예보 통보문·과거 단기 육상 공용) */
async function resolveCityPlace(a, meter) {
  let id;
  let resolved = null;
  let lat = a.lat, lon = a.lon, area = null;
  if (lat === undefined || lon === undefined) {
    if (!a.place) throw new UpstreamError("land에는 place·lat+lon·reg_id 중 하나가 필요합니다.", "BAD_PARAM");
    const f = findAreas(a.place, 3);
    if (f.total) {
      area = f.rows[0];
      lat = area.lat; lon = area.lon;
      const mf = midForArea(area);
      const m = mf.중기기온;
      if (m && m.일치 === "시군구명" && isCityCode(m.구역코드)) {
        id = m.구역코드;
        resolved = { 지역: area.full, 구역: `${m.구역명}(${id})`, 근거: "시군구 이름과 같은 도시 구역", 추정: true };
      } else if (area.level === 1) {
        // 시도 단계: 질의 끝 낱말과 같은 이름의 도시 구역(같은 육상 광역 안)을 먼저 — "서울", "제주", "부산"
        const tok = String(a.place).trim().split(/\s+/).pop();
        const pre = mf.육상예보?.구역코드?.slice(0, 3);
        const ex = msgByExactName(tok, ["C"]);
        const pick = (pre && ex.find((x) => x.code.startsWith(pre))) || (ex.length === 1 ? ex[0] : null);
        if (pick) {
          id = pick.code;
          resolved = { 지역: area.full, 구역: `${pick.name}(${id})`, 근거: "시도 이름과 같은 도시 구역", 추정: true };
        }
      }
    } else {
      const ex = msgByExactName(a.place, ["C"]);
      if (ex.length === 1) {
        id = ex[0].code;
        resolved = { 검색어: a.place, 구역: `${ex[0].name}(${id})`, 근거: "도시 구역명 일치" };
      } else throw new UpstreamError(`"${a.place}"에 맞는 행정구역·도시 구역이 없습니다.`, "BAD_PARAM");
    }
  }
  if (!id) {
    const near = await nearestCityZone(lat, lon, meter, 3);
    if (!near.length) throw new UpstreamError("가까운 도시 예보구역을 찾지 못했습니다(예보구역정보 조회 실패 가능).", "UPSTREAM");
    id = near[0].code;
    resolved = { ...(area ? { 지역: area.full } : { 좌표: { lat, lon } }), 구역: `${near[0].name}(${id})`, 거리km: near[0].거리km, 근거: "좌표에서 가장 가까운 도시 예보구역(API허브 예보구역정보 좌표)", 다른후보: near.slice(1).map((z) => `${z.name}(${z.code}, ${z.거리km}km)`), 추정: true,
      ...(area && area.level === 1 ? { 주의: "시도 단계 지역이라 시도 대표 좌표에서 가까운 도시를 골랐다 — 시군구까지 주면 정확해진다" } : {}) };
  }
  return { id, resolved };
}

// ── 서버 ─────────────────────────────────────────────────────────────────────
export function buildServer() {
  const server = new McpServer({ name: "kma-weather-mcp", version: SERVER_VERSION });

  // ── 1. 코드 찾기 ───────────────────────────────────────────────────────────
  server.registerTool(
    "kma_find_code",
    {
      title: "기상청 코드·구역 찾기",
      description:
        "지역명·좌표를 기상청 API가 요구하는 코드로 바꾼다(호출 비용 없음, 서버 내장 코드표). " +
        "kind=location: 지역명 또는 lat+lon → 동네예보 격자(nx,ny)·행정구역코드(생활기상지수 area_no)·추정 중기예보구역·추정 특보구역. " +
        "warn_zone: 특보구역코드(areaCode) 검색. mid_region: 중기예보 구역코드(육상 A·기온 C·해상 H) 검색. " +
        "tour_course: 관광코스ID(코스명·관광지명 검색, query가 숫자면 그 코스의 관광지 좌표까지). tour_city: 시군구ID(관광기후지수용). " +
        "cctv: 도로날씨 CCTV ID(노선·지점명 검색). cctv_routes: 노선별 지점 수. " +
        "station: 기상청 지상관측소(ASOS) — 지점번호·이름·주소 검색 또는 lat+lon·query(지역명)로 가까운 관측소, 지점마다 기상청이 배정한 예보구역코드(=중기기온 도시 코드)와 그 육상예보 구역. uv_station: 자외선 관측소. " +
        "aws_zone: lat+lon 또는 query(지역명)로 가장 가까운 AWS에 기상청이 배정한 특보구역·예보구역(API허브 AWS-특보구역 매칭 v2, 1회 호출·12시간 캐시) — tm을 주면 그 시점(구역 개편 전) 구역. " +
        "fcst_text_region: 동네예보 통보문 구역코드(도시 C — 육상예보, 해상 H·I — 해상예보, 기상개황 관서). " +
        "highway: 고속도로 지점(IC·JCT·휴게소·졸음쉼터 1,118곳) — query(지점명, 노선명 섞어도 됨) 또는 lat+lon·query+near=true로 가까운 지점. highway_route: 노선·방향별 코드와 시점·종점. " +
        "station·uv_station만 기상청 API허브 지점정보를 1회 호출한다(12시간 캐시). tm(YYYYMMDDHHMI)을 주면 그 시점의 관측소 구성. " +
        "★ kind=location의 중기예보 구역·특보구역은 행정구역 이름 일치로 추정한 값이라 '추정'으로 표시한다(기상청 공식 배정표 아님). 관측소의 예보구역코드는 기상청 배정값이지만 '그 관측소의' 배정이다.",
      inputSchema: {
        kind: z.enum(["location", "warn_zone", "aws_zone", "mid_region", "fcst_text_region", "tour_course", "tour_city", "cctv", "cctv_routes", "highway", "highway_route", "station", "uv_station"]).describe("찾을 대상"),
        query: str().describe("검색어(공백으로 여러 토큰 가능). location에서는 place 대신 써도 된다. station·uv_station에서는 지점번호·관측소명·주소, 또는 near=true와 함께 지역명"),
        lat: numArg().describe("kind=location·aws_zone·highway·station·uv_station에서 좌표로 찾을 때 위도"),
        lon: numArg().describe("좌표로 찾을 때 경도"),
        near: bool(false).describe("highway·station·uv_station에서 query를 지역명으로 보고 그 지역에서 가까운 지점을 찾는다"),
        tm: str().describe("station·uv_station: 관측소 구성 기준시각 / aws_zone: 구역 기준시각 YYYYMMDDHHMI(생략 시 현재)"),
        limit: numArg().describe("최대 건수(기본 20, 최대 100)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const limit = Math.min(Math.max(a.limit || 20, 1), 100);
        const q = a.query;
        let out;
        if (a.kind === "location") {
          if (a.lat !== undefined && a.lon !== undefined) {
            const g = toGrid(a.lat, a.lon);
            const near = nearestArea(a.lat, a.lon, 3);
            out = {
              입력: { lat: a.lat, lon: a.lon }, 격자: g,
              가까운행정구역: near.map((r) => ({ ...areaOut(r), 거리km: r.거리km, 중기예보구역_추정: midForArea(r), 특보구역_추정: warnForArea(r) })),
              안내: "격자는 기상청 표준 변환식으로 계산했고, 행정구역은 가까운 3단계(읍면동) 중심점 기준입니다.",
            };
          } else {
            if (!q) throw new UpstreamError("kind=location에는 query(지역명) 또는 lat+lon이 필요합니다.", "BAD_PARAM");
            const f = findAreas(q, limit);
            out = {
              검색어: q, 전체일치: f.total, 반환: f.rows.length,
              결과: f.rows.map((r) => ({ ...areaOut(r), ...(r.level <= 2 ? { 중기예보구역_추정: midForArea(r), 특보구역_추정: warnForArea(r) } : {}) })),
              ...(f.total > f.rows.length ? { 안내: "일치가 더 있습니다. 시·군·구+동처럼 구체적으로 좁히세요." } : {}),
            };
          }
        } else if (a.kind === "warn_zone") {
          const f = findWarnZones(q, limit);
          out = { 검색어: q ?? null, 전체일치: f.total, 반환: f.rows.length, 결과: f.rows, 안내: "areaCode는 kma_warnings(kind=area)의 area_code에 넣는다. 육상은 L으로, 해상(앞바다·먼바다)은 S로 시작한다." };
        } else if (a.kind === "mid_region") {
          const f = findMidRegions(q, limit);
          out = { 검색어: q ?? null, 전체일치: f.total, 반환: f.rows.length, 결과: f.rows, 안내: "kma_mid_forecast: 육상예보는 '육상예보(광역)' 코드, 기온은 '중기기온·도시' 코드, 해상은 '해상예보' 코드를 쓴다." };
        } else if (a.kind === "tour_course") {
          const f = findTourCourses(q, limit);
          out = { 검색어: q ?? null, 전체일치: f.total, 반환: f.rows.length, 결과: f.rows };
          if (q && /^\d+$/.test(q) && f.total === 1) {
            out.관광지상세 = tourSpotsOfCourse(q).map((s) => ({ 순서: s.order, 관광지: s.name, 관광지ID: s.spotId, 지역ID: s.areaId, 경도: s.lon, 위도: s.lat, 실내외: s.indoor, 테마: s.themeName, 이동시간분: s.moveMin }));
          }
        } else if (a.kind === "tour_city") {
          const f = findTourCities(q, limit);
          out = { 검색어: q ?? null, 전체일치: f.total, 반환: f.rows.length, 결과: f.rows };
        } else if (a.kind === "cctv") {
          const f = findCctv(q, limit);
          out = { 검색어: q ?? null, 전체일치: f.total, 반환: f.rows.length, 결과: f.rows };
        } else if (a.kind === "aws_zone") {
          let lat = a.lat, lon = a.lon, base = null;
          if (lat === undefined || lon === undefined) {
            if (!q) throw new UpstreamError("kind=aws_zone에는 lat+lon 또는 query(지역명)가 필요합니다.", "BAD_PARAM");
            const f = findAreas(q, 3);
            if (!f.total) throw new UpstreamError(`"${q}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            lat = f.rows[0].lat; lon = f.rows[0].lon; base = f.rows[0].full;
          }
          const zz = await zoneByCoord(lat, lon, { tm: a.tm, meter });
          if (!zz) throw new UpstreamError(`좌표(${lat}, ${lon}) 25km 안에 AWS가 없습니다.`, "NO_DATA");
          const mid = midFromForecastCode(zz.근거AWS.예보구역코드);
          return ok({ 기준: base || { lat, lon }, ...zz, 예보구역: { 코드: zz.근거AWS.예보구역코드, ...(mid ? { 중기기온구역: mid.중기기온, 육상예보구역: mid.육상예보 } : {}) },
            안내: "가장 가까운 AWS에 기상청이 배정한 구역이다(그 AWS의 배정). 거리와 이웃후보를 함께 밝힐 것.", 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "AWS-특보구역 매칭" }) });
        } else if (a.kind === "fcst_text_region") {
          const f = findMsgRegions(q, null, limit);
          out = { 검색어: q ?? null, 전체일치: f.total, 반환: f.rows.length, 결과: f.rows, 안내: "kma_forecast_text: land는 도시(육상예보) 코드, sea는 해상광역·해상국지 코드, situation은 기상개황 관서 코드를 쓴다. 육상광역·국지 코드는 육상예보 자료가 없다." };
        } else if (a.kind === "highway") {
          let lat = a.lat, lon = a.lon, base = null;
          if ((lat === undefined || lon === undefined) && a.near) {
            if (!q) throw new UpstreamError("near=true에는 query(지역명)가 필요합니다.", "BAD_PARAM");
            const f = findAreas(q, 3);
            if (!f.total) throw new UpstreamError(`"${q}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            lat = f.rows[0].lat; lon = f.rows[0].lon; base = f.rows[0].full;
          }
          if (lat !== undefined && lon !== undefined) {
            out = { 기준: base || { lat, lon }, 가까운지점: nearestHighwayPoints(lat, lon, Math.min(limit, 20)), 안내: "같은 지점이 상행·하행 노선에 따로 있다(노선코드가 방향별)." };
          } else {
            const f = findHighwayPoints(q, null, limit);
            out = { 검색어: q ?? null, 전체일치: f.total, 반환: f.rows.length, 결과: f.rows, 안내: "실황은 실황지점코드(6자리)·노선코드로, 경로 예보는 노선코드+예보지점코드로 부른다 — kma_highway_weather는 지점명으로 받아 알아서 바꾼다." };
          }
        } else if (a.kind === "highway_route") {
          out = { 노선: routeList(), 안내: "노선코드는 방향별이다. 예보지점코드는 그 방향의 진행 순서(시점=01)." };
        } else if (a.kind === "station" || a.kind === "uv_station") {
          const inf = a.kind === "station" ? "SFC" : "UV";
          const tm = a.tm ? String(a.tm).replace(/\D/g, "") : null;
          const { rows: st, cached } = await fetchStations(inf, { tm, meter });
          const view = (s) => {
            const mid = inf === "SFC" ? midFromForecastCode(s.예보구역코드) : null;
            return { ...s, ...(mid ? { 중기기온구역: mid.중기기온, 육상예보구역: mid.육상예보 } : {}) };
          };
          let base = null;
          let lat = a.lat, lon = a.lon;
          if ((lat === undefined || lon === undefined) && a.near) {
            if (!q) throw new UpstreamError("near=true에는 query(지역명)가 필요합니다.", "BAD_PARAM");
            const f = findAreas(q, 3);
            if (!f.total) throw new UpstreamError(`"${q}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            lat = f.rows[0].lat; lon = f.rows[0].lon; base = f.rows[0].full;
          }
          if (lat !== undefined && lon !== undefined) {
            const near = nearestStations(st, lat, lon, Math.min(limit, 10));
            out = { 종류: STATION_KINDS[inf], 기준: base || { lat, lon }, 관측소구성기준: tm || "현재", 전체지점수: st.length, 가까운관측소: near.map(view),
              안내: "거리km는 관측소까지의 직선거리다. 예보구역코드는 기상청이 그 관측소에 배정한 값이지 조회 지역의 배정이 아니므로 거리를 함께 밝힐 것." };
          } else {
            const f = findStations(st, q);
            out = { 종류: STATION_KINDS[inf], 검색어: q ?? null, 관측소구성기준: tm || "현재", 전체지점수: st.length, 전체일치: f.length, 반환: Math.min(f.length, limit), 결과: f.slice(0, limit).map(view),
              ...(q && !f.length ? { 안내: "관측소명·번호·주소에 일치가 없습니다. 지역에서 가까운 관측소를 찾으려면 near=true를 주세요." } : {}) };
          }
          return ok({ ...out, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "지점정보", 캐시: cached }) });
        } else {
          out = { 노선별: cctvRoutes() };
        }
        return ok({ ...out, 요약: meter.summary({ 비고: "내장 코드표 조회(원천 호출 없음)" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 2. 단기예보(실황·초단기·단기) ──────────────────────────────────────────
  server.registerTool(
    "kma_short_forecast",
    {
      title: "동네예보 (초단기실황·초단기예보·단기예보)",
      description:
        "기상청 동네예보를 지역명·위경도·격자 중 하나로 조회한다. " +
        "kind=now 초단기실황(지금 관측: 기온·강수·습도·풍향풍속·강수형태), kind=ultra 초단기예보(앞으로 6시간, 시간별), " +
        "kind=short 단기예보(최대 3일, 3일치 시간별 + 일별 요약: 최저·최고기온·강수확률·하늘상태). " +
        "발표시각은 지금(KST) 기준 제공 가능한 가장 최근 것을 자동 선택하고(실황 HH00·초단기 HH30·단기 02/05/08/11/14/17/20/23시, 각 +10분 이후 제공), 자료가 없으면 이전 발표로 물러서고(단기예보는 최대 6발표 전까지) 물러선 경우 메타.발표지연안내에 적는다. " +
        "결측(±900)은 null, 하늘상태·강수형태 코드는 해석을 덧붙인다. 강수량(PCP)·적설(SNO)은 '강수없음', '30~50mm' 같은 범주 문자열이다. " +
        "해상 격자는 값이 마스킹돼 null이다. 지역명이 여러 곳에 일치하면 상위 단계를 골라 다른 후보를 알려준다. " +
        "★ '그날 그 시각 예보가 어땠나'는 kind=ultra + base_date·base_time(과거)으로 묻는다 — 어제보다 앞이거나 격자 API에 없으면 API허브 지점 조회로 그 발표분의 6시간 예보를 받는다(place 또는 lat+lon 필요, 과거분은 강수확률·적설이 비어 있을 수 있음).",
      inputSchema: {
        kind: z.enum(["now", "ultra", "short"]).describe("now 초단기실황 / ultra 초단기예보 / short 단기예보"),
        ...locArgs,
        base_date: str().describe("발표일 YYYYMMDD(생략하면 자동). kind=ultra는 과거 발표분도 된다(어제보다 앞이면 API허브 지점 조회로 자동 전환, 2021년 자료도 나옴). now·short는 최근 발표분만"),
        base_time: str().describe("발표시각 HHMM(생략하면 자동). now는 HH00, ultra는 HH30, short는 0200·0500·…·2300"),
        date: str().describe("이 날짜(YYYYMMDD)의 시간별 자료만 남긴다(생략하면 전체)"),
        hours: numArg().describe("시간별 자료를 앞에서 이 개수까지만(생략하면 전체)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const loc = resolveLocation(a);
        const date = normalizeDate(a.date, "date");
        const base_date = normalizeDate(a.base_date, "base_date");
        const base_time = a.base_time ? String(a.base_time).replace(/\D/g, "").padStart(4, "0") : undefined;
        if ((base_date && !base_time) || (!base_date && base_time)) {
          // 한쪽만 주면 다른 쪽은 자동 선택값으로 채운다(getShort가 처리)
        }
        // 과거 초단기예보: 격자 API는 최근 발표분만 준다 → 어제보다 앞 발표일이거나 격자 API에 그 발표분이 없으면 지점 조회(API허브)로 받는다
        const pastTm = () => `${base_date}${(base_time || "0000").slice(0, 2)}`;
        const pastPoint = async (why) => {
          const ll = a.lat !== undefined && a.lon !== undefined ? { lat: a.lat, lon: a.lon } : loc.area ? { lat: loc.area.lat, lon: loc.area.lon } : null;
          if (!ll) throw new UpstreamError("과거 초단기예보(지점 조회)는 place 또는 lat+lon이 필요합니다(격자 nx·ny만으로는 안 됨).", "BAD_PARAM");
          const p = await pastUltraForecast({ lat: ll.lat, lon: ll.lon, tm: pastTm(), hours: a.hours || 6 }, meter);
          const { area, ...locOut } = loc;
          return ok({ 위치: { ...locOut, 지점조회좌표: ll }, ...p, 전환사유: why, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "단기예보데이터 지점 조회(과거 초단기예보)" }) });
        };
        if (a.kind === "ultra" && base_date && base_date < addDays(todayKst(), -1)) return await pastPoint("발표일이 어제보다 앞이라 격자 API 대신 지점 조회로 받았다");
        let r;
        try {
          r = await getShort(a.kind, { nx: loc.nx, ny: loc.ny, base_date: base_date || undefined, base_time }, meter);
        } catch (e) {
          if (a.kind === "ultra" && base_date && e.code === "NO_DATA") return await pastPoint("격자 API에 그 발표분이 없어(코드 03) 지점 조회로 받았다");
          throw e;
        }
        let hourly = r.시간별;
        let note;
        if (hourly) {
          if (date) hourly = hourly.filter((h) => h.일자.replace(/-/g, "") === date);
          if (a.hours) hourly = hourly.slice(0, a.hours);
          if (date && !hourly.length) note = `발표분에 ${date} 자료가 없습니다(단기예보는 발표일 포함 약 3일치).`;
        }
        const { area, ...locOut } = loc;
        return ok({
          위치: locOut, ...r, ...(hourly ? { 시간별: hourly } : {}), ...(note ? { 안내: note } : {}),
          요약: meter.summary({ 기관: "기상청", 서비스: `단기예보 ${SHORT_LABEL[a.kind]}` }),
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 3. 예보버전 ────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_forecast_version",
    {
      title: "동네예보 예보버전 조회",
      description:
        "동네예보 파일의 발표 버전(실제 생성 시각)을 확인한다. ftype ODAM 초단기실황·VSRT 초단기예보·SHRT 단기예보, basedatetime은 12자리 YYYYMMDDHHMM. " +
        "★ version이 19700101090000(에포크)이면 그 발표분이 기상청 피드에 없다는 뜻이다(2026-10-14 실측: 당일 0500·0800 단기예보 발표분이 이 값이었다).",
      inputSchema: {
        ftype: z.enum(["ODAM", "VSRT", "SHRT"]).describe("ODAM 초단기실황 / VSRT 초단기예보 / SHRT 단기예보"),
        basedatetime: str().describe("기준 시각 12자리 YYYYMMDDHHMM(예: 202610140800)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const r = await getVersion(a.ftype, a.basedatetime, meter);
        return ok({ ...r, 요약: meter.summary({ 기관: "기상청" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 4. 중기예보 ────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_mid_forecast",
    {
      title: "중기예보 (전망·육상·기온·해상)",
      description:
        "기상청 중기예보(발표일 기준 3~10일 후)를 조회한다. 발표는 06시·18시이며 최근 24시간분만 제공한다 — tm_fc를 생략하면 가장 최근 발표시각을 쓰고 자료가 없으면 한 발표 이전으로 물러선다. " +
        "kind=outlook 중기전망 텍스트(id=stnId: 108 전국·109 서울인천경기·105 강원·131 충북·133 대전세종충남·146 전북·156 광주전남·143 대구경북·159 부산울산경남·184 제주), " +
        "land 육상예보(날씨·강수확률, id=광역 구역코드 예 11B00000), temp 기온예보(최저·최고, id=도시 구역코드 예 11B10101 서울), sea 해상예보(파고·날씨, id=해상구역코드). " +
        "id 대신 place(지역명)를 주면 행정구역으로 추정한 구역을 쓰고 '추정'이라고 표시한다 — 이름으로 못 찾으면 가장 가까운 지상관측소에 기상청이 배정한 예보구역으로 보완하고, 대조용으로 그 관측소·거리를 함께 싣는다(API허브 지점정보 1회, 12시간 캐시). 구역코드는 kma_find_code(kind=mid_region·station)로 찾는다. " +
        "6시 발표는 4일 후부터, 18시 발표는 5일 후부터 값이 채워진다(앞 일자는 빈 값).",
      inputSchema: {
        kind: z.enum(["outlook", "land", "temp", "sea"]).describe("outlook 전망문 / land 육상 / temp 기온 / sea 해상"),
        id: str().describe("outlook은 stnId, 나머지는 regId(구역코드)"),
        place: str().describe("id 대신 지역명(land·temp에서만): 행정구역으로 구역을 추정한다"),
        tm_fc: str().describe("발표시각 YYYYMMDDHHMM(시각은 0600 또는 1800). 생략하면 자동"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let id = a.id;
        let resolved;
        if (!id && a.place) {
          if (a.kind === "outlook" || a.kind === "sea") throw new UpstreamError("place는 land·temp에서만 쓸 수 있습니다. outlook은 stnId, sea는 해상 구역코드를 id로 주세요.", "BAD_PARAM");
          ({ id, resolved } = await resolveMidPlace(a.kind, a.place, meter));
        }
        if (!id) throw new UpstreamError("id(stnId 또는 regId) 또는 place가 필요합니다.", "BAD_PARAM");
        const fn = { outlook: getMidOutlook, land: getMidLand, temp: getMidTemp, sea: getMidSea }[a.kind];
        const r = await fn(id, a.tm_fc, meter);
        return ok({ ...(resolved ? { 구역해석: resolved } : {}), ...r, 요약: meter.summary({ 기관: "기상청", 서비스: "중기예보" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5. 기상특보 ────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_warnings",
    {
      title: "기상특보·예비특보·기상정보·기상속보",
      description:
        "기상청 기상특보 서비스 10개 오퍼레이션을 kind로 고른다. " +
        "status: 최근 7일 특보·예비특보 현황(인자 없음) — '지금 어떤 특보가 나와 있나'의 출발점. " +
        "area: 특보구역(area_code, 예 L1010000 경기도)·종류(warning_type)·기간으로 발효 특보. " +
        "warning_list/warning: 특보 목록/통보문, preliminary_list/preliminary: 예비특보 목록/본문, info_list/info: 기상정보 목록/본문, breaking_list/breaking: 기상속보 목록/본문. " +
        "조회 기간: area는 오늘 기준 60일 전까지, 나머지 목록·본문 8종은 오늘 기준 6일 전까지만 조회된다(기상청 원천 제한 — 서버가 미리 막고 안내한다). 그보다 앞 이력·특정 과거 시각의 발효 현황은 kma_warning_history(API허브)를 쓴다. 본문 조회(warning·preliminary·info·breaking)는 stn_id가 필수다. 날짜(from·to)를 생략하면 오늘이다. " +
        "stn_id: 108 전국·109 서울인천경기·159 부산울산경남·143 대구경북·156 광주전남·146 전북·133 대전세종충남·131 충북·105 강원·184 제주. " +
        `warning_type: ${Object.entries(WARN_TYPES).map(([c, n]) => `${c} ${n}`).join("·")}. ` +
        "특보강도 0 주의보·1 경보·2 중대경보, 발표구분 1 발표·2 해제·3 연장·6 정정·7 변경발표·8 변경해제는 해석을 덧붙인다. " +
        "응답 필드는 오퍼레이션마다 달라 원본 필드명 그대로 돌려준다(t1~t7 본문, tmFc 발표시각, tmSeq 발표번호, tmEf 발효시각). " +
        "0건은 특보가 없던 기간이면 정상이므로, 날짜 형식(YYYYMMDD)·코드를 확인한 뒤에 '없음'으로 판단한다.",
      inputSchema: {
        kind: z.enum(Object.keys(WARN_KINDS)).describe("조회 종류"),
        stn_id: str().describe("지점코드(위 목록). 본문 조회는 필수"),
        from: str().describe("발표 시작일 YYYYMMDD 또는 YYYY-MM-DD(생략 시 오늘)"),
        to: str().describe("발표 종료일(생략 시 from과 같음)"),
        area_code: str().describe("kind=area에서 특보구역코드(kma_find_code kind=warn_zone으로 찾기)"),
        warning_type: str().describe("kind=area에서 특보종류 코드(1~9·12·13)"),
        rows: numArg().describe("가져올 최대 건수(기본 300, 최대 1000)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const r = await getWarnings(a.kind, { stnId: a.stn_id, from: a.from, to: a.to, areaCode: a.area_code, warningType: a.warning_type, rows: a.rows }, meter);
        return ok({ ...r, 요약: meter.summary({ 기관: "기상청", 서비스: "기상특보" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5-1. 특보 이력·과거 현황·문서(API허브) ─────────────────────────────────
  server.registerTool(
    "kma_warning_history",
    {
      title: "특보 발표·해제 이력, 과거 시각 특보현황, 기상정보·날씨해설 문서 (API허브, 기간 지정)",
      description:
        "기상청 API허브 특보 계열을 기간을 직접 지정해 조회한다 — kma_warnings(공공데이터포털)의 60일·6일 조회 제한이 없다(2015년 자료도 나옴). " +
        "kind=events: 특보 발표·해제·대치·연장 이력(특보구역 단위 행). from(필수)·to, wrn(특보종류: 강풍·호우·한파·건조·폭풍해일·지진해일·풍랑·태풍·대설·황사·폭염·안개·열대야 또는 W·R·C·D·O·N·V·T·S·Y·H·F·K, 여러 개는 쉼표), " +
        "area_code(특보구역코드 — 그 하위 구역 포함) 또는 place(지역명 → 추정 특보구역)·lat+lon(좌표 → AWS-특보구역 매칭으로 그 시점의 최하위 구역), level(예비·주의보·경보·중대경보), command(발표·해제 등). 한 번에 종류 미지정 92일·종류 지정 366일까지. " +
        "발표요약(종류×수준별 발표 행수·구역수·첫/마지막 발표)은 전체 기준, 목록은 limit(기본 100, 최대 500)까지. " +
        "kind=status_at: tm(YYYYMMDDHHMI) 시각에 발효 중이던 특보·예비특보 현황(생략 시 지금). " +
        "kind=info: 기상정보 문서, kind=commentary: 날씨해설 문서(subcd 11 초단기·12 단기·13 중기·99) — from·to(31일까지), stn(108 본청·109 수도권·105 강원·131 청주·133 대전·146 전주·156 광주·143 대구·159 부산·184 제주), query(본문 검색), max_chars(문서당, 기본 1500, 0=전문). " +
        "★ 특보구역은 2026-05-31에 개편됐다 — 옛 구역코드도 폐지 구역으로 이름을 붙여 돌려주고, area_code는 상위 구역 사슬로 옛 하위 구역까지 맞춘다. 행은 구역 단위라 '발표 1회 = 여러 행'이다.",
      inputSchema: {
        kind: z.enum(["events", "status_at", "info", "commentary"]).describe("events 발표·해제 이력 / status_at 특정 시각 특보현황 / info 기상정보 문서 / commentary 날씨해설 문서"),
        from: str().describe("시작 YYYYMMDD 또는 YYYYMMDDHHMI(events는 필수, 문서는 생략 시 오늘)"),
        to: str().describe("끝 YYYYMMDD 또는 YYYYMMDDHHMI(생략 시 지금)"),
        wrn: str().describe("events: 특보종류(예 대설, S, '대설,강풍')"),
        area_code: str().describe("events: 특보구역코드(쉼표로 여러 개, 하위 구역 포함). kma_find_code(kind=warn_zone)로 찾는다"),
        place: str().describe("events: 지역명 → 추정 특보구역. 시군구까지는 이름 일치(하위 구역 포함), 읍면동까지 주면 그 지점의 최하위 구역"),
        lat: numArg().describe("events: 위도 — lon과 함께 주면 가장 가까운 AWS의 특보구역(그 시점 구역)"),
        lon: numArg().describe("events: 경도"),
        level: str().describe("events: 예비·주의보·경보·중대경보(쉼표로 여러 개)"),
        command: str().describe("events: 발표·해제·대치·연장·변경(쉼표로 여러 개). 생략 시 전부"),
        order: z.enum(["desc", "asc"]).optional().describe("events 목록 정렬(기본 desc 최신순)"),
        tm: str().describe("status_at: 기준시각 YYYYMMDDHHMI(생략 시 지금)"),
        fe: z.enum(["f", "e"]).optional().describe("status_at: f 발표시각 기준(기본) / e 발효시각 기준"),
        stn: str().describe("info·commentary: 발표관서"),
        subcd: str().describe("commentary: 11 초단기·12 단기·13 중기·99 직접입력"),
        query: str().describe("info·commentary: 제목·본문 검색어"),
        limit: numArg().describe("events·status_at 목록 최대 행(기본 100, 최대 500) / 문서 최대 건(기본 10, 최대 50)"),
        max_chars: numArg().describe("문서 본문 최대 글자(기본 1500, 0=전문)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let r;
        if (a.kind === "events") {
          let areaCodes = a.area_code ? String(a.area_code).split(/[\s,]+/).filter(Boolean) : [];
          let placeNote = null;
          if (!areaCodes.length && (a.place || (a.lat !== undefined && a.lon !== undefined))) {
            const z = await zonesForQuery({ place: a.place, lat: a.lat, lon: a.lon, from: a.from, to: a.to || todayKst() }, meter);
            areaCodes = z.codes;
            placeNote = z.note;
          }
          const LV = { 예비: "1", 예비특보: "1", 주의보: "2", 주의: "2", 경보: "3", 중대경보: "4" };
          const CM = { 발표: "1", 대치: "2", 해제: "3", 대치해제: "4", 연장: "5", 변경: "6", 변경해제: "7" };
          const pick = (v, map, nm) => (v ? String(v).split(/[\s,]+/).filter(Boolean).map((x) => { if (/^\d$/.test(x)) return x; if (!map[x]) throw new UpstreamError(`${nm}을 알 수 없습니다: "${x}" (${Object.keys(map).join("·")})`, "BAD_PARAM"); return map[x]; }) : []);
          r = await warningEvents({ from: a.from, to: a.to, wrn: a.wrn, areaCodes, levels: pick(a.level, LV, "level"), commands: pick(a.command, CM, "command"), limit: a.limit, order: a.order }, meter);
          if (placeNote) r = { 구역해석: placeNote, ...r };
        } else if (a.kind === "status_at") {
          r = await warningStatusAt({ tm: a.tm, fe: a.fe, limit: a.limit }, meter);
        } else {
          r = await weatherDocs({ kind: a.kind, from: a.from, to: a.to, stn: a.stn, subcd: a.subcd, query: a.query, limit: a.limit, maxChars: a.max_chars ?? 1500 }, meter);
        }
        return ok({ ...r, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "특보·정보" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5-2. 특보 이미지 ───────────────────────────────────────────────────────
  server.registerTool(
    "kma_warning_map",
    {
      title: "특보 발표·발효 현황 지도 이미지 (API허브)",
      description:
        "기상청 특보 현황 지도를 PNG 이미지로 돌려준다. 중심(place 또는 lat+lon)과 반경(range, km, 기본 300), 또는 지방청(stn: 108 본청·133 대전·159 부산·156 광주·184 제주·105 강원). " +
        "tm(YYYYMMDDHHMI)으로 과거 시각도 그린다(생략 시 지금). wrn으로 특보종류를 고른다(생략 시 지진해일·안개·열대야를 뺀 10종). tmef 1 발효시각 기준(기본)·0 발표시각 기준. " +
        "이미지는 그림이므로 구역·종류를 글로 답할 때는 kma_warnings(status) 또는 kma_warning_history(status_at)를 함께 쓴다.",
      inputSchema: {
        place: str().describe("지도 중심 지역명"),
        lat: numArg().describe("중심 위도"),
        lon: numArg().describe("중심 경도"),
        range: numArg().describe("표출 반경 km(기본 300, 20~1000)"),
        stn: str().describe("지방청별 지도(108·133·159·156·184·105) — 주면 중심·반경 대신"),
        tm: str().describe("시각 YYYYMMDDHHMI(생략 시 지금)"),
        wrn: str().describe("특보종류(예 '호우,강풍')"),
        tmef: numArg().describe("1 발효시각 기준(기본) / 0 발표시각 기준"),
        size: numArg().describe("이미지 크기 px(기본 685, 200~1000)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let lat = a.lat, lon = a.lon, center = null;
        if (a.place && (lat === undefined || lon === undefined)) {
          const f = findAreas(a.place, 3);
          if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
          lat = f.rows[0].lat; lon = f.rows[0].lon; center = f.rows[0].full;
        }
        if (a.stn && !["108", "133", "159", "156", "184", "105"].includes(String(a.stn))) throw new UpstreamError("stn은 108·133·159·156·184·105 중 하나입니다.", "BAD_PARAM");
        const img = await warningImage({ tm: a.tm, lat, lon, range: a.range, size: a.size, tmef: a.tmef, wrn: a.wrn, stn: a.stn }, meter);
        const meta = { 기준시각: img.tm, ...(a.stn ? { 지방청: a.stn } : { 중심: center || { lat: lat ?? 36.1, lon: lon ?? 127.7 }, 반경km: a.range || 300 }), 크기바이트: img.bytes, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "특보이미지" }) };
        return { content: [{ type: "image", data: img.base64, mimeType: img.mimeType }, { type: "text", text: scrub(JSON.stringify(meta, null, 1)) }] };
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5-3. 동네예보 통보문(API허브) ───────────────────────────────────────────
  server.registerTool(
    "kma_forecast_text",
    {
      title: "동네예보 통보문 — 기상개황 문장·도시별 반나절 예보·해상예보 (API허브)",
      description:
        "기상청이 사람이 읽도록 낸 동네예보 통보문을 돌려준다(발표 05·11·17시). " +
        "kind=land: 도시 구역의 반나절(오전·오후) 예보 — 날씨·강수확률·최저(오전 칸)·최고(오후 칸)기온·바람, 오늘부터 글피(17시 발표는 그글피)까지. '춘천 내일 날씨', '이번 주말 부산 날씨'처럼 묻는 질문에 맞다(시간별 격자 자료는 kma_short_forecast). " +
        "place(지역명)·lat+lon·reg_id(도시 구역코드) 중 하나 — place는 시군구 이름이 도시 구역과 같으면 그것을, 아니면 가장 가까운 도시 구역을 고르고 '추정'으로 표시한다. " +
        "kind=situation: 관서별 기상개황 문장(오늘·내일·모레 해설, 예상 강수량 등) — stn(108 전국·109 서울인천경기·105 강원·131 충북·133 대전세종충남·146 전북·156 광주전남·143 대구경북·159 부산울산경남·184 제주) 또는 place(시도로 관서 선택), 생략 시 108. " +
        "kind=sea: 해상 구역의 반나절 예보 — 바람·풍속·파고 범위. reg_id 또는 place(해상 구역명, 예 서해중부앞바다). " +
        "★ 육상예보는 도시 구역코드만 자료가 있다(광역·국지 코드는 0건). 3일 이후~10일은 kma_mid_forecast(같은 도시 구역코드 체계)로 잇는다. 기상개황의 특보 칸은 안내문이라 특보 본문은 kma_warnings로 본다.",
      inputSchema: {
        kind: z.enum(["land", "situation", "sea"]).describe("land 도시 반나절 예보 / situation 기상개황 문장 / sea 해상예보"),
        place: str().describe("지역명(land·situation) 또는 해상 구역명(sea)"),
        lat: numArg().describe("land: 위도(가장 가까운 도시 구역)"),
        lon: numArg().describe("land: 경도"),
        reg_id: str().describe("land·sea 구역코드(kma_find_code kind=fcst_text_region)"),
        stn: str().describe("situation 관서 코드"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let r;
        let resolved = null;
        if (a.kind === "situation") {
          let stn = a.stn;
          if (!stn && a.place) {
            const f = findAreas(a.place, 3);
            if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            stn = situationStnForL1(f.rows[0].l1) || "108";
            resolved = { 지역: f.rows[0].full, 관서: `${SITUATION_STN[stn]}(${stn})` };
          }
          r = await getSituation(stn || "108", meter);
        } else if (a.kind === "sea") {
          let id = a.reg_id;
          if (!id) {
            if (!a.place) throw new UpstreamError("sea에는 reg_id 또는 place(해상 구역명)가 필요합니다.", "BAD_PARAM");
            const ex = msgByExactName(a.place, ["H", "I"]);
            const f = ex.length ? { rows: ex.map((x) => ({ 코드: x.code, 지역: x.name })) } : findMsgRegions(a.place, ["H", "I"], 5);
            if (!f.rows.length) throw new UpstreamError(`"${a.place}"에 맞는 해상 구역이 없습니다. kma_find_code(kind=fcst_text_region)로 찾으세요.`, "BAD_PARAM");
            id = f.rows[0].코드;
            resolved = { 검색어: a.place, 구역: `${f.rows[0].지역}(${id})`, ...(f.rows.length > 1 ? { 다른후보: f.rows.slice(1).map((x) => `${x.지역}(${x.코드})`) } : {}) };
          }
          r = await getSeaText(id, meter);
        } else {
          let id = a.reg_id;
          if (!id) ({ id, resolved } = await resolveCityPlace(a, meter));
          r = await getLandText(id, meter);
        }
        return ok({ ...(resolved ? { 구역해석: resolved } : {}), ...r, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "동네예보 통보문" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5-3b. 과거 예보 발표분(API허브) ─────────────────────────────────────────
  server.registerTool(
    "kma_forecast_archive",
    {
      title: "과거 예보 발표분 — 그때 기상청이 어떻게 예보했나 (단기·중기·격자, API허브)",
      description:
        "기상청이 과거에 발표한 예보를 그대로 돌려준다(단기 육상 2010년·중기 2015년 발표분도 나옴). '지난주 월요일 예보에서 수요일 비라고 했나', '8월 5일 날씨를 언제부터 어떻게 예보했나'에 쓴다. " +
        "kind=short_land 단기 육상(도시 구역 반나절: 날씨·강수확률·최저/최고·체감온도·바람), short_sea 단기 해상(바람·풍속·파고), short_text 단기 개황 문장, " +
        "mid_land 중기 육상(날씨·강수확률), mid_temp 중기 기온(최저·최고), mid_sea 중기 해상(파고), mid_text 중기 전망 문장, grid 격자 단기예보(지점의 시각별 값 — 2021-07 이후). " +
        "기간: from·to = 발표일(YYYYMMDD 또는 YYYYMMDDHH, 표는 단기 62일·중기 92일·문장 31일까지). target_date(YYYYMMDD)를 주면 그 하루에 대한 예보를 발표 순서대로 묶은 '발표별변화'를 준다(from을 생략하면 단기 4일 전·중기 11일 전부터 자동). " +
        "구역: place(지역명) 또는 reg_id — short_land는 도시 구역(통보문과 같은 코드), mid_land는 광역 구역, mid_temp는 도시 구역, 해상은 해상 구역. 문장(short_text·mid_text)은 stn 또는 place(시도로 관서 선택). " +
        "grid: place 또는 lat+lon, tmfc(발표시각 YYYYMMDDHH, 02·05·08·11·14·17·20·23시), times(예보시각 YYYYMMDDHH 쉼표로), vars(TMP·POP·PTY·SKY·PCP·SNO·REH·WSD·VEC·TMN·TMX·WAV, 쉼표) — (시각×요소) 8장까지. " +
        "★ 예보관 이름·ID는 원천에 있으나 서버가 뺀다. 구역코드는 개편될 수 있어 아주 오래된 기간은 그 시점 코드가 다를 수 있다.",
      inputSchema: {
        kind: z.enum(["short_land", "short_sea", "short_text", "mid_land", "mid_temp", "mid_sea", "mid_text", "grid"]).describe("조회 종류"),
        place: str().describe("지역명(육상·기온·문장·grid) 또는 해상 구역명(해상)"),
        lat: numArg().describe("short_land·grid: 위도"),
        lon: numArg().describe("short_land·grid: 경도"),
        reg_id: str().describe("구역코드(kma_find_code kind=fcst_text_region·mid_region)"),
        stn: str().describe("문장(short_text·mid_text) 관서 코드"),
        from: str().describe("발표 시작일 YYYYMMDD[HH]"),
        to: str().describe("발표 끝일 YYYYMMDD[HH](생략 시 from 하루)"),
        target_date: str().describe("예보 대상일 YYYYMMDD — 발표별 변화를 본다"),
        tmfc: str().describe("grid: 발표시각 YYYYMMDDHH"),
        times: str().describe("grid: 예보시각 YYYYMMDDHH(쉼표로 1~8개)"),
        vars: str().describe("grid: 요소(기본 TMP, 쉼표로 여러 개)"),
        limit: numArg().describe("표 최대 행(기본 100, 최대 500) / 문장 최대 건(기본 10, 최대 50)"),
        max_chars: numArg().describe("문장 본문 최대 글자(기본 1500, 0=전문)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let resolved = null;
        if (a.kind === "grid") {
          let lat = a.lat, lon = a.lon, nm = null;
          if (lat === undefined || lon === undefined) {
            if (!a.place) throw new UpstreamError("grid에는 place 또는 lat+lon이 필요합니다.", "BAD_PARAM");
            const f = findAreas(a.place, 3);
            if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            lat = f.rows[0].lat; lon = f.rows[0].lon; nm = f.rows[0].full;
            if (f.안내) resolved = { 해석안내: f.안내 };
          }
          const g = toGrid(lat, lon);
          const r = await gridArchive({ nx: g.nx, ny: g.ny, tmfc: a.tmfc, times: a.times, vars: a.vars }, meter);
          return ok({ 위치: { ...(nm ? { 지역: nm } : { lat, lon }), ...(resolved || {}) }, ...r, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "과거 예보(격자)" }) });
        }
        let reg = a.reg_id;
        let stn = a.stn;
        if (a.kind === "short_land" && !reg && (a.place || (a.lat !== undefined && a.lon !== undefined))) ({ id: reg, resolved } = await resolveCityPlace(a, meter));
        else if ((a.kind === "mid_land" || a.kind === "mid_temp") && !reg && a.place) ({ id: reg, resolved } = await resolveMidPlace(a.kind === "mid_land" ? "land" : "temp", a.place, meter));
        else if ((a.kind === "short_sea" || a.kind === "mid_sea") && !reg && a.place) {
          const pool = a.kind === "short_sea" ? findMsgRegions(a.place, ["H", "I"], 5).rows.map((x) => ({ code: x.코드, name: x.지역 })) : findMidRegions(a.place, 10).rows.filter((x) => x.용도 === "해상예보").map((x) => ({ code: x.구역코드, name: x.구역명 }));
          if (!pool.length) throw new UpstreamError(`"${a.place}"에 맞는 해상 구역이 없습니다. kma_find_code로 찾으세요.`, "BAD_PARAM");
          reg = pool[0].code;
          resolved = { 검색어: a.place, 구역: `${pool[0].name}(${reg})`, ...(pool.length > 1 ? { 다른후보: pool.slice(1).map((x) => `${x.name}(${x.code})`) } : {}) };
        } else if ((a.kind === "short_text" || a.kind === "mid_text") && !stn && a.place) {
          const f = findAreas(a.place, 3);
          if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
          stn = situationStnForL1(f.rows[0].l1) || "108";
          resolved = { 지역: f.rows[0].full, 관서: `${SITUATION_STN[stn] || stn}(${stn})` };
        }
        const r = await forecastArchive({ kind: a.kind, reg, stn, from: a.from, to: a.to, target: a.target_date, limit: a.limit, maxChars: a.max_chars ?? 1500 }, meter);
        return ok({ ...(resolved ? { 구역해석: resolved } : {}), ...r, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "과거 예보 발표분" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5-4. 영향예보(API허브) ──────────────────────────────────────────────────
  server.registerTool(
    "kma_impact_forecast",
    {
      title: "폭염·한파 영향예보 — 특보구역·분야별 위험수준 (API허브)",
      description:
        "기상청 영향예보(폭염 hw·한파 cw)를 조회한다 — 특보구역마다 분야(보건·산업·농업 등)별 위험수준 0 영향없음·1 관심·2 주의·3 경고·4 위험. 매일 11:30 발표, 내일·모레 2일. 특보(주의보·경보)와는 별개 정보다. " +
        "kind=status: 발표현황 — 위험수준요약(요소×분야×수준별 행수·구역수), 구역별최고수준, 목록(min_level 이상, 기본 1 관심). from·to(YYYYMMDD, 생략 시 오늘, 366일까지), basis(tmfc 발표일 기준·tmef 기준일 기준), " +
        "ifpar(hw·cw·폭염·한파, 생략 시 발효 중 전부), ifarea(폭염 0 모든 분야·1 보건 일반인·2 보건 취약인·3 산업·4 축산업·5 농업·6 수산양식·7 기타 / 한파 0 모든·1 보건·2 산업·3 시설물·4 농축산업·5 수산양식·6 기타, 생략 시 1), " +
        "ef_sn(1 내일·2 모레·3 둘 다, 기본 1), stn(관서), area_code·place·lat+lon(구역 한정 — 옛 구역코드까지 맞춤). " +
        "kind=counts: 관서×분야×수준별 발표지역 수와 구역 목록. kind=map: 위험수준 분포도 PNG(tmfc 발표일, 생략 시 오늘). " +
        "★ 2019년 자료부터 나온다. 1년 폭염(분야 1)은 약 16,000행이라 요약 위주로 쓰고, 분야 0(모든 분야)은 행이 몇 배로 늘어난다.",
      inputSchema: {
        kind: z.enum(["status", "counts", "map"]).describe("status 발표현황 요약 / counts 위험수준별 지역 수 / map 분포도 이미지"),
        from: str().describe("시작일 YYYYMMDD(생략 시 오늘)"),
        to: str().describe("끝일 YYYYMMDD(생략 시 from)"),
        basis: z.enum(["tmfc", "tmef"]).optional().describe("기간 기준: tmfc 발표일(기본) / tmef 기준일(예보 대상일)"),
        ifpar: str().describe("hw 폭염 / cw 한파"),
        ifarea: numArg().describe("영향분야(설명 참조, 0=모든 분야, 생략 시 1)"),
        ef_sn: numArg().describe("1 내일(기본) / 2 모레 / 3 둘 다"),
        stn: str().describe("관서(108·109·105·131·133·146·156·143·159·184)"),
        area_code: str().describe("status: 특보구역코드(쉼표 여러 개, 하위·옛 구역 포함)"),
        place: str().describe("status: 지역명 → 추정 특보구역"),
        lat: numArg().describe("status: 위도(가장 가까운 AWS의 특보구역)"),
        lon: numArg().describe("status: 경도"),
        min_level: numArg().describe("status 목록 최소 위험수준(0~4, 기본 1)"),
        ilvl: numArg().describe("counts: 이 위험수준만"),
        tmfc: str().describe("map: 발표일 YYYYMMDD(생략 시 오늘)"),
        limit: numArg().describe("목록 최대 행(기본 100, 최대 500)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        if (a.kind === "map") {
          const img = await impactMap({ tmfc: a.tmfc || a.from, stn: a.stn, ifpar: a.ifpar, ifarea: a.ifarea, efSn: a.ef_sn }, meter);
          const meta = { 발표일: img.tmfc, ...(a.ifpar ? { 요소: a.ifpar } : {}), ...(a.ifarea !== undefined ? { 분야: a.ifarea } : {}), 크기바이트: img.bytes, 안내: "그림이다 — 구역·수준을 글로 답할 때는 kind=status를 함께 쓴다.", 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "영향예보 분포도" }) };
          return { content: [{ type: "image", data: img.base64, mimeType: img.mimeType }, { type: "text", text: scrub(JSON.stringify(meta, null, 1)) }] };
        }
        if (a.kind === "counts") {
          const r = await impactCounts({ from: a.from, to: a.to, basis: a.basis, ifpar: a.ifpar, ifarea: a.ifarea, stn: a.stn, ilvl: a.ilvl, efSn: a.ef_sn, limit: a.limit }, meter);
          return ok({ ...r, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "영향예보" }) });
        }
        let areaCodes = a.area_code ? String(a.area_code).split(/[\s,]+/).filter(Boolean) : [];
        let note = null;
        if (!areaCodes.length && (a.place || (a.lat !== undefined && a.lon !== undefined))) {
          const z = await zonesForQuery({ place: a.place, lat: a.lat, lon: a.lon, from: a.from, to: a.to }, meter);
          areaCodes = z.codes;
          note = z.note;
        }
        const r = await impactStatus({ from: a.from, to: a.to, basis: a.basis, ifpar: a.ifpar, ifarea: a.ifarea, stn: a.stn, efSn: a.ef_sn, areaCodes, minLevel: a.min_level ?? 1, limit: a.limit }, meter);
        return ok({ ...(note ? { 구역해석: note } : {}), ...r, 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "영향예보" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5-5. 고속도로 날씨(API허브) ─────────────────────────────────────────────
  server.registerTool(
    "kma_highway_weather",
    {
      title: "고속도로 날씨 — 지점별 실황·출발시각 기준 경로 예보 (API허브)",
      description:
        "고속도로 IC·JCT·휴게소·졸음쉼터(17개 노선 × 상·하행, 1,118곳)의 날씨. " +
        "kind=now: 실황(몇 분 간격) — 강수 유무·60분/일 강수량·강우강도·낙뢰(1시간·100km 이내)·안개 탐지·시정·풍향풍속·기온. " +
        "point(지점명, 예 기흥IC·죽전휴게소), route(노선명·코드 — 그 노선 전 지점), place·lat+lon(가까운 지점) 중 하나. " +
        "kind=trip: 출발지→도착지(from·to: 지점명)를 출발시각 tm(HHMM, 오늘, 지금부터 3시간 뒤까지)에 출발하면 각 지점 도착시각의 예보(하늘·강수·강수확률·적설·바람·기온·낙뢰)와 구간 요약. " +
        "방향(상행·하행)은 출발·도착 순서로 서버가 고른다. route로 노선을 한정할 수 있다. car 01 승용차(기본)·02 대형차. " +
        "★ 대형차(02) 결과는 승용차보다 도착이 빠르게 나온 이상이 실측됐다(가이드는 대형차 80km/h) — 시각은 참고만. 노면 상태(CCTV 분석)는 kma_road_weather.",
      inputSchema: {
        kind: z.enum(["now", "trip"]).describe("now 실황 / trip 출발시각 기준 경로 예보"),
        point: str().describe("now: 지점명(공백으로 노선명과 섞어도 됨, 예 '경부 기흥')"),
        route: str().describe("노선명(경부선·영동선·서울양양선 …) 또는 방향별 노선코드 2자리"),
        place: str().describe("now: 지역명 → 가까운 고속도로 지점"),
        lat: numArg().describe("now: 위도 → 가까운 지점"),
        lon: numArg().describe("now: 경도"),
        from: str().describe("trip: 출발 지점명(예 양재IC)"),
        to: str().describe("trip: 도착 지점명(예 구서IC)"),
        tm: str().describe("trip: 출발시각 HHMM(오늘, 생략 시 지금, 지금부터 3시간 뒤까지)"),
        car: z.enum(["01", "02"]).optional().describe("trip: 01 승용차(기본) / 02 대형차"),
        limit: numArg().describe("now: 최대 지점 수(기본 30, 최대 200)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        if (a.kind === "trip") {
          if (!a.from || !a.to) throw new UpstreamError("trip에는 from(출발 지점명)·to(도착 지점명)가 필요합니다.", "BAD_PARAM");
          const t = resolveTrip({ route: a.route, from: a.from, to: a.to });
          const f = await highwayForecast({ route: t.route, start: t.start.pt, end: t.end.pt, tm: a.tm, car: a.car || "01" }, meter);
          return ok({
            경로: { 노선: HW_ROUTES[t.route], 노선코드: t.route, 출발: t.start.name, 도착: t.end.name, 지점수: Number(t.end.pt) - Number(t.start.pt) + 1, ...(t.다른노선후보 ? { 다른노선후보: t.다른노선후보 } : {}), ...(t.다른지점후보 ? { 다른지점후보: t.다른지점후보 } : {}) },
            출발시각: f.출발시각, 차량: f.차량,
            ...(a.car === "02" ? { 경고: "대형차 도착시각이 승용차보다 빠르게 나오는 원천 이상이 실측됐다(가이드는 대형차 80km/h). 도착시각·그 시각의 예보는 참고만 하라." } : {}),
            ...(NAME_MISMATCH_ROUTES.has(t.route) ? { 지점명주의: NAME_MISMATCH_NOTE } : {}),
            구간요약: tripSummary(f.행),
            지점별: f.행,
            요약: meter.summary({ 기관: "기상청 API허브", 서비스: "고속도로 단기예보" }),
          });
        }
        const limit = Math.min(Math.max(a.limit || 30, 1), 200);
        const routeCodes = a.route ? findRoutes(a.route) : null;
        if (a.route && !routeCodes.length) throw new UpstreamError(`노선을 찾지 못했습니다: "${a.route}". kma_find_code(kind=highway_route)로 확인하세요.`, "BAD_PARAM");
        let targets = null; // [{route, name}]
        let basis = null;
        if (a.point) {
          const f = findHighwayPoints(a.point, routeCodes, 40);
          if (!f.total) throw new UpstreamError(`"${a.point}"에 맞는 고속도로 지점이 없습니다. kma_find_code(kind=highway)로 찾으세요.`, "BAD_PARAM");
          targets = f.raw.slice(0, 12);
          basis = { 검색어: a.point, 일치지점수: f.total };
        } else if (a.place || (a.lat !== undefined && a.lon !== undefined)) {
          let lat = a.lat, lon = a.lon, nm = null;
          if (lat === undefined || lon === undefined) {
            const f = findAreas(a.place, 3);
            if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            lat = f.rows[0].lat; lon = f.rows[0].lon; nm = f.rows[0].full;
          }
          const near = nearestHighwayPoints(lat, lon, 8, routeCodes);
          targets = near.map((p) => ({ route: p.노선코드, name: p.지점, 거리km: p.거리km }));
          basis = { 기준: nm || { lat, lon }, 가까운지점: near.map((p) => `${p.노선} ${p.지점}(${p.거리km}km)`) };
        } else if (routeCodes) {
          targets = routeCodes.map((rc) => ({ route: rc, name: null }));
          basis = { 노선: routeCodes.map((c) => HW_ROUTES[c]) };
        } else throw new UpstreamError("now에는 point·route·place·lat+lon 중 하나가 필요합니다.", "BAD_PARAM");
        const routes = [...new Set(targets.map((t) => t.route))].slice(0, 4);
        let rows = [];
        for (const rc of routes) {
          const want = targets.filter((t) => t.route === rc && t.name).map((t) => t.name);
          const got = await highwayObs(rc, meter);
          rows = rows.concat(want.length ? got.filter((g) => want.includes(g.지점)) : got);
        }
        // 같은 지점의 상·하행 실황이 값까지 같으면 하나로 합친다. 가까운 지점 조회면 거리순으로 다시 놓는다
        const merged = new Map();
        for (const r of rows) {
          const k = `${r.지점}|${r.위도}|${r.경도}|${r.관측시각}|${r.기온}|${r.풍속ms}|${r.시정km}`;
          const m = merged.get(k);
          if (m) m.노선 = m.노선.includes(r.노선.replace(/-(상행|하행)$/, "")) && !m.노선.endsWith("(상·하행)") ? `${m.노선.replace(/-(상행|하행)$/, "")}(상·하행)` : m.노선;
          else merged.set(k, { ...r });
        }
        rows = [...merged.values()];
        const order = targets.filter((t) => t.name).map((t) => t.name);
        if (order.length) rows.sort((x, y) => order.indexOf(x.지점) - order.indexOf(y.지점));
        const total = rows.length;
        rows = rows.slice(0, limit);
        return ok({
          조회: basis, 관측시각: rows[0]?.관측시각 ?? null, 지점수: total, 반환: rows.length,
          ...(total > rows.length ? { 잘림: `전체 ${total}곳 중 ${rows.length}곳만 돌려줬다(limit 최대 200).` } : {}),
          실황: rows,
          ...(routes.some((rc) => NAME_MISMATCH_ROUTES.has(rc)) ? { 지점명주의: NAME_MISMATCH_NOTE } : {}),
          안내: "같은 지점이 상행·하행에 따로 있다. 안개탐지는 위성 기반 판정 코드다(4 안개 확률 높음·5 안개). 시정이 짧거나 안개면 함께 알린다.",
          요약: meter.summary({ 기관: "기상청 API허브", 서비스: "고속도로 날씨실황" }),
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 6. 관광 ────────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_tour_weather",
    {
      title: "관광코스·관광지 날씨",
      description:
        "kind=forecast: 관광코스별 관광지 동네예보(course_id — kma_find_code kind=tour_course로 찾기). " +
        "kind=climate_index: 시군구별 관광기후지수(city_area_id — kind=tour_city로 찾기). " +
        "current_date는 YYYYMMDDHH(생략하면 지금 KST). " +
        "★ 이 서비스의 명세서는 요청·응답 표가 빠져 있어, 공개 규약(CURRENT_DATE·HOUR·COURSE_ID / CURRENT_DATE·DAY·CITY_AREA_ID)으로 보내 실호출 확인을 마쳤다. 응답 필드는 원본 그대로(tm·th3 기온·ws 풍속·sky·rhm 습도·kmaTci·TCI_GRADE 등) 돌려준다. " +
        "결과가 비면 파라미터 형식 문제일 수 있으니 응답의 '조건'을 확인한다.",
      inputSchema: {
        kind: z.enum(["forecast", "climate_index"]).describe("forecast 관광지 예보 / climate_index 관광기후지수"),
        course_id: str().describe("관광코스 ID(forecast)"),
        city_area_id: str().describe("시군구 ID 10자리(climate_index)"),
        current_date: str().describe("기준 시각 YYYYMMDDHH(생략 시 지금)"),
        hours: numArg().describe("forecast 예보 기간(시간, 기본 24)"),
        days: numArg().describe("climate_index 예보 기간(일, 기본 3)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const r =
          a.kind === "forecast"
            ? await getTourForecast({ courseId: a.course_id, currentDate: a.current_date, hours: a.hours }, meter)
            : await getTourClimateIndex({ cityAreaId: a.city_area_id, currentDate: a.current_date, days: a.days }, meter);
        return ok({ ...r, 요약: meter.summary({ 기관: "기상청", 서비스: "관광코스별 관광지 날씨" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 7. 도로날씨 ────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_road_weather",
    {
      title: "CCTV 기반 도로날씨",
      description:
        "CCTV 영상을 분석한 도로 날씨 현상(맑음·비·눈 등)을 수집일시와 함께 돌려준다. " +
        "eqmt_id(CCTV ID, 예 0500C00001·2023T1 — kma_find_code kind=cctv로 노선·지점명 검색)로 그 지점 결과를, " +
        "std_link_id(표준노드링크 ID)로 그 링크에 연결된 위험도 높은 CCTV 분석 결과를 조회한다(둘 중 하나). " +
        "관측지점은 2024-12-20 이후 861개. hh_code는 '최근 결과 시간'(기본 00).",
      inputSchema: {
        eqmt_id: str().describe("CCTV ID"),
        std_link_id: str().describe("표준노드링크 ID(예 2370012300)"),
        hh_code: str().describe("시간코드(기본 00)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const r = await getRoadWeather({ eqmtId: a.eqmt_id, stdLinkId: a.std_link_id, hhCode: a.hh_code }, meter);
        return ok({ ...r, 요약: meter.summary({ 기관: "기상청", 서비스: "CCTV 도로날씨" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 8. 생활기상지수 ────────────────────────────────────────────────────────
  server.registerTool(
    "kma_living_index",
    {
      title: "생활기상지수 (자외선·대기정체)",
      description:
        "지점별 자외선지수·대기정체지수를 발표시각부터 3시간 간격 최대 78시간 뒤까지 시각별로 풀어 돌려준다. " +
        "kind=uv 자외선 예측(11이상 위험·8~10 매우높음·6~7 높음·3~5 보통·0~2 낮음, 단계별 주의사항 포함 — 실측은 kma_uv_observation), air 대기정체(100 매우높음·75 높음·50 보통·25 낮음), both 둘 다. " +
        "지점은 area_no(행정구역코드 10자리) 또는 place(지역명)로 준다 — 지점 없이 전체를 부르면 응답이 너무 커서 막는다. " +
        "time(발표시각 YYYYMMDDHH, 00~21시 3시간 단위)을 생략하면 가장 최근 발표분을 찾고 없으면 두 발표 이전까지 물러선다. 최근 발표분만 제공한다.",
      inputSchema: {
        kind: z.enum(["uv", "air", "both"]).describe("uv 자외선 / air 대기정체 / both"),
        area_no: str().describe("행정구역코드 10자리(예 1168000000 서울 강남구)"),
        place: str().describe("지역명(area_no 대신)"),
        time: str().describe("발표시각 YYYYMMDDHH(생략 시 자동)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let areaNo = a.area_no;
        let resolved;
        if (!areaNo && a.place) {
          const f = findAreas(a.place, 5);
          if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
          areaNo = f.rows[0].code;
          resolved = { 지역: f.rows[0].full, 행정구역코드: areaNo, ...(f.total > 1 ? { 다른후보: f.rows.slice(1, 5).map((x) => x.full) } : {}) };
        }
        if (!areaNo) throw new UpstreamError("area_no(행정구역코드 10자리) 또는 place(지역명)가 필요합니다. 전체 지점 일괄 조회는 지원하지 않습니다.", "BAD_PARAM");
        if (!/^\d{10}$/.test(String(areaNo))) throw new UpstreamError(`area_no는 숫자 10자리여야 합니다: "${areaNo}"`, "BAD_PARAM");
        const kinds = a.kind === "both" ? ["uv", "air"] : [a.kind];
        const out = [];
        for (const k of kinds) out.push(await getLivingIndex(k, { areaNo, time: a.time }, meter));
        const uvStages = new Set();
        for (const r of out) if (r.종류 === "자외선지수") for (const p of r.지점) for (const x of p.예측) if (x.단계) uvStages.add(x.단계);
        return ok({ ...(resolved ? { 지점해석: resolved } : {}), 결과: out, ...(uvStages.size ? { 자외선단계별주의사항: Object.fromEntries([...uvStages].map((g) => [g, UV_GUIDE[g]])) } : {}), 요약: meter.summary({ 기관: "기상청", 서비스: "생활기상지수" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 9. 자외선 관측 ─────────────────────────────────────────────────────────
  server.registerTool(
    "kma_uv_observation",
    {
      title: "자외선 관측 (실측, 10분 간격)",
      description:
        "기상청 자외선 관측망의 실측 자외선지수(UV-B 지수)를 돌려준다(기상청 API허브, 10분 간격). kma_living_index(kind=uv)는 '예측'이고 이쪽은 '관측'이다. " +
        "지점은 stn(지점번호) 또는 place(지역명)·lat+lon(가장 가까운 관측소를 골라 거리와 함께 알려준다)으로 주고, 생략하면 전 지점. " +
        "tm(YYYYMMDDHHMI, 10분 단위)을 생략하면 최신 관측, 과거 시각도 조회된다. hours를 주면 한 지점의 최근 N시간(최대 12) 정시 추이를 N회 호출로 모은다. " +
        "단계(11이상 위험·8~10 매우높음·6~7 높음·3~5 보통·0~2 낮음)와 기상청 단계별 주의사항을 함께 돌려준다. " +
        "관측소는 전국 십수 곳뿐이라(서울·인천·청주·대전·전주·광주·목포·대구·포항·울산·부산·북강릉·안면도·울릉도·고산 등) 가장 가까운 관측소도 수십 km 떨어질 수 있다 — 응답의 거리km를 답변에 밝힐 것.",
      inputSchema: {
        stn: str().describe("지점번호(예 108 서울). 생략 시 전 지점"),
        place: str().describe("지역명 — 가장 가까운 관측소를 고른다"),
        lat: numArg().describe("위도 — lon과 함께 주면 가장 가까운 관측소"),
        lon: numArg().describe("경도"),
        tm: str().describe("관측시각 YYYYMMDDHHMI(생략 시 최신)"),
        hours: numArg().describe("한 지점의 최근 N시간 정시 추이(1~12, N회 호출)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const tm = normUvTm(a.tm);
        let stn = a.stn ? String(a.stn).trim() : "";
        // 지점정보(이름·좌표) — 실패해도 관측 조회는 진행
        let stations = null;
        let stnNote = null;
        try {
          stations = (await fetchUvStations(meter)).rows;
        } catch (e) {
          stnNote = `지점정보 조회 실패(${e.code || ""}) — 지점명은 ASOS 번호 기준 추정`;
        }
        const nameOf = (id) => {
          const s = stations && stations.find((x) => x.지점 === Number(id));
          return s ? s.지점명 : UV_STN_NAME[Number(id)] ?? "미확인";
        };
        let picked = null;
        if (!stn && (a.place || (a.lat !== undefined && a.lon !== undefined))) {
          if (!stations) throw new UpstreamError("가까운 관측소를 고르려면 지점정보가 필요한데 조회에 실패했습니다. stn(지점번호)으로 직접 주세요.", "UPSTREAM");
          let lat = a.lat, lon = a.lon, from = null;
          if (a.place) {
            const f = findAreas(a.place, 3);
            if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            lat = f.rows[0].lat; lon = f.rows[0].lon; from = f.rows[0].full;
          }
          const near = nearestUvStations(stations, lat, lon, 3);
          stn = String(near[0].지점);
          picked = { 기준: from || `${lat},${lon}`, 선택관측소: `${near[0].지점명}(${near[0].지점})`, 거리km: near[0].거리km, 다른후보: near.slice(1).map((x) => `${x.지점명}(${x.지점}) ${x.거리km}km`) };
        }
        const guideOf = (rows) => {
          const stages = [...new Set(rows.map((x) => x.단계).filter(Boolean))];
          return Object.fromEntries(stages.map((g) => [g, UV_GUIDE[g]]));
        };
        const extra = { ...(picked ? { 관측소선택: picked } : {}), ...(stnNote ? { 안내: stnNote } : {}) };
        if (a.hours) {
          if (!stn) throw new UpstreamError("hours(추이)는 한 지점(stn·place·lat+lon)을 지정해야 합니다.", "BAD_PARAM");
          const n = Math.min(Math.max(Number(a.hours) || 1, 1), 12);
          const series = [];
          for (const t of hourlyBack(n, tm)) {
            const rows = await fetchUvObs(t, stn, meter);
            const r = rows.find((x) => String(x.지점) === stn);
            series.push(r ? { 관측시각: r.관측시각, 자외선지수: r.자외선지수, 단계: r.단계 } : { 관측시각: t, 자외선지수: null, 단계: null, 비고: "자료 없음" });
          }
          return ok({ 지점: Number(stn), 지점명: nameOf(stn), ...extra, 추이: series, 단계별주의사항: guideOf(series), 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "자외선 관측" }) });
        }
        let rows = tm ? await fetchUvObs(tm, stn, meter) : await latestUvObs(stn, meter);
        if (stn) rows = rows.filter((x) => String(x.지점) === stn);
        if (!rows.length) throw new UpstreamError(`자외선 관측 자료가 없습니다(tm=${tm || "최신"}, stn=${stn || "전체"}). 10분 단위 시각인지, 지점번호가 맞는지 확인하세요.`, "NO_DATA");
        rows = rows.map(({ 지점명_추정, ...r }) => ({ ...r, 지점명: nameOf(r.지점) }));
        return ok({ 관측시각: rows[0].관측시각, 지점수: rows.length, ...extra, 관측: rows, 단계별주의사항: guideOf(rows), 요약: meter.summary({ 기관: "기상청 API허브", 서비스: "자외선 관측" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 10. 상태 ────────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_api_status",
    {
      title: "기상 MCP 상태·내장 코드표·호출 한도 안내",
      description:
        "서버의 키 설정 여부, 서비스별 호스트(단기·중기는 API허브 키가 있으면 API허브 우선 — 포털 피드보다 최신), 내장 코드표 규모를 돌려준다. ping=true면 실제 호출 2회(초단기실황·특보현황)로 키·승인 상태를 확인한다. " +
        "호출 한도는 오퍼레이션별 일일 한도이고 같은 공공데이터포털 키를 쓰는 다른 서버와 공유한다(코드 22는 재시도 금지).",
      inputSchema: { ping: bool(false).describe("true면 실제 호출 2회로 점검(한도를 쓴다)") },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const out = {
          서버: { 이름: "kma-weather-mcp", 버전: SERVER_VERSION },
          키: { DATA_PORTAL_KEY: envKey("DATA_PORTAL_KEY") ? "설정됨" : "없음", KMA_APIHUB_KEY: envKey("KMA_APIHUB_KEY") ? "설정됨" : "없음(선택)" },
          서비스: Object.entries(SERVICES).map(([k, s]) => ({ 키: k, 서비스: s.label, 호스트: { "apihub→datago": "API허브 우선, 오류 시 공공데이터포털", apihub: "API허브만", datago: "공공데이터포털만" }[hostMode(k)] })),
          내장코드표: { 행정구역_격자: AREA_COUNT, 관광코스: TOUR_COURSE_COUNT, 관광지: TOUR_SPOT_COUNT, CCTV: CCTV_COUNT, 고속도로지점: HW_POINT_COUNT, 고속도로노선_방향별: Object.keys(HW_ROUTES).length },
          API허브전용: "동네예보 통보문·예보구역정보·특보 이력/현황/지도·영향예보·고속도로 날씨·과거 초단기예보(지점)·AWS-특보구역 매칭·자외선 관측·관측소 정보는 KMA_APIHUB_KEY가 있어야 한다",
          특보지점: WARN_STN,
          중기전망지점: MID_STN,
        };
        if (a.ping) {
          const pings = [];
          for (const [nm, fn] of [
            ["초단기실황(서울)", () => getShort("now", { nx: 60, ny: 127 }, meter)],
            ["특보현황", () => getWarnings("status", {}, meter)],
          ]) {
            try {
              await fn();
              pings.push({ 점검: nm, 결과: "정상" });
            } catch (e) {
              pings.push({ 점검: nm, 결과: `오류: ${scrub(e.message)}`, 코드: e.code });
            }
          }
          out.점검 = pings;
        }
        return ok({ ...out, 요약: meter.summary() });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  return server;
}
