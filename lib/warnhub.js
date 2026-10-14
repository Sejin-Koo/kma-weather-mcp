// kma-weather-mcp / lib/warnhub.js
//
// 기상청 API허브 특보·정보 typ01 URL 계열 — 기간을 직접 지정해 과거 이력까지 조회한다.
// (공공데이터포털 특보 서비스는 구역별 60일·목록/본문 6일까지만 조회된다 → lib/warn.js)
//
//   특보구역   wrn_reg.php?tmfc=            (tmfc를 비우면 폐지된 구역까지 전체 이력, tmfc=0은 현재 구역만)
//   특보자료   wrn_met_data.php?reg&wrn&tmfc1&tmfc2&disp=0    특보 발표·해제 이력(구역 단위 행)
//   기상정보   wrn_inf_rpt.php?tmfc1&tmfc2&stn&disp=0          기상정보 문서
//   날씨해설   wthr_cmt_rpt.php?tmfc1&tmfc2&stn&subcd&disp=0   날씨해설 문서(11 초단기·12 단기·13 중기·99 직접입력)
//   특보현황   wrn_now_data_new.php?fe&tm&disp=0               임의 시각(tm) 기준 발효 중 특보·예비특보
//   특보이미지 typ03/cgi/wrn/nph-wrn7?…                        PNG
//
// ── 실측(2026-10-14) ────────────────────────────────────────────────────────
// ★ 7개 모두 API허브 키로 승인 확인. typ01 공통의 간헐 무응답(7~15초 무응답 후 다음엔 1~3초)이 여기서도 난다 → 재시도.
// ★ wrn_met_data는 2015년 자료도 나온다. 2025-01-01~2026-01-01 전 종류 = 27,514행·2.5MB·9.5초,
//   대설(S)만 1년 = 353KB·3초, 전 종류 1개월 = 356KB·2.8초. 잘림은 없었다(마지막 행이 기간 끝까지 옴).
//   → 응답 시간을 지키려고 종류 미지정은 92일, 종류 지정은 366일까지만 한 번에 받는다.
// ★ 특보구역이 2026-05-31에 개편됐다: tmfc 없이 부르면 534개 구역(폐지 구역의 TM_ED=202605311329 포함),
//   tmfc=0이면 현재 414개. 2025년 이력의 구역코드 227개 중 54개가 현재 구역표에 없었다 → 이름·상위구역은
//   반드시 전체 이력 표(tmfc 비움)로 붙인다. 내장 data/warnzones.js(현재 구역)만 쓰면 옛 코드가 '미확인'이 된다.
// ★ wrn_met_data 코드: LVL 1 예비·2 주의보·3 경보·4 중대경보(폭염만) / CMD 1 발표·2 대치·3 해제·4 대치해제(자동)·
//   5 연장·6 변경·7 변경해제 / WRN W 강풍·R 호우·C 한파·D 건조·O 폭풍해일·N 지진해일·V 풍랑·T 태풍·S 대설·Y 황사·H 폭염·F 안개·K 열대야.
// ★ 기상정보·날씨해설 문서는 "$0#발표관서#발표시각#발표번호#입력시각#참조번호#예보관명#입력자명#부제목코드#부제목#" 줄 다음
//   "$1#"부터 "=" 줄까지가 본문이다(마지막 본문 줄 끝에 '#'). 예보관·입력자 이름은 돌려주지 않는다.
// ★ 특보현황(new)은 "#기준시각:YYYYMMDDHHMI" 줄이 먼저 오고, 값은 한글(풍랑·주의·발표)이며 ED_TM(해제예고)이 있다.
//   tm에 과거 시각(예 202601100600)을 주면 그 시각의 발효 현황이 온다.

import { UpstreamError, httpGet, envKey, scrub, nowKst } from "./common.js";

const BASE = "https://apihub.kma.go.kr/api/typ01/url";
const IMG = "https://apihub.kma.go.kr/api/typ03/cgi/wrn/nph-wrn7";

