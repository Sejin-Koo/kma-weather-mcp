// kma-weather-mcp / lib/extra.js
//
// 관광코스별 관광지 날씨(TourStnInfoService1) · CCTV 도로날씨(RoadWthrInfoService) · 생활기상지수(LivingWthrIdxServiceV5).
//
// ── 관광 (getTourStnVilageFcst1 / getCityTourClmIdx1) ──────────────────────
// ★★ 관광코스 명세서(docx)는 요청·응답 표가 이미지로 빠져 있어 파라미터명을 문서에서 확인하지 못했다.
//   공개된 이 API의 호출 규약(CURRENT_DATE=YYYYMMDDHH · HOUR=예보기간(시간) · COURSE_ID / CURRENT_DATE · DAY · CITY_AREA_ID)을
//   따랐고, 실호출로 검증한 뒤에야 이 주석을 "실측"으로 고친다(미검증 표시를 지우지 말 것).
//   응답 필드는 확인하지 못해 원본 그대로 돌려준다.
//
// ── 도로날씨 ────────────────────────────────────────────────────────────────
// ★ CCTV 영상을 분석한 도로 노면·기상 현상(맑음·비·눈 등). 관측지점이 2024-12-20에 113개→861개로 늘었다.
// ★ 명세 표에는 eqmtld(소문자 L)로 적혀 있으나 예시 URL은 eqmtId(대문자 I)다 → eqmtId로 보낸다.
// ★ getStdNodeLinkRoadWw의 응답 필드명이 baseData(날짜)·baseDate(예시)로 문서 안에서도 엇갈린다 → 둘 다 받는다.
// ★ hhCode는 "최근 결과 시간(기본 00)". 의미는 실호출로 확인한 뒤 적는다.
//
// ── 생활기상지수(자외선·대기정체) ───────────────────────────────────────────
// ★ areaNo는 행정구역코드 10자리(기상청 격자 파일의 행정구역코드와 같다). 공백이면 전체 지점.
// ★ time은 발표시각 YYYYMMDDHH(00~21시, 3시간 간격, 일 8회). 최근 발표분만 제공한다.
// ★ 응답 h0·h3·…·h78 = 발표시각으로부터 N시간 후 예측값 → 실제 시각으로 풀어 돌려준다.
// ★ 자외선 단계: 11이상 위험·8~10 매우높음·6~7 높음·3~5 보통·0~2 낮음.
//   대기정체 지수값: 100 매우높음·75 높음·50 보통·25 낮음(명세표의 자료값).

import { UpstreamError, toNum, nowKst, fmtYmd, parseYmd, dashed } from "./common.js";
import { kmaCall, fetchAll } from "./kma.js";
import { cctvName } from "./geo.js";

const pad = (n) => String(n).padStart(2, "0");

function ymdh(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}

// ── 관광 ────────────────────────────────────────────────────────────────────
export async function getTourForecast({ courseId, currentDate, hours }, meter) {
  if (!courseId) throw new UpstreamError("courseId(관광코스 ID)가 필요합니다. kma_find_code(kind=tour_course)로 찾으세요.", "BAD_PARAM");
  const now = nowKst();
  const cd = String(currentDate || ymdh(now)).replace(/\D/g, "");
  if (!/^\d{10}$/.test(cd)) throw new UpstreamError(`current_date는 YYYYMMDDHH(10자리)여야 합니다: "${currentDate}"`, "BAD_PARAM");
  const params = { CURRENT_DATE: cd, HOUR: String(hours || 24), COURSE_ID: String(courseId) };
  const res = await fetchAll("TOUR", "getTourStnVilageFcst1", params, { meter, pageSize: 300, maxPages: 3 });
  return {
    종류: "관광코스별 관광지 동네예보", 조건: params, 전체건수: res.totalCount, 반환건수: res.items.length,
    ...(res.complete ? {} : { 경고: `전체 ${res.totalCount}건 중 ${res.items.length}건만 받았습니다.` }),
    항목: res.items,
  };
}

export async function getTourClimateIndex({ cityAreaId, currentDate, days }, meter) {
  if (!cityAreaId) throw new UpstreamError("cityAreaId(시군구 ID, 10자리)가 필요합니다. kma_find_code(kind=tour_city)로 찾으세요.", "BAD_PARAM");
  const now = nowKst();
  const cd = String(currentDate || ymdh(now)).replace(/\D/g, "");
  if (!/^\d{10}$/.test(cd)) throw new UpstreamError(`current_date는 YYYYMMDDHH(10자리)여야 합니다: "${currentDate}"`, "BAD_PARAM");
  const params = { CURRENT_DATE: cd, DAY: String(days || 3), CITY_AREA_ID: String(cityAreaId) };
  const res = await fetchAll("TOUR", "getCityTourClmIdx1", params, { meter, pageSize: 300, maxPages: 3 });
  return {
    종류: "시군구별 관광기후지수", 조건: params, 전체건수: res.totalCount, 반환건수: res.items.length,
    ...(res.complete ? {} : { 경고: `전체 ${res.totalCount}건 중 ${res.items.length}건만 받았습니다.` }),
    항목: res.items,
  };
}

