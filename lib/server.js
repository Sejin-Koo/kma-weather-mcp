// kma-weather-mcp — 기상청 날씨 MCP 서버
//
// 공공데이터포털로 활용신청·승인된 기상청 OpenAPI 6개 서비스(24개 오퍼레이션)를 도구 9개로 묶는다.
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
  findMidRegions, findWarnZones, findTourCourses, findTourCities, tourSpotsOfCourse, findCctv, cctvRoutes,
  AREA_COUNT, TOUR_COURSE_COUNT, TOUR_SPOT_COUNT, CCTV_COUNT,
} from "./geo.js";
import { getShort, getVersion, KIND_LABEL as SHORT_LABEL } from "./short.js";
import { getMidOutlook, getMidLand, getMidTemp, getMidSea, MID_STN } from "./mid.js";
import { getWarnings, WARN_KINDS, WARN_STN, WARN_TYPES } from "./warn.js";
import { getTourForecast, getTourClimateIndex, getRoadWeather, getLivingIndex } from "./extra.js";

export const SERVER_VERSION = "1.0.0";

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
        "★ 중기예보 구역·특보구역은 행정구역 이름 일치로 추정한 값이라 '추정'으로 표시한다(기상청 공식 배정표 아님).",
      inputSchema: {
        kind: z.enum(["location", "warn_zone", "mid_region", "tour_course", "tour_city", "cctv", "cctv_routes"]).describe("찾을 대상"),
        query: str().describe("검색어(공백으로 여러 토큰 가능). location에서는 place 대신 써도 된다"),
        lat: numArg().describe("kind=location에서 좌표로 찾을 때 위도"),
        lon: numArg().describe("kind=location에서 좌표로 찾을 때 경도"),
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
        "발표시각은 지금(KST) 기준 제공 가능한 가장 최근 것을 자동 선택하고(실황 HH00·초단기 HH30·단기 02/05/08/11/14/17/20/23시, 각 +10분 이후 제공), 자료가 없으면 한 발표 이전으로 물러선다. " +
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
        "★ 2026-10-14 실측에서 이 오퍼레이션만 APPLICATION_ERROR가 났다(같은 호스트의 다른 오퍼레이션은 정상). 발표 여부 확인은 kma_short_forecast의 NO_DATA 응답으로도 알 수 있다.",
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
        "id 대신 place(지역명)를 주면 행정구역으로 추정한 구역을 쓰고 '추정'이라고 표시한다. 구역코드는 kma_find_code(kind=mid_region)로 찾는다. " +
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
          const m = midForArea(f.rows[0]);
          const pick = a.kind === "land" ? m.육상예보 : m.중기기온;
          if (!pick) throw new UpstreamError(`"${f.rows[0].full}"에 맞는 중기${a.kind === "land" ? "육상" : "기온"} 구역을 찾지 못했습니다. kma_find_code(kind=mid_region)로 직접 고르세요.`, "BAD_PARAM");
          id = pick.구역코드;
          resolved = { 지역: f.rows[0].full, 구역: pick, 추정: true };
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
        "본문 조회(warning·preliminary·info·breaking)는 stn_id가 필수다. 날짜(from·to)를 생략하면 오늘이다. " +
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

  // ── 6. 관광 ────────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_tour_weather",
    {
      title: "관광코스·관광지 날씨",
      description:
        "kind=forecast: 관광코스별 관광지 동네예보(course_id — kma_find_code kind=tour_course로 찾기). " +
        "kind=climate_index: 시군구별 관광기후지수(city_area_id — kind=tour_city로 찾기). " +
        "current_date는 YYYYMMDDHH(생략하면 지금 KST). " +
        "★ 이 서비스의 명세서는 요청·응답 표가 빠져 있어 파라미터를 공개 규약(CURRENT_DATE·HOUR·COURSE_ID / CURRENT_DATE·DAY·CITY_AREA_ID)으로 보냈고 응답 필드는 원본 그대로 돌려준다. " +
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
        "kind=uv 자외선(11이상 위험·8~10 매우높음·6~7 높음·3~5 보통·0~2 낮음), air 대기정체(100 매우높음·75 높음·50 보통·25 낮음), both 둘 다. " +
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
        return ok({ ...(resolved ? { 지점해석: resolved } : {}), 결과: out, 요약: meter.summary({ 기관: "기상청", 서비스: "생활기상지수" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 9. 상태 ────────────────────────────────────────────────────────────────
  server.registerTool(
    "kma_api_status",
    {
      title: "기상 MCP 상태·내장 코드표·호출 한도 안내",
      description:
        "서버의 키 설정 여부, 서비스별 호스트(공공데이터포털/API허브), 내장 코드표 규모를 돌려준다. ping=true면 실제 호출 2회(초단기실황·특보현황)로 키·승인 상태를 확인한다. " +
        "호출 한도는 오퍼레이션별 일일 한도이고 같은 공공데이터포털 키를 쓰는 다른 서버와 공유한다(코드 22는 재시도 금지).",
      inputSchema: { ping: bool(false).describe("true면 실제 호출 2회로 점검(한도를 쓴다)") },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const out = {
          서버: { 이름: "kma-weather-mcp", 버전: SERVER_VERSION },
          키: { DATA_PORTAL_KEY: envKey("DATA_PORTAL_KEY") ? "설정됨" : "없음", KMA_APIHUB_KEY: envKey("KMA_APIHUB_KEY") ? "설정됨" : "없음(선택)" },
          서비스: Object.entries(SERVICES).map(([k, s]) => ({ 키: k, 서비스: s.label, 호스트: hostMode(k) === "apihub" ? "API허브(KMA_HOST 설정)" : "공공데이터포털(apis.data.go.kr)" })),
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
