// kma-weather-mcp / lib/short.js
//
// 단기예보 서비스(VilageFcstInfoService_2.0) — 초단기실황·초단기예보·단기예보·예보버전.
//
// ── 발표시각 규칙(명세) ─────────────────────────────────────────────────────
//   초단기실황(getUltraSrtNcst)  base_time = HH00, 매시 정각 생성·HH:10 이후 제공
//   초단기예보(getUltraSrtFcst)  base_time = HH30, 매시 30분 생성·HH:45 이후 제공(6시간 앞까지)
//   단기예보(getVilageFcst)      base_time = 0200·0500·0800·1100·1400·1700·2000·2300, 각 +10분 이후 제공
// 사용자가 base_date/base_time을 주지 않으면 지금(KST) 기준으로 제공 가능한 가장 최근 발표시각을 고른다.
// 고른 시각에 자료가 없으면(코드 03) 한 발표 이전으로 한 번 물러선다.
//
// ── 값 해석(명세) ───────────────────────────────────────────────────────────
//   결측 ±900 이하/이상(-900, -999, 900 …)은 null로 바꾼다. 해상 격자는 마스킹되어 값이 없다.
//   SKY 1 맑음·3 구름많음·4 흐림 / PTY 0 없음·1 비·2 비/눈·3 눈·4 소나기(초단기 5 빗방울·6 빗방울눈날림·7 눈날림)
//   PCP·SNO·WSD는 단기예보에서 범주형 문자열("강수없음", "1.0mm 미만", "30~50mm" …)이라 문자열 그대로 둔다.
//   VEC(풍향)는 도, UUU 동서·VVV 남북 바람성분(m/s).
//
// ── 실측 메모(2026-10-14) ───────────────────────────────────────────────────
// ★★ 2026-10-14 10:50(KST) 실측: 공공데이터포털 단기예보 피드(getVilageFcst)에 그날 0200 발표분만 있고 0500·0800 발표분이 없었다
//   (코드 03). 전날·전전날은 8개 발표시각이 모두 있었고(행수 798~1,052) 같은 시각 초단기실황·초단기예보는 정상이었다.
//   원인은 확정하지 못했다(포털 피드 지연 또는 API허브 이전 과도기). 그래서 최신 발표시각에 자료가 없으면 최대 6발표 전까지
//   물러서며, 물러선 경우 메타.발표지연안내에 어느 발표분을 썼는지 적는다.
// ★ getFcstVersion은 해당 발표분이 없으면 version을 "19700101090000"(에포크)로 돌려준다 — 이 값이 '발표 없음' 신호다.
// ★ 한 격자의 단기예보는 약 800~1,000행이다. 한 페이지 상한이 조용히 깎일 수 있어 fetchAll()이 totalCount와 대조한다.

import { UpstreamError, toNum, nowKst, fmtYmd, addDays, dashed } from "./common.js";
import { kmaCall, fetchAll } from "./kma.js";

export const SHORT_BASE_TIMES = ["0200", "0500", "0800", "1100", "1400", "1700", "2000", "2300"];

const CAT = {
  T1H: ["기온", "℃"], TMP: ["기온", "℃"], TMN: ["일최저기온", "℃"], TMX: ["일최고기온", "℃"],
  RN1: ["1시간강수량", "mm"], PCP: ["1시간강수량", ""], SNO: ["1시간신적설", ""], POP: ["강수확률", "%"],
  REH: ["습도", "%"], WSD: ["풍속", "m/s"], VEC: ["풍향", "deg"], UUU: ["동서바람성분", "m/s"], VVV: ["남북바람성분", "m/s"],
  WAV: ["파고", "M"], SKY: ["하늘상태", ""], PTY: ["강수형태", ""], LGT: ["낙뢰", "kA"],
};
const SKY = { 1: "맑음", 3: "구름많음", 4: "흐림" };
const PTY = { 0: "없음", 1: "비", 2: "비/눈", 3: "눈", 4: "소나기", 5: "빗방울", 6: "빗방울눈날림", 7: "눈날림" };
const STRING_CATS = new Set(["PCP", "SNO"]);

function val(category, raw) {
  if (raw === undefined || raw === null) return null;
  if (STRING_CATS.has(category)) return String(raw).trim() || null;
  const n = toNum(raw);
  if (n === null) return null;
  if (n <= -900 || n >= 900) return null; // 결측
  return n;
}

function hhmm(t) {
  const s = String(t).padStart(4, "0");
  return `${s.slice(0, 2)}:${s.slice(2)}`;
}

