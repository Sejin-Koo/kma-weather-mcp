// kma-weather-mcp / lib/awszone.js
//
// AWS 지점 ↔ 예보구역·특보구역 매칭(API허브 wrn_reg_aws2.php) — 좌표로 특보구역을 고른다.
//
// ★★ 실측 2026-10-14: v1(wrn_reg_aws.php)은 기준시각을 지금으로 줘도 특보구역 163개 중 현재 구역이 113개뿐이다
//   (2026-05-31 개편 전 구역이 남아 있음, 같은 지점 348곳의 구역코드가 v2와 다름) → v1은 쓰지 않는다.
//   v2는 tm을 반영한다: 지금 기준 235개 구역 전부가 현재 구역이고, tm=2026-05-01이면 개편 전 구역이 나온다(183개 중 현재 129개).
//   → 과거 특보 이력을 좌표로 맞출 때 그 시점 tm을 주면 옛 구역코드가 나온다.
// ★ 현재 기준 육상 특보구역 301개 중 AWS가 하나도 걸리지 않는 66개는 시도·분할된 시군(강릉시→평지·산지 등) 같은 상위 구역이다
//   — 최하위 구역은 모두 AWS가 있다.
// ★ 열(disp=0, CSV): STN_ID,STN_KO,STN_SP,LON,LAT,HT,FCT_ID,WRN_ID,WRN_KO,SFC_STN_ID
// ★ 가장 가까운 AWS의 구역은 '그 AWS의' 구역이다. 구역 경계 부근에서는 이웃 구역일 수 있어 후보(다른 구역의 가까운 AWS)를 함께 준다.

import { UpstreamError } from "./common.js";
import { hubGet, csvRows, distKm } from "./hub.js";

const cache = new Map(); // tmKey → {at, rows}

/** tm: YYYYMMDDHHMI 또는 생략(현재). 같은 날짜 키로 12시간 캐시 */
export async function awsZones(tm, meter) {
  const t = tm ? String(tm).replace(/\D/g, "") : "";
  if (t && !/^\d{8}(\d{4})?$/.test(t)) throw new UpstreamError(`tm은 YYYYMMDD 또는 YYYYMMDDHHMI여야 합니다: "${tm}"`, "BAD_PARAM");
  const tm12 = t.length === 8 ? t + "0900" : t;
  const k = tm12 ? tm12.slice(0, 8) : "now";
  const c = cache.get(k);
  if (c && Date.now() - c.at < 12 * 3600e3) {
    if (meter) meter.cacheHits++;
    return c.rows;
  }
  const text = await hubGet(`/typ01/url/wrn_reg_aws2.php?tm=${tm12}&disp=0&help=0`, { source: "기상청 API허브 AWS-특보구역 매칭(wrn_reg_aws2)", meter, encoding: "euc-kr", timeoutMs: 12000 });
  const rows = csvRows(text)
    .filter((p) => p.length >= 9 && /^\d+$/.test(p[0]))
    .map((p) => ({ aws: Number(p[0]), awsName: p[1], lon: Number(p[3]), lat: Number(p[4]), ht: Number(p[5]), fct: p[6], wrn: p[7], wrnName: p[8], sfc: p[9] ? Number(p[9]) : null }));
  if (!rows.length) throw new UpstreamError("AWS-특보구역 매칭표를 읽지 못했습니다(형식 변경 가능성).", "UPSTREAM");
  if (cache.size > 20) cache.clear();
  cache.set(k, { at: Date.now(), rows });
  return rows;
}

/**
 * 좌표 → 가장 가까운 AWS의 특보구역 + 이웃 구역 후보.
 * @returns {{구역: {특보구역코드, 구역명}, 근거AWS: {...}, 이웃후보: [...], 기준시각}}
 */
export async function zoneByCoord(lat, lon, { tm, meter, maxKm = 25 } = {}) {
  const rows = await awsZones(tm, meter);
  const sorted = rows.map((r) => ({ r, d: distKm(lat, lon, r.lat, r.lon) })).sort((a, b) => a.d - b.d);
  const first = sorted[0];
  if (!first || first.d > maxKm) return null;
  const seen = new Set([first.r.wrn]);
  const nb = [];
  for (const s of sorted.slice(1, 12)) {
    if (s.d > first.d + 8 || nb.length >= 2) break;
    if (seen.has(s.r.wrn)) continue;
    seen.add(s.r.wrn);
    nb.push({ 특보구역코드: s.r.wrn, 구역명: s.r.wrnName, AWS: `${s.r.awsName}(${s.r.aws})`, 거리km: Math.round(s.d * 10) / 10 });
  }
  return {
    구역: { 특보구역코드: first.r.wrn, 구역명: first.r.wrnName },
    근거AWS: { 지점: first.r.aws, 지점명: first.r.awsName, 거리km: Math.round(first.d * 10) / 10, 예보구역코드: first.r.fct, 특보대표지점: first.r.sfc },
    ...(nb.length ? { 이웃후보: nb, 이웃안내: "가장 가까운 AWS와 거리가 비슷한 다른 구역의 AWS다 — 구역 경계 부근이면 함께 보라" } : {}),
    기준시각: tm ? String(tm) : "현재",
  };
}