export const WRN_CODE = { W: "강풍", R: "호우", C: "한파", D: "건조", O: "폭풍해일", N: "지진해일", V: "풍랑", T: "태풍", S: "대설", Y: "황사", H: "폭염", F: "안개", K: "열대야" };
const WRN_BY_NAME = Object.fromEntries(Object.entries(WRN_CODE).map(([c, n]) => [n, c]));
export const LVL_CODE = { 1: "예비특보", 2: "주의보", 3: "경보", 4: "중대경보" };
export const CMD_CODE = { 1: "발표", 2: "대치", 3: "해제", 4: "대치해제(자동)", 5: "연장", 6: "변경", 7: "변경해제" };
export const STN_CODE = { 108: "본청(전국)", 109: "수도권", 105: "강원", 131: "청주", 133: "대전", 146: "전주", 156: "광주", 143: "대구", 159: "부산", 184: "제주" };
export const SUBCD = { 11: "초단기", 12: "단기", 13: "중기", 99: "직접입력" };

const pad = (n) => String(n).padStart(2, "0");
const fmt = (t) => (t && /^\d{12}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}` : t || null);
export function nowTm() {
  const d = nowKst();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** YYYYMMDD → YYYYMMDD0000(시작) / YYYYMMDD2359(끝), YYYYMMDDHHMI 그대로 */
export function normTm(v, name, end = false) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const s = String(v).replace(/\D/g, "");
  if (/^\d{8}$/.test(s)) return s + (end ? "2359" : "0000");
  if (/^\d{10}$/.test(s)) return s + (end ? "59" : "00");
  if (/^\d{12}$/.test(s)) return s;
  throw new UpstreamError(`${name}는 YYYYMMDD 또는 YYYYMMDDHHMI여야 합니다: "${v}"`, "BAD_PARAM");
}
const tmToDate = (t) => new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12)));
export const spanDays = (a, b) => (tmToDate(b) - tmToDate(a)) / 86400000;

/** 특보종류 입력 → 코드 목록. "S", "대설", "S,W", "대설 강풍" 모두 허용 */
export function parseWrn(v) {
  if (!v) return [];
  const toks = String(v).split(/[\s,|/·]+/).map((x) => x.trim()).filter(Boolean);
  return toks.map((t) => {
    const u = t.toUpperCase();
    if (WRN_CODE[u]) return u;
    const k = WRN_BY_NAME[t.replace(/(주의보|경보|특보)$/, "")];
    if (k) return k;
    throw new UpstreamError(`특보종류를 알 수 없습니다: "${t}". ${Object.entries(WRN_CODE).map(([c, n]) => `${c} ${n}`).join("·")} 중에서 주세요.`, "BAD_PARAM");
  });
}

async function hubText(url, source, meter, { timeoutMs = 15000, tries = 3 } = {}) {
  const key = envKey("KMA_APIHUB_KEY");
  if (!key) throw new UpstreamError(`${source}는 기상청 API허브 키(KMA_APIHUB_KEY)가 필요합니다.`, "NO_KEY");
  const full = `${url}&authKey=${encodeURIComponent(key)}`;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await httpGet(full, { meter, source, encoding: "euc-kr", timeoutMs });
      if (r.status >= 500) {
        last = new UpstreamError(`${source}: HTTP ${r.status}`, "UPSTREAM");
        continue;
      }
      if (r.status >= 400 || /^\s*\{/.test(r.text)) {
        const kind = r.status === 401 ? "BAD_KEY" : r.status === 403 ? "UNAPPROVED" : r.status === 429 ? "RATE_LIMIT" : "UPSTREAM";
        throw new UpstreamError(`${source}: HTTP ${r.status}${r.status === 403 ? " — API허브에서 이 API 활용신청 승인 여부를 확인하세요" : ""}`, kind);
      }
      if (!r.text.includes("#START7777")) {
        last = new UpstreamError(`${source}: 예상하지 못한 응답: ${scrub(r.text.slice(0, 120))}`, "UPSTREAM");
        continue;
      }
      return r.text;
    } catch (e) {
      if (e.code !== "TIMEOUT" && e.code !== "UPSTREAM") throw e;
      last = e;
    }
  }
  throw new UpstreamError(`${last ? last.message : source + " 응답 없음"} (${tries}회 시도 — API허브 typ01은 간헐적으로 무응답이 난다. 잠시 후 다시 시도)`, last?.code || "UPSTREAM");
}

// ── 특보구역 전체 이력(폐지 구역 포함) — 24시간 캐시 ─────────────────────────
let zoneCache = null;
export async function zoneTable(meter) {
  if (zoneCache && Date.now() - zoneCache.at < 24 * 3600e3) {
    if (meter) meter.cacheHits++;
    return zoneCache.map;
  }
  const text = await hubText(`${BASE}/wrn_reg.php?tmfc=&help=0`, "기상청 API허브 특보구역(wrn_reg)", meter, { timeoutMs: 10000 });
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([LS]\d{7})\s+(\d{12})\s+(\d{12})\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const z = { code: m[1], from: m[2], to: m[3], up: m[5], short: m[6], name: m[7] };
    // 같은 코드가 기간을 달리해 여러 번 있으면 나중(최근) 것을 대표로, 전부는 history에
    const prev = map.get(z.code);
    if (prev) {
      prev.history.push(z);
      if (z.to > prev.to) Object.assign(prev, { ...z, history: prev.history });
    } else map.set(z.code, { ...z, history: [z] });
  }
  if (!map.size) throw new UpstreamError("특보구역 표를 읽지 못했습니다(형식 변경 가능성).", "UPSTREAM");
  zoneCache = { at: Date.now(), map };
  return map;
}
export function zoneLabel(map, code) {
  const z = map.get(code);
  if (!z) return { 구역코드: code, 구역명: null };
  const up = map.get(z.up);
  return {
    구역코드: code, 구역명: z.name, 상위구역: up ? `${up.name}(${up.code})` : z.up,
    ...(z.to < "210001010000" ? { 폐지: `${fmt(z.to)} 폐지된 구역` } : {}),
  };
}
/** 시도급 구역(전국 바로 아래)까지 올라간 코드 */
function province(map, code) {
  for (let c = code, i = 0; c && i < 8; i++) {
    const z = map.get(c);
    if (!z || z.up === "L1000000" || z.up === "00000000" || z.up === c) return c;
    c = z.up;
  }
  return code;
}
const baseName = (s) => String(s || "").replace(/(평지|산지|산간)$/, "");
/** code가 target(또는 그 하위)인지 — 상위 사슬을 따라 올라간다 */
function under(map, code, targets) {
  for (let c = code, i = 0; c && i < 8; i++) {
    if (targets.has(c)) return true;
    const z = map.get(c);
    if (!z || z.up === c) break;
    c = z.up;
  }
  return false;
}

/** 구역 일치 판정기: ①요청 구역과 그 하위(상위 사슬, 폐지 구역 포함) ②같은 시도 안에서 약칭이 같은 이름으로 시작하는 옛·새 구역 */
export function zoneMatcher(map, areaCodes) {
  const targets = new Set(areaCodes);
  const keys = areaCodes
    .map((c) => map.get(c))
    .filter((z) => z && z.up !== "L1000000") // 시도급은 ①로 충분
    .map((z) => ({ prov: province(map, z.code), base: baseName(z.short) }));
  return (code) => {
    if (under(map, code, targets)) return true;
    const z = map.get(code);
    if (!z) return false;
    return keys.some((k) => province(map, code) === k.prov && baseName(z.short).startsWith(k.base));
  };
}
export const ZONE_MATCH_NOTE = "구역은 ①요청 구역과 그 하위(폐지 구역 포함) ②같은 시도 안에서 이름이 같은 옛·새 구역(예: 정선 ↔ 정선평지·정선산간)으로 맞췄다 — 특보구역은 개편(최근 2026-05-31)마다 코드가 바뀐다";

// ── 특보 발표·해제 이력 ──────────────────────────────────────────────────────
export async function warningEvents({ from, to, wrn, areaCodes, levels, commands, limit = 100, order = "desc" }, meter) {
  const tm1 = normTm(from, "from");
  const tm2 = normTm(to, "to", true) || nowTm();
  if (!tm1) throw new UpstreamError("from(조회 시작일, YYYYMMDD)이 필요합니다.", "BAD_PARAM");
  if (tm2 < tm1) throw new UpstreamError(`to(${tm2})가 from(${tm1})보다 앞입니다.`, "BAD_PARAM");
  const types = parseWrn(wrn);
  const maxDays = types.length ? 366 : 92;
  if (spanDays(tm1, tm2) > maxDays + 1)
    throw new UpstreamError(`한 번에 조회할 수 있는 기간은 ${types.length ? "특보종류를 지정하면 366일" : "특보종류 미지정 시 92일(전 종류 1년은 약 2.5MB·27,000행)"}까지입니다: ${fmt(tm1)} ~ ${fmt(tm2)}. ${types.length ? "기간을 나눠 부르세요." : "wrn(예: 대설)을 지정하거나 기간을 나누세요."}`, "BAD_PARAM");
  const map = await zoneTable(meter);
  // 종류를 여러 개 주면 종류마다 부른다(원천 wrn은 한 글자만 받는 것으로 본다)
  const raw = [];
  for (const w of types.length ? types : [""]) {
    const text = await hubText(`${BASE}/wrn_met_data.php?reg=&wrn=${w}&tmfc1=${tm1}&tmfc2=${tm2}&disp=0&help=0`, "기상청 API허브 특보자료(wrn_met_data)", meter, { timeoutMs: 20000 });
    for (const line of text.split(/\r?\n/)) {
      if (!/^\d{12},/.test(line)) continue;
      const f = line.split(",").map((x) => x.trim());
      raw.push({ tmFc: f[0], tmEf: f[1], tmIn: f[2], stn: f[3], reg: f[4], wrn: f[5], lvl: f[6], cmd: f[7] });
    }
  }
  // 구역 필터: ① 요청 코드와 그 하위(상위 사슬 기준, 폐지 구역 포함) ② 같은 시도 안에서 약칭이 같은 이름으로 시작하는 구역
  //   (특보구역은 개편마다 코드가 바뀐다 — 예: 정선 L1021000(~2009) → 정선평지 L1021010·정선산간 L1021020(~2026-05) → 정선 L1022600(현재).
  //    옛 정선평지는 현재 정선의 하위가 아니라 강원도 바로 아래라 ①만으로는 빠진다)
  let rows = raw;
  let areaNote = null;
  let matchedZones = null;
  if (areaCodes && areaCodes.length) {
    const hit = zoneMatcher(map, areaCodes);
    rows = raw.filter((r) => hit(r.reg));
    matchedZones = [...new Set(rows.map((r) => r.reg))].map((c) => `${map.get(c)?.name || c}(${c})`);
    areaNote = ZONE_MATCH_NOTE;
  }
  const lv = levels && levels.length ? new Set(levels.map(String)) : null;
  if (lv) rows = rows.filter((r) => lv.has(r.lvl));
  const cm = commands && commands.length ? new Set(commands.map(String)) : null;
  if (cm) rows = rows.filter((r) => cm.has(r.cmd));

  // 요약: 종류×수준별 '새로 발효된' 행(발표 1·대치 2·변경 6) 수, 구역 수, 첫·마지막
  //   ★ 주의보→경보 격상은 '변경(6)' 명령으로 온다(2026-01 실측: 대설경보 행이 전부 변경) → 발표만 세면 경보가 빠진다
  const issued = rows.filter((r) => r.cmd === "1" || r.cmd === "2" || r.cmd === "6");
  const byType = {};
  for (const r of issued) {
    const k = `${WRN_CODE[r.wrn] || r.wrn} ${LVL_CODE[r.lvl] || r.lvl}`;
    byType[k] = byType[k] || { 발효행수: 0, 구역: new Set(), 첫발표: r.tmFc, 마지막발표: r.tmFc };
    const b = byType[k];
    b.발효행수++;
    b.구역.add(r.reg);
    if (r.tmFc < b.첫발표) b.첫발표 = r.tmFc;
    if (r.tmFc > b.마지막발표) b.마지막발표 = r.tmFc;
  }
  const summary = Object.entries(byType)
    .map(([k, b]) => ({ 특보: k, 발효행수: b.발효행수, 구역수: b.구역.size, 첫발효: fmt(b.첫발표), 마지막발효: fmt(b.마지막발표) }))
    .sort((a, b) => b.발효행수 - a.발효행수);
  const sorted = [...rows].sort((a, b) => (order === "asc" ? a.tmFc.localeCompare(b.tmFc) : b.tmFc.localeCompare(a.tmFc)));
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const list = sorted.slice(0, n).map((r) => ({
    발표시각: fmt(r.tmFc), 발효시각: fmt(r.tmEf), ...zoneLabel(map, r.reg),
    특보종류: WRN_CODE[r.wrn] || r.wrn, 특보수준: LVL_CODE[r.lvl] || r.lvl, 명령: CMD_CODE[r.cmd] || r.cmd, 발표관서: STN_CODE[r.stn] || r.stn,
  }));
  return {
    조건: { 기간: `${fmt(tm1)} ~ ${fmt(tm2)}`, 특보종류: types.length ? types.map((t) => WRN_CODE[t]) : "전체", ...(areaCodes?.length ? { 구역: areaCodes } : {}), ...(lv ? { 수준: [...lv].map((x) => LVL_CODE[x]) } : {}), ...(cm ? { 명령: [...cm].map((x) => CMD_CODE[x]) } : {}) },
    전체행수: rows.length,
    반환행수: list.length,
    ...(rows.length > list.length ? { 잘림: `전체 ${rows.length}행 중 ${list.length}행만 목록으로 돌려줬다(요약은 전체 기준). limit(최대 500)·구역·종류로 좁히세요.` } : {}),
    발효요약: summary,
    ...(areaNote ? { 구역안내: areaNote, 맞춘구역: matchedZones } : {}),
    안내: "행은 특보구역 단위다(한 번의 발표가 여러 구역 행으로 나온다). 발효요약은 새로 발효된 행(발표·대치·변경 — 주의보→경보 격상은 '변경'으로 온다)을 종류×수준별로 센 것이고 해제·연장은 목록에만 있다. 같은 구역의 같은 특보가 여러 번 발표될 수 있으니 '횟수'로 답할 때는 구역수·시각을 함께 본다.",
    목록: list,
  };
}

// ── 특정 시각 특보현황 ───────────────────────────────────────────────────────
export async function warningStatusAt({ tm, fe = "f", limit = 100 }, meter) {
  const t = tm ? normTm(tm, "tm") : "";
  const text = await hubText(`${BASE}/wrn_now_data_new.php?fe=${fe === "e" ? "e" : "f"}&tm=${t}&disp=0&help=0`, "기상청 API허브 특보현황(wrn_now_data_new)", meter, { timeoutMs: 10000 });
  const base = (text.match(/#기준시각:\s*(\d{12})/) || [])[1] || t || null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^[LS]\d{7},/.test(line)) continue;
    const f = line.replace(/,\s*=\s*$/, "").split(",").map((x) => x.trim());
    rows.push({ 상위구역: `${f[1]}(${f[0]})`, 구역코드: f[2], 구역명: f[3], 발표시각: fmt(f[4]), 발효시각: fmt(f[5]), 특보종류: f[6], 특보수준: f[7], 명령: f[8], 해제예고: f[9] || null });
  }
  const groups = {};
  for (const r of rows) {
    const k = `${r.특보종류} ${r.특보수준}`;
    (groups[k] = groups[k] || []).push(r.구역명);
  }
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return {
    기준시각: fmt(base), 기준: fe === "e" ? "발효시각 기준" : "발표시각 기준", 구역행수: rows.length,
    종류별구역: Object.entries(groups).map(([k, v]) => ({ 특보: k, 구역수: v.length, 구역: v })),
    안내: "특보수준이 '예비'인 행은 예비특보이며 발효시각이 시간대 대표값(예: 05:59 = 새벽 03~06시)이다. 종류별구역은 전체 기준이다.",
    ...(rows.length > n ? { 잘림: `목록은 전체 ${rows.length}행 중 ${n}행만(limit 최대 500). 종류별구역은 전체.` } : {}),
    목록: rows.slice(0, n),
  };
}

// ── 기상정보·날씨해설 문서 ───────────────────────────────────────────────────
function parseDocs(text) {
  const docs = [];
  let cur = null;
  let inBody = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("$0#")) {
      const f = line.split("#");
      cur = { 발표관서: STN_CODE[f[1]] ? `${STN_CODE[f[1]]}(${f[1]})` : f[1], stn: f[1], 발표시각: fmt(f[2]), tmFc: f[2], 발표번호: f[3], 부제목코드: f[8], 제목: (f[9] || "").trim(), 본문: [] };
      docs.push(cur);
      inBody = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("$1#")) {
      inBody = true;
      const rest = line.slice(3);
      if (rest.trim()) cur.본문.push(rest);
      continue;
    }
    if (line.trim() === "=") {
      inBody = false;
      continue;
    }
    if (inBody) cur.본문.push(line);
  }
  for (const d of docs) d.본문 = d.본문.join("\n").replace(/#\s*$/, "").trim();
  return docs;
}

export async function weatherDocs({ kind, from, to, stn, subcd, query, limit = 10, maxChars = 1500 }, meter) {
  const tm1 = normTm(from, "from") || nowTm().slice(0, 8) + "0000";
  const tm2 = normTm(to, "to", true) || nowTm();
  if (tm2 < tm1) throw new UpstreamError(`to(${tm2})가 from(${tm1})보다 앞입니다.`, "BAD_PARAM");
  if (spanDays(tm1, tm2) > 32) throw new UpstreamError(`문서 조회는 한 번에 31일까지입니다(기상정보 4일 ≈ 150KB): ${fmt(tm1)} ~ ${fmt(tm2)}. 기간을 나누세요.`, "BAD_PARAM");
  if (stn && !STN_CODE[Number(stn)]) throw new UpstreamError(`stn은 ${Object.entries(STN_CODE).map(([c, n]) => `${c} ${n}`).join("·")} 중 하나입니다: "${stn}"`, "BAD_PARAM");
  const isCmt = kind === "commentary";
  if (subcd && !SUBCD[Number(subcd)]) throw new UpstreamError(`subcd는 11 초단기·12 단기·13 중기·99 직접입력 중 하나입니다: "${subcd}"`, "BAD_PARAM");
  const url = isCmt
    ? `${BASE}/wthr_cmt_rpt.php?tmfc1=${tm1}&tmfc2=${tm2}&stn=${stn || 0}&subcd=${subcd || 0}&disp=0&help=0`
    : `${BASE}/wrn_inf_rpt.php?tmfc1=${tm1}&tmfc2=${tm2}&stn=${stn || 0}&disp=0&help=0`;
  const text = await hubText(url, `기상청 API허브 ${isCmt ? "날씨해설(wthr_cmt_rpt)" : "기상정보(wrn_inf_rpt)"}`, meter, { timeoutMs: 20000 });
  let docs = parseDocs(text);
  // 원천이 stn·subcd를 거르지 않을 때를 대비해 서버에서도 거른다
  if (stn) docs = docs.filter((d) => d.stn === String(Number(stn)));
  if (isCmt && subcd) docs = docs.filter((d) => d.부제목코드 === String(Number(subcd)));
  if (query) {
    const q = String(query).replace(/\s+/g, "");
    docs = docs.filter((d) => (d.제목 + d.본문).replace(/\s+/g, "").includes(q));
  }
  docs.sort((a, b) => b.tmFc.localeCompare(a.tmFc));
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const mc = Number(maxChars);
  const out = docs.slice(0, n).map(({ stn: _s, tmFc: _t, 부제목코드, ...d }) => {
    const cut = mc > 0 && d.본문.length > mc;
    return { ...d, ...(isCmt ? { 구분: SUBCD[Number(부제목코드)] || 부제목코드 } : {}), 본문: cut ? d.본문.slice(0, mc) + " …" : d.본문, ...(cut ? { 본문잘림: `${d.본문.length}자 중 ${mc}자 — max_chars=0이면 전문` } : {}) };
  });
  return {
    종류: isCmt ? "날씨해설" : "기상정보",
    조건: { 기간: `${fmt(tm1)} ~ ${fmt(tm2)}`, 발표관서: stn ? STN_CODE[Number(stn)] : "전체", ...(isCmt && subcd ? { 구분: SUBCD[Number(subcd)] } : {}), ...(query ? { 검색어: query } : {}) },
    전체건수: docs.length, 반환건수: out.length,
    ...(docs.length > out.length ? { 잘림: `전체 ${docs.length}건 중 최근 ${out.length}건만 돌려줬다. limit(최대 50)·stn·query로 좁히세요.` } : {}),
    문서: out,
  };
}

// ── 특보 이미지 ──────────────────────────────────────────────────────────────
export async function warningImage({ tm, lat, lon, range = 300, size = 685, tmef = 1, wrn, stn }, meter) {
  const key = envKey("KMA_APIHUB_KEY");
  if (!key) throw new UpstreamError("특보 이미지는 기상청 API허브 키(KMA_APIHUB_KEY)가 필요합니다.", "NO_KEY");
  const t = tm ? normTm(tm, "tm") : nowTm();
  const types = parseWrn(wrn);
  const w = (types.length ? types : ["W", "R", "C", "D", "O", "V", "T", "S", "Y", "H"]).join(",") + ",";
  const sz = Math.min(Math.max(Number(size) || 685, 200), 1000);
  const rg = Math.min(Math.max(Number(range) || 300, 20), 1000);
  let q = `out=0&tmef=${Number(tmef) === 0 ? 0 : 1}&city=1&name=0&tm=${t}&size=${sz}&wrn=${w}`;
  if (stn) q += `&stn=${Number(stn)}`;
  else q += `&lon=${Number(lon ?? 127.7)}&lat=${Number(lat ?? 36.1)}&range=${rg}`;
  const url = `${IMG}?${q}&authKey=${encodeURIComponent(key)}`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await httpGet(url, { meter, source: "기상청 API허브 특보이미지(nph-wrn7)", timeoutMs: 15000, binary: true });
      if (r.status >= 400) {
        last = new UpstreamError(`특보이미지: HTTP ${r.status}`, r.status === 403 ? "UNAPPROVED" : "UPSTREAM");
        if (r.status < 500) throw last;
        continue;
      }
      if (!/^image\//.test(r.contentType || "") || r.buf.byteLength < 500) {
        last = new UpstreamError(`특보이미지: 이미지가 아닌 응답(${r.contentType || "?"}, ${r.buf.byteLength}B)`, "UPSTREAM");
        continue;
      }
      return { base64: Buffer.from(r.buf).toString("base64"), mimeType: r.contentType.split(";")[0], bytes: r.buf.byteLength, tm: fmt(t) };
    } catch (e) {
      if (e.code !== "TIMEOUT" && e.code !== "UPSTREAM") throw e;
      last = e;
    }
  }
  throw new UpstreamError(`${last ? last.message : "특보이미지 응답 없음"} (3회 시도 — 간헐 무응답일 수 있으니 잠시 후 다시)`, last?.code || "UPSTREAM");
}