/** 지금(KST)에서 제공 가능한 가장 최근 발표시각 */
export function pickBase(kind, now = nowKst()) {
  const ymd = fmtYmd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (kind === "short") {
    const avail = minutes - 10; // 각 발표 +10분 이후
    let best = null;
    for (const t of SHORT_BASE_TIMES) {
      const m = +t.slice(0, 2) * 60;
      if (m <= avail) best = t;
    }
    if (best) return { base_date: ymd, base_time: best };
    return { base_date: addDays(ymd, -1), base_time: "2300" };
  }
  if (kind === "ultra") {
    // HH30 발표, HH:45 이후 제공
    let h = now.getUTCHours();
    let d = ymd;
    if (now.getUTCMinutes() < 45) {
      h -= 1;
      if (h < 0) { h = 23; d = addDays(ymd, -1); }
    }
    return { base_date: d, base_time: `${String(h).padStart(2, "0")}30` };
  }
  // nowcast: HH00, HH:10 이후
  let h = now.getUTCHours();
  let d = ymd;
  if (now.getUTCMinutes() < 10) {
    h -= 1;
    if (h < 0) { h = 23; d = addDays(ymd, -1); }
  }
  return { base_date: d, base_time: `${String(h).padStart(2, "0")}00` };
}

/** 한 발표 이전 */
function previousBase(kind, b) {
  if (kind === "short") {
    const i = SHORT_BASE_TIMES.indexOf(b.base_time);
    if (i > 0) return { base_date: b.base_date, base_time: SHORT_BASE_TIMES[i - 1] };
    return { base_date: addDays(b.base_date, -1), base_time: "2300" };
  }
  const h = +b.base_time.slice(0, 2);
  const mm = b.base_time.slice(2);
  if (h > 0) return { base_date: b.base_date, base_time: `${String(h - 1).padStart(2, "0")}${mm}` };
  return { base_date: addDays(b.base_date, -1), base_time: `23${mm}` };
}

const OPS = { now: "getUltraSrtNcst", ultra: "getUltraSrtFcst", short: "getVilageFcst" };
export const KIND_LABEL = { now: "초단기실황", ultra: "초단기예보", short: "단기예보" };

function label(category, v) {
  if (v === null) return null;
  if (category === "SKY") return SKY[v] ?? null;
  if (category === "PTY") return PTY[v] ?? null;
  return null;
}

/**
 * 한 격자·한 종류 조회.
 * @param {"now"|"ultra"|"short"} kind
 */
