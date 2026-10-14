// kma-weather-mcp / lib/kma.js
//
// 기상청 OpenAPI 호출 공통부. 6개 서비스(단기예보·중기예보·기상특보·관광코스·CCTV 도로날씨·생활기상지수)가
// 모두 이 파일의 kmaCall()을 거친다.
//
// ── 호스트·키 격리 ──────────────────────────────────────────────────────────
// 기상청은 2026년 현재 일부 API를 API허브(apihub.kma.go.kr, authKey)로 옮기는 중이고, 단기예보 명세(260928판)는
// 이미 apihub 주소를 안내한다. 그러나 실측(2026-10-14)으로는 공공데이터포털 공용키(DATA_PORTAL_KEY)가
// apis.data.go.kr 호스트의 특보·중기·단기예보 3개 서비스에서 모두 통했고, apihub 호스트는 그 키로 401이었다.
// 그래서 기본은 data.go.kr이고, 환경변수로 서비스별 호스트를 바꿀 수 있게 이 파일 한 곳에 가둬 두었다.
//   KMA_APIHUB_KEY  : API허브 인증키(authKey). 있어야 apihub 호스트를 쓸 수 있다.
//   KMA_HOST_<서비스키> = apihub  : 해당 서비스만 API허브로 보낸다(예: KMA_HOST_SHORT=apihub).
//
// ── 공통 실측 함정 ─────────────────────────────────────────────────────────
// ★ 결과코드 자릿수가 서비스마다 다르다("0"·"00"). 둘 다 정상이다.
// ★ 0건이면 body.items가 ""로 오고 1건이면 item이 객체로 온다 → asArray().
// ★ 요청 한도(코드 22)는 오퍼레이션별 일일 한도이고 같은 키를 쓰는 서버가 함께 소진한다. 재시도하지 않는다.
// ★ 한 페이지에 얼마나 담아 주는지(numOfRows 상한)는 서비스마다 달라 조용히 잘릴 수 있다.
//   fetchAll()은 응답 건수를 totalCount와 대조해 모자라면 이어 받고, 끝내 모자라면 경고를 돌려준다.

import { UpstreamError, envKey } from "./common.js";
import { dataGoGet, asArray } from "./datago.js";

const DATAGO_BASE = "https://apis.data.go.kr/1360000";
const APIHUB_BASE = "https://apihub.kma.go.kr/api/typ02/openApi";

export const SERVICES = {
  SHORT: { name: "VilageFcstInfoService_2.0", label: "기상청 단기예보(동네예보)" },
  MID: { name: "MidFcstInfoService", label: "기상청 중기예보" },
  WARN: { name: "WthrWrnInfoService", label: "기상청 기상특보" },
  TOUR: { name: "TourStnInfoService1", label: "기상청 관광코스별 관광지 날씨" },
  ROAD: { name: "RoadWthrInfoService", label: "기상청 CCTV 도로날씨" },
  LIVING: { name: "LivingWthrIdxServiceV5", label: "기상청 생활기상지수" },
};

const CODE_MSG = {
  "01": "어플리케이션 에러",
  "02": "데이터베이스 에러",
  "03": "데이터 없음",
  "04": "HTTP 에러",
  "05": "서비스 연결 실패",
  "10": "잘못된 요청 파라미터",
  "11": "필수 요청 파라미터 누락",
  "12": "해당 오픈API 서비스가 없거나 폐기됨",
  "20": "서비스 접근 거부",
  "21": "일시적으로 사용할 수 없는 서비스 키",
  "22": "서비스 요청 제한 횟수 초과(일일 한도 소진)",
  "30": "등록되지 않은 서비스키",
  "31": "기한 만료된 서비스키",
  "32": "등록되지 않은 IP",
  "33": "서명되지 않은 호출",
  "99": "기타 에러",
};

export function hostMode(serviceKey) {
  return String(process.env[`KMA_HOST_${serviceKey}`] || "").trim().toLowerCase() === "apihub" ? "apihub" : "datago";
}

