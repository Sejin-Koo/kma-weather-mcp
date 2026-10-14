// kma-weather-mcp / lib/warn.js
//
// 기상특보 서비스(WthrWrnInfoService) — 10개 오퍼레이션을 한 모듈로 묶는다.
//
//   현황      getPwnStatus                 최근 7일 이내 특보·예비특보 현황(요청 인자 없음)
//   구역별    getPwnCd                     특보구역코드(areaCode)·특보종류(warningType)·기간으로 발효 특보
//   특보      getWthrWrnList / getWthrWrnMsg      특보 목록 / 통보문(stnId 필수)
//   예비특보  getWthrPwnList / getWthrPwn         목록 / 본문
//   기상정보  getWthrInfoList / getWthrInfo       목록 / 본문
//   기상속보  getWthrBrkNewsList / getWthrBrkNews 목록 / 본문
//
// ── 명세 ────────────────────────────────────────────────────────────────────
// ★ stnId: 108 전국·109 서울인천경기·159 부산울산경남·143 대구경북·156 광주전남·146 전북·133 대전세종충남·131 충북·105 강원·184 제주.
// ★ warningType: 1 강풍·2 호우·3 한파·4 건조·5 폭풍해일·6 풍랑·7 태풍·8 대설·9 황사·12 폭염·13 열대야(2026-06-01부터).
// ★ 특보강도 warnStress: 0 주의보·1 경보·2 중대경보. 발표구분 command: 1 발표·2 해제·3 연장·6 정정·7 변경발표·8 변경해제.
// ★★ getPwnCd(구역별)는 **오늘 기준 60일 전까지**만 조회된다(실측 2026-10-14, 코드 99 "최대 조회 기간은 오늘 기준으로 60일 전까지입니다").
// ★★ 나머지 목록·본문 8종(특보·예비특보·기상정보·기상속보의 목록과 본문)은 **오늘 기준 6일 전까지**만 조회된다
//   (실측 2026-10-14: 8종 모두 from=오늘-6일은 정상, 오늘-7일·오늘-24일은 코드 99 "최대 조회 기간은 오늘 기준으로 6일 전까지입니다").
//   → 서버가 미리 막고, 그 이전 이력은 구역별(60일)로 보라고 안내한다.
// ★ 날짜는 fromTmFc·toTmFc 모두 YYYYMMDD. 본문 조회(Msg·Info·BrkNews·Pwn)에서 stnId는 필수고,
//   날짜를 빼면 오늘 00:00~23:59로 본다.
// ★ 응답 필드는 오퍼레이션마다 다르다(t1~t7 본문 조각, tmFc 발표시각, tmSeq 발표번호, tmEf 발효시각 …).
//   확인하지 못한 필드를 지어내지 않도록 원본 필드를 그대로 돌려주고, 코드값(종류·강도·발표구분)만 해석을 덧붙인다.

import { UpstreamError, todayKst, normalizeDate, daysBetween, addDays } from "./common.js";
import { kmaCall, fetchAll } from "./kma.js";

export const WARN_TYPES = { 1: "강풍", 2: "호우", 3: "한파", 4: "건조", 5: "폭풍해일", 6: "풍랑", 7: "태풍", 8: "대설", 9: "황사", 12: "폭염", 13: "열대야" };
export const WARN_STRESS = { 0: "주의보", 1: "경보", 2: "중대경보" };
export const WARN_COMMAND = { 1: "발표", 2: "해제", 3: "연장", 6: "정정", 7: "변경발표", 8: "변경해제" };
export const WARN_STN = { 108: "전국", 109: "서울·인천·경기", 159: "부산·울산·경남", 143: "대구·경북", 156: "광주·전남", 146: "전북", 133: "대전·세종·충남", 131: "충북", 105: "강원", 184: "제주" };

export const WARN_KINDS = {
  status: { op: "getPwnStatus", label: "특보 현황(최근 7일)", needStn: false, dated: false },
  area: { op: "getPwnCd", label: "특보구역별 발효 특보", needStn: false, dated: true, maxBack: 60 },
  warning_list: { op: "getWthrWrnList", label: "특보 목록", needStn: false, dated: true, maxBack: 6 },
  warning: { op: "getWthrWrnMsg", label: "특보 통보문", needStn: true, dated: true, maxBack: 6 },
  preliminary_list: { op: "getWthrPwnList", label: "예비특보 목록", needStn: false, dated: true, maxBack: 6 },
  preliminary: { op: "getWthrPwn", label: "예비특보 본문", needStn: true, dated: true, maxBack: 6 },
  info_list: { op: "getWthrInfoList", label: "기상정보 목록", needStn: false, dated: true, maxBack: 6 },
  info: { op: "getWthrInfo", label: "기상정보 본문", needStn: true, dated: true, maxBack: 6 },
  breaking_list: { op: "getWthrBrkNewsList", label: "기상속보 목록", needStn: false, dated: true, maxBack: 6 },
  breaking: { op: "getWthrBrkNews", label: "기상속보 본문", needStn: true, dated: true, maxBack: 6 },
};