export async function getShort(kind, { nx, ny, base_date, base_time }, meter) {
  let base = base_date && base_time ? { base_date, base_time } : base_date || base_time ? { ...pickBase(kind), ...(base_date ? { base_date } : {}), ...(base_time ? { base_time } : {}) } : pickBase(kind);
  const userFixed = !!(base_date && base_time);
  const op = OPS[kind];
  let res;
  const tried = [];
  const expected = `${base.base_date} ${base.base_time}`;
  const maxBack = kind === "short" ? 6 : 3; // 포털 피드가 지연되면 몇 발표 전까지 물러선다
  for (let attempt = 0; attempt <= maxBack; attempt++) {
    tried.push(`${base.base_date} ${base.base_time}`);
    try {
      res = await fetchAll("SHORT", op, { base_date: base.base_date, base_time: base.base_time, nx, ny }, { meter, pageSize: kind === "short" ? 1000 : 300 });
      break;
    } catch (e) {
      if (e.code === "NO_DATA" && !userFixed && attempt < maxBack) {
        base = previousBase(kind, base);
        continue;
      }
      if (e.code === "NO_DATA") e.message += ` (시도한 발표시각: ${tried.join(", ")})`;
      throw e;
    }
  }
  const usedBase = `${base.base_date} ${base.base_time}`;
  const items = res.items;
  const meta = {
    종류: KIND_LABEL[kind],
    발표시각: `${dashed(base.base_date)} ${hhmm(base.base_time)}`,
    격자: { nx, ny },
    시도한발표시각: tried,
    ...(!userFixed && usedBase !== expected ? { 발표지연안내: `제공 가능해야 할 최신 발표(${expected})가 기상청 피드에 없어 ${usedBase} 발표분을 썼습니다. 기상청 쪽 발표 지연일 수 있으니 중요한 판단에는 발표시각을 확인하세요.` } : {}),
    행수: items.length,
    전체행수: res.totalCount,
    ...(res.complete ? {} : { 경고: `응답 ${items.length}행이 전체 ${res.totalCount}행에 못 미칩니다(한 페이지 상한). 시각 일부가 빠졌을 수 있습니다.` }),
  };
  if (kind === "now") {
    const obs = {};
    for (const it of items) {
      const c = it.category;
      const v = val(c, it.obsrValue);
      const [nm, unit] = CAT[c] || [c, ""];
      obs[nm] = v;
      if (unit && v !== null) obs[`${nm}_단위`] = unit;
      const lb = label(c, v);
      if (lb) obs[`${nm}_해석`] = lb;
    }
    return { 메타: meta, 관측: obs };
  }
  // 예보 — 시각별로 피벗
  const by = new Map();
  for (const it of items) {
    const key = `${it.fcstDate}${String(it.fcstTime).padStart(4, "0")}`;
    if (!by.has(key)) by.set(key, { 일자: it.fcstDate, 시각: hhmm(it.fcstTime), _v: {} });
    const row = by.get(key);
    const c = it.category;
    const v = val(c, it.fcstValue);
    row._v[c] = v;
  }
  const hourly = [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, r]) => {
      const o = { 일자: dashed(r.일자), 시각: r.시각 };
      for (const [c, v] of Object.entries(r._v)) {
        const [nm] = CAT[c] || [c];
        if (c === "TMN" || c === "TMX") continue; // 일별 요약에서 다룬다
        o[nm] = v;
        const lb = label(c, v);
        if (lb) o[`${nm}_해석`] = lb;
      }
      return o;
    });
  // 일별 요약 (단기예보에서만 의미 있다)
  const daily = [];
  if (kind === "short") {
    const days = new Map();
    for (const it of items) {
      const d = it.fcstDate;
      if (!days.has(d)) days.set(d, { tmp: [], tmn: null, tmx: null, pop: [], sky: {}, pty: new Set(), wsd: [] });
      const g = days.get(d);
      const v = val(it.category, it.fcstValue);
      if (v === null) continue;
      const t = String(it.fcstTime).padStart(4, "0");
      if (it.category === "TMP") g.tmp.push(v);
      else if (it.category === "TMN") g.tmn = v;
      else if (it.category === "TMX") g.tmx = v;
      else if (it.category === "POP") g.pop.push(v);
      else if (it.category === "SKY" && (t === "0900" || t === "1500")) g.sky[t] = SKY[v] ?? v;
      else if (it.category === "PTY" && v !== 0) g.pty.add(PTY[v] ?? v);
      else if (it.category === "WSD") g.wsd.push(v);
    }
    for (const [d, g] of [...days.entries()].sort()) {
      daily.push({
        일자: dashed(d),
        최저기온: g.tmn ?? (g.tmp.length ? Math.min(...g.tmp) : null),
        최고기온: g.tmx ?? (g.tmp.length ? Math.max(...g.tmp) : null),
        최저최고출처: g.tmn !== null || g.tmx !== null ? "TMN/TMX 값" : "시간별 기온의 최소·최대(TMN/TMX 없음)",
        강수확률_최대: g.pop.length ? Math.max(...g.pop) : null,
        하늘상태_09시: g.sky["0900"] ?? null,
        하늘상태_15시: g.sky["1500"] ?? null,
        강수형태: g.pty.size ? [...g.pty] : ["없음"],
        풍속_최대: g.wsd.length ? Math.max(...g.wsd) : null,
        시간별자료수: g.tmp.length,
      });
    }
  }
  return { 메타: meta, ...(daily.length ? { 일별요약: daily } : {}), 시간별: hourly };
}

/** 예보버전 조회 — ftype ODAM(초단기실황)·VSRT(초단기예보)·SHRT(단기예보), basedatetime 12자리(YYYYMMDDHHMM) */
export async function getVersion(ftype, basedatetime, meter) {
  const t = String(ftype || "").toUpperCase();
  if (!["ODAM", "VSRT", "SHRT"].includes(t)) throw new UpstreamError(`ftype은 ODAM·VSRT·SHRT 중 하나여야 합니다: "${ftype}"`, "BAD_PARAM");
  const bd = String(basedatetime || "").replace(/\D/g, "");
  if (!/^\d{12}$/.test(bd)) throw new UpstreamError(`basedatetime은 12자리(YYYYMMDDHHMM)여야 합니다: "${basedatetime}"`, "BAD_PARAM");
  const r = await kmaCall("SHORT", "getFcstVersion", { numOfRows: 10, pageNo: 1, ftype: t, basedatetime: bd }, { meter });
  return { 종류: t, 기준시각: bd, 항목: r.items };
}