// ── 도로날씨 ────────────────────────────────────────────────────────────────
export async function getRoadWeather({ eqmtId, stdLinkId, hhCode }, meter) {
  if (!eqmtId && !stdLinkId) throw new UpstreamError("eqmt_id(CCTV ID) 또는 std_link_id(표준노드링크 ID) 중 하나가 필요합니다.", "BAD_PARAM");
  if (eqmtId && stdLinkId) throw new UpstreamError("eqmt_id와 std_link_id는 동시에 줄 수 없습니다.", "BAD_PARAM");
  const hh = String(hhCode ?? "00").padStart(2, "0");
  let res;
  if (eqmtId) {
    res = await fetchAll("ROAD", "getCctvStnRoadWthr", { eqmtId: String(eqmtId), hhCode: hh }, { meter, pageSize: 100, maxPages: 2 });
  } else {
    res = await fetchAll("ROAD", "getStdNodeLinkRoadWw", { stdLinkId: String(stdLinkId), hhCode: hh }, { meter, pageSize: 100, maxPages: 2 });
  }
  const items = res.items.map((it) => {
    const date = it.baseDate ?? it.baseData ?? null;
    const t = it.baseTime ?? null;
    const o = {
      수집일시: date && t ? `${dashed(String(date))} ${String(t).padStart(4, "0").slice(0, 2)}:${String(t).padStart(4, "0").slice(2)}` : null,
      도로날씨: it.weatherNm ?? null,
    };
    const id = it.cctvId ?? eqmtId;
    if (id) {
      o.CCTV_ID = id;
      const n = cctvName(String(id));
      o.CCTV명 = it.cctvNm ?? n?.지점명 ?? null;
      if (n) o.노선 = n.노선;
    }
    return o;
  });
  return {
    종류: eqmtId ? "CCTV지점별 도로날씨" : "표준노드링크별 도로날씨(위험도 높은 CCTV 분석)",
    조건: eqmtId ? { eqmtId, hhCode: hh } : { stdLinkId, hhCode: hh },
    전체건수: res.totalCount, 반환건수: items.length, 항목: items,
  };
}

// ── 생활기상지수 ────────────────────────────────────────────────────────────
const UV_LEVEL = (v) => (v === null ? null : v >= 11 ? "위험" : v >= 8 ? "매우높음" : v >= 6 ? "높음" : v >= 3 ? "보통" : "낮음");
const AIR_LEVEL = (v) => (v === null ? null : v >= 100 ? "매우높음" : v >= 75 ? "높음" : v >= 50 ? "보통" : v >= 25 ? "낮음" : "매우낮음(25 미만)");

/** 지금에서 제공 가능한 3시간 간격 발표시각 후보(최신순). 발표 후 1시간 뒤부터 제공으로 가정 */
function livingCandidates(n = 3) {
  const now = new Date(nowKst().getTime() - 3600 * 1000);
  now.setUTCMinutes(0, 0, 0);
  now.setUTCHours(now.getUTCHours() - (now.getUTCHours() % 3));
  const out = [];
  for (let i = 0; i < n; i++) out.push(ymdh(new Date(now.getTime() - i * 3 * 3600 * 1000)));
  return out;
}

export async function getLivingIndex(kind, { areaNo, time }, meter) {
  const op = kind === "uv" ? "getUVIdxV5" : "getAirDiffusionIdxV5";
  const label = kind === "uv" ? "자외선지수" : "대기정체지수";
  const level = kind === "uv" ? UV_LEVEL : AIR_LEVEL;
  const fixed = time ? String(time).replace(/\D/g, "") : null;
  if (fixed && !/^\d{10}$/.test(fixed)) throw new UpstreamError(`time은 YYYYMMDDHH(10자리)여야 합니다: "${time}"`, "BAD_PARAM");
  const cands = fixed ? [fixed] : livingCandidates();
  let r;
  let used;
  let last;
  for (const c of cands) {
    try {
      r = await kmaCall("LIVING", op, { numOfRows: 100, pageNo: 1, areaNo: areaNo ? String(areaNo) : "", time: c }, { meter });
      used = c;
      break;
    } catch (e) {
      last = e;
      if (e.code === "NO_DATA" && !fixed) continue;
      throw e;
    }
  }
  if (!r) {
    last.message += ` (시도한 발표시각: ${cands.join(", ")}. areaNo는 행정구역코드 10자리, time은 00~21시 3시간 단위 YYYYMMDDHH)`;
    throw last;
  }
  const base = new Date(Date.UTC(+used.slice(0, 4), +used.slice(4, 6) - 1, +used.slice(6, 8), +used.slice(8, 10)));
  const areas = r.items.map((it) => {
    const series = [];
    for (const [k, v] of Object.entries(it)) {
      const m = k.match(/^h(\d+)$/);
      if (!m) continue;
      const h = Number(m[1]);
      const t = new Date(base.getTime() + h * 3600 * 1000);
      const num = toNum(v);
      series.push({ h, 시각: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:00`, 값: num, 단계: level(num) });
    }
    series.sort((a, b) => a.h - b.h);
    return { 지점코드: it.areaNo ?? null, 발표시각: it.date ?? used, 지수코드: it.code ?? null, 예측: series.map(({ h, ...rest }) => rest) };
  });
  return { 종류: label, 발표시각: used, 시도한발표시각: cands.slice(0, cands.indexOf(used) + 1), 전체건수: r.totalCount, 지점수: areas.length, 지점: areas };
}