function decorate(it) {
  const o = { ...it };
  const code = (k, map, label) => {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "" && map[Number(o[k])] !== undefined) o[`${label}`] = map[Number(o[k])];
  };
  code("warnVar", WARN_TYPES, "특보종류");
  code("warningType", WARN_TYPES, "특보종류");
  code("warnStress", WARN_STRESS, "특보강도");
  code("command", WARN_COMMAND, "발표구분");
  if (o.stnId !== undefined && WARN_STN[Number(o.stnId)]) o.지점해석 = WARN_STN[Number(o.stnId)];
  return o;
}

/**
 * @param {string} kind WARN_KINDS 키
 * @param {{stnId?, from?, to?, areaCode?, warningType?, rows?}} a
 */
export async function getWarnings(kind, a, meter) {
  const k = WARN_KINDS[kind];
  if (!k) throw new UpstreamError(`kind는 ${Object.keys(WARN_KINDS).join("·")} 중 하나여야 합니다: "${kind}"`, "BAD_PARAM");
  const params = {};
  if (k.needStn && !a.stnId) throw new UpstreamError(`kind=${kind}는 stnId가 필수입니다(${Object.entries(WARN_STN).map(([c, n]) => `${c} ${n}`).join(", ")}).`, "BAD_PARAM");
  if (a.stnId) {
    if (!WARN_STN[Number(a.stnId)]) throw new UpstreamError(`stnId는 ${Object.keys(WARN_STN).join("·")} 중 하나여야 합니다: "${a.stnId}"`, "BAD_PARAM");
    params.stnId = String(a.stnId);
  }
  let from = null;
  let to = null;
  if (k.dated) {
    from = normalizeDate(a.from, "from") || todayKst();
    to = normalizeDate(a.to, "to") || from;
    if (to < from) throw new UpstreamError(`to(${to})가 from(${from})보다 앞입니다.`, "BAD_PARAM");
    if (k.maxBack && daysBetween(from, todayKst()) > k.maxBack) {
      const limit = addDays(todayKst(), -k.maxBack);
      const hint =
        kind === "area"
          ? "그 이전 특보 이력은 이 API로 조회할 수 없습니다(기상청 날씨누리 특보 이력 등 다른 경로 필요)."
          : `그보다 앞 기간은 구역별 특보(kind=area, area_code)로 오늘 기준 60일 전(${addDays(todayKst(), -60)})까지 볼 수 있습니다. 그 이전은 이 API로 조회할 수 없습니다.`;
      throw new UpstreamError(`${k.label}(kind=${kind})은 오늘 기준 ${k.maxBack}일 전(${limit})까지만 조회됩니다(기상청 원천 제한): from=${from}. ${hint}`, "BAD_PARAM");
    }
    params.fromTmFc = from;
    params.toTmFc = to;
  }
  if (kind === "area") {
    if (a.areaCode) params.areaCode = String(a.areaCode).trim();
    if (a.warningType) {
      const t = Number(a.warningType);
      if (!WARN_TYPES[t]) throw new UpstreamError(`warningType은 ${Object.entries(WARN_TYPES).map(([c, n]) => `${c} ${n}`).join(", ")} 중 하나여야 합니다: "${a.warningType}"`, "BAD_PARAM");
      params.warningType = String(t);
    }
  }
  let res;
  let empty = false;
  try {
    res = await fetchAll("WARN", k.op, params, { meter, pageSize: Math.min(Number(a.rows) || 300, 1000), maxPages: 5 });
  } catch (e) {
    if (e.code === "NO_DATA") {
      empty = true;
      res = { items: [], totalCount: 0, complete: true };
    } else throw e;
  }
  return {
    종류: k.label,
    조건: { ...params },
    전체건수: res.totalCount,
    반환건수: res.items.length,
    ...(res.complete ? {} : { 경고: `전체 ${res.totalCount}건 중 ${res.items.length}건만 받았습니다(페이지 상한). 기간·지점·구역을 좁혀 다시 조회하세요.` }),
    ...(empty
      ? { 안내: "자료 없음(코드 03). 특보는 발표가 없던 기간이면 정상적으로 0건입니다. 다만 날짜 형식(YYYYMMDD)·stnId·areaCode가 맞는지 확인하고, 기간을 넓혀 한 번 더 보세요." }
      : {}),
    항목: res.items.map(decorate),
  };
}
