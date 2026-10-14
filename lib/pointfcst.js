// kma-weather-mcp / lib/pointfcst.js
//
// 단기예보데이터 지점 조회(API허브 typ01 cgi-bin nph-land_fct_shrt_txt) — 위경도 지점의 초단기예보(1시간 간격)를
// 과거 발표분까지 받는다. 격자 API(getUltraSrtFcst)는 최근 발표분만 주므로 '그날 그 시각 예보'는 이것으로 본다.
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ 값은 초단기예보와 같다: 서울 중구 tm=14:00 기온 6시간치가 격자 초단기예보 14:30 발표분(nx60·ny127)과 6개 모두 일치(실측 1건).
//   요소: SKY·RN1·PTY·POP·SNO·VEC·WSD·T1H·LGT.
// ★ tm은 매시(HH00) 다 받는다(가이드는 3시간 간격으로 적었으나 12:00도 응답). 2021-07·2024-01 발표분도 나왔다.
// ★ 발효시각(tmef2)은 tm+6시간까지만 — 넘기면 "<Error>"(실측 tm 11:00 → tmef2 다음날 0시 거부).
// ★ 강수확률(POP)·신적설(SNO)은 과거 발표분에서 nan이다(초단기예보 강수확률은 2026-06-23 11시부터 제공). 매시 정각이 아닌 tm도 nan.
// ★ area(시군구 10자리)를 주면 지점이 아니라 그 시군구 안의 '고속도로 지점'들 예보가 온다(춘천시 → 중앙선-춘천IC 등).
//   서울특별시(1100000000)는 오류였다 → 이 서버는 area를 쓰지 않는다.

import { UpstreamError } from "./common.js";
import { hubGet, csvRows, num, fmt12, tmAdd, SKY_TXT, PTY_TXT } from "./hub.js";

/** tm: YYYYMMDDHH(00) — 발표시각(정시). hours: 1~6 */
export async function pastUltraForecast({ lat, lon, tm, hours = 6 }, meter) {
  const t = String(tm || "").replace(/\D/g, "");
  if (!/^\d{10}(\d{2})?$/.test(t)) throw new UpstreamError(`과거 초단기예보 발표시각은 YYYYMMDDHH(정시)입니다: "${tm}"`, "BAD_PARAM");
  const tm12 = t.slice(0, 10) + "00";
  const h = Math.min(Math.max(Number(hours) || 6, 1), 6);
  const e1 = tmAdd(tm12, 60);
  const e2 = tmAdd(tm12, 60 * h);
  const text = await hubGet(`/typ01/cgi-bin/url/nph-land_fct_shrt_txt?tm=${tm12}&tmef1=${e1}&tmef2=${e2}&lat=${Number(lat)}&lon=${Number(lon)}&help=0&disp=1`, { source: "기상청 API허브 단기예보데이터 지점 조회", meter, timeoutMs: 15000 });
  const rows = csvRows(text)
    .filter((p) => /^\d{12}$/.test(p[0]))
    .map(([tmfc, tmef, la, lo, sky, rn1, pty, pop, sno, vec, wsd, t1h, lgt]) => ({
      발표시각: fmt12(tmfc), 예보시각: fmt12(tmef),
      기온: num(t1h), 하늘상태: SKY_TXT[num(sky)] ?? null, 강수형태: PTY_TXT[num(pty)] ?? null, 강수_1시간mm: num(rn1), 강수확률: num(pop), 신적설_1시간cm: num(sno),
      풍향deg: num(vec), 풍속ms: num(wsd), 낙뢰kA: num(lgt),
    }));
  if (!rows.length) throw new UpstreamError(`그 발표시각(${fmt12(tm12)})의 지점 예보가 없습니다.`, "NO_DATA");
  return {
    종류: "초단기예보(과거 발표분, 지점 조회)", 발표시각: fmt12(tm12), 지점: { lat: Number(lat), lon: Number(lon) },
    시간별: rows,
    안내: "API허브 '단기예보데이터 지점 조회'로 받은 과거 초단기예보다(격자 초단기예보와 같은 값 — 실측 대조). 강수확률·신적설은 과거 발표분에서 비어 있을 수 있다(초단기 강수확률은 2026-06-23부터).",
  };
}