/**
 * 오퍼레이션 1회 호출. 결과코드가 정상이 아니면 UpstreamError.
 * 0건(코드 03)은 NO_DATA로 던진다 — 호출부가 "0건 = 자료 없음"으로 단정하기 전에 매개변수 형식부터 의심하도록
 * 오류 문구에 그 안내를 싣는다.
 * @returns {{header, body, items: object[], totalCount: number}}
 */
export async function kmaCall(svcKey, op, params, { meter, timeoutMs } = {}) {
  const svc = SERVICES[svcKey];
  const source = `${svc.label} ${op}`;
  const apihub = hostMode(svcKey) === "apihub";
  if (apihub && !envKey("KMA_APIHUB_KEY")) {
    throw new UpstreamError(`${svc.label}가 API허브(KMA_HOST_${svcKey}=apihub)로 설정됐는데 KMA_APIHUB_KEY가 없습니다.`, "NO_KEY");
  }
  const url = apihub ? `${APIHUB_BASE}/${svc.name}/${op}` : `${DATAGO_BASE}/${svc.name}/${op}`;
  const r = await dataGoGet(url, { dataType: "JSON", ...params }, {
    meter,
    source,
    timeoutMs,
    ...(apihub ? { keyParam: "authKey", keyEnv: "KMA_APIHUB_KEY" } : {}),
  });
  const code = String(r.header?.resultCode ?? "").trim();
  const norm = code.replace(/^0+(?=\d)/, "").padStart(2, "0"); // "0"→"00", "000"→"00"
  if (norm !== "00") {
    const desc = CODE_MSG[norm] || r.header?.resultMsg || "알 수 없는 오류";
    if (norm === "03") {
      throw new UpstreamError(`${source}: 자료가 없습니다(코드 03). 요청 시각·지점·날짜 형식이 맞는지 먼저 확인하세요 — 0건을 '실제로 없음'으로 읽지 마세요.`, "NO_DATA");
    }
    const kind = norm === "22" ? "RATE_LIMIT" : norm === "30" || norm === "20" ? "UNAPPROVED" : norm === "31" ? "BAD_KEY" : norm === "10" || norm === "11" ? "BAD_PARAM" : "UPSTREAM";
    const tail = kind === "RATE_LIMIT" ? " 재시도하지 말고 내일 다시 조회하세요(오퍼레이션별 일일 한도, 같은 키를 쓰는 서버와 공유)." : "";
    throw new UpstreamError(`${source}: ${r.header?.resultMsg || desc} (코드 ${code} — ${desc}).${tail}`, kind);
  }
  const body = r.body || {};
  return { header: r.header, body, items: asArray(body.items), totalCount: Number(body.totalCount ?? 0) };
}

/**
 * 모든 페이지를 모은다. 서버가 numOfRows를 조용히 깎는 경우를 대비해 받은 건수를 totalCount와 대조한다.
 * @returns {{items: object[], totalCount: number, complete: boolean, pages: number}}
 */
export async function fetchAll(svcKey, op, params, { meter, pageSize = 1000, maxPages = 8 } = {}) {
  let first = await kmaCall(svcKey, op, { ...params, numOfRows: pageSize, pageNo: 1 }, { meter });
  const total = first.totalCount;
  let items = first.items.slice();
  let pages = 1;
  let stride = pageSize;
  if (items.length < total && items.length < pageSize) stride = items.length; // 서버가 상한으로 깎았다
  while (items.length < total && pages < maxPages && stride > 0) {
    pages++;
    const page = Math.floor(items.length / stride) + 1;
    const r = await kmaCall(svcKey, op, { ...params, numOfRows: stride, pageNo: page }, { meter });
    if (!r.items.length) break;
    items = items.concat(r.items);
  }
  return { items, totalCount: total, complete: items.length >= total, pages };
}

export { asArray };
