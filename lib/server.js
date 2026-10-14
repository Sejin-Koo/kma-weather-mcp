// kma-weather-mcp — 기상청 날씨 MCP 서버
//
// 공공데이터포털로 활용신청·승인된 기상청 OpenAPI 6개 서비스(24개 오퍼레이션)와 API허브 자외선 관측을 도구로 묶는다.
//   단기예보(초단기실황·초단기예보·단기예보·예보버전) · 중기예보(전망·육상·기온·해상) ·
//   기상특보(10개 오퍼레이션) · 관광코스별 관광지 날씨(2) · CCTV 도로날씨(2) · 생활기상지수(자외선·대기정체)
// 저장소는 두지 않는다(매번 실시간 조회). 지역명→격자·코드 변환용 코드표만 서버에 내장한다(data/).
// 원천별 실측 함정은 lib/<모듈>.js 머리 주석에 있다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Meter, UpstreamError, scrub, envKey, normalizeDate, todayKst } from "./common.js";
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

export const SERVER_VERSION = "1.2.0";

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────
const ok = (obj) => {
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
      nx: r.nx, ny: r.ny, 방식: "지역명 검색", 선택된지역: r.full, 행정구역코드: r.code, area: r,
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
        "station·uv_station만 기상청 API허브 지점정보를 1회 호출한다(12시간 캐시). tm(YYYYMMDDHHMI)을 주면 그 시점의 관측소 구성. " +
        "★ kind=location의 중기예보 구역·특보구역은 행정구역 이름 일치로 추정한 값이라 '추정'으로 표시한다(기상청 공식 배정표 아님). 관측소의 예보구역코드는 기상청 배정값이지만 '그 관측소의' 배정이다.",
      inputSchema: {
        kind: z.enum(["location", "warn_zone", "mid_region", "tour_course", "tour_city", "cctv", "cctv_routes", "station", "uv_station"]).describe("찾을 대상"),
        query: str().describe("검색어(공백으로 여러 토큰 가능). location에서는 place 대신 써도 된다. station·uv_station에서는 지점번호·관측소명·주소, 또는 near=true와 함께 지역명"),
        lat: numArg().describe("kind=location·station·uv_station에서 좌표로 찾을 때 위도"),
        lon: numArg().describe("kind=location·station·uv_station에서 좌표로 찾을 때 경도"),
        near: bool(false).describe("station·uv_station에서 query를 지역명으로 보고 그 지역에서 가까운 관측소를 찾는다"),
        tm: str().describe("station·uv_station: 관측소 구성 기준시각 YYYYMMDDHHMI(생략 시 현재)"),
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
        "해상 격자는 값이 마스킹돼 null이다. 지역명이 여러 곳에 일치하면 상위 단계를 골라 다른 후보를 알려준다.",
      inputSchema: {
        kind: z.enum(["now", "ultra", "short"]).describe("now 초단기실황 / ultra 초단기예보 / short 단기예보"),
        ...locArgs,
        base_date: str().describe("발표일 YYYYMMDD(생략하면 자동). 과거 발표분 확인용 — 기상청은 오래된 발표분을 제공하지 않는다"),
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
        const r = await getShort(a.kind, { nx: loc.nx, ny: loc.ny, base_date: base_date || undefined, base_time }, meter);
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
        "area_code(특보구역코드 — 그 하위 구역 포함) 또는 place(지역명 → 추정 특보구역), level(예비·주의보·경보·중대경보), command(발표·해제 등). 한 번에 종류 미지정 92일·종류 지정 366일까지. " +
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
        place: str().describe("events: 지역명 → 추정 특보구역(시군구 구역 + 시도 구역)"),
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
          if (!areaCodes.length && a.place) {
            const f = findAreas(a.place, 3);
            if (!f.total) throw new UpstreamError(`"${a.place}"에 맞는 행정구역이 없습니다.`, "BAD_PARAM");
            const zones = warnForArea(f.rows[0]).filter((w) => w.특보구역코드.startsWith("L"));
            if (!zones.length) throw new UpstreamError(`"${f.rows[0].full}"의 특보구역을 추정하지 못했습니다. area_code를 직접 주세요(kma_find_code kind=warn_zone).`, "BAD_PARAM");
            // 시군구 구역이 있으면 그것만, 없으면 시도 구역
            const leaf = zones.filter((w) => w.상위구역 && !/L1000000/.test(w.상위구역));
            areaCodes = (leaf.length ? leaf : zones).map((w) => w.특보구역코드);
            placeNote = { 지역: f.rows[0].full, 추정특보구역: (leaf.length ? leaf : zones).map((w) => `${w.구역명}(${w.특보구역코드})`), 추정: true };
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
          내장코드표: { 행정구역_격자: AREA_COUNT, 관광코스: TOUR_COURSE_COUNT, 관광지: TOUR_SPOT_COUNT, CCTV: CCTV_COUNT },
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
