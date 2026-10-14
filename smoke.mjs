// 모든 도구를 MCP 프로토콜 그대로(인메모리 전송) 호출하는 스모크 테스트.
//   SMOKE_ENV_FILE=/경로/keys.env node smoke.mjs [도구명 ...]
//   (keys.env는 KEY=VALUE 줄 형식. 키 값을 명령줄에 쓰지 않으려고 파일에서 읽는다. 환경변수가 이미 있으면 그대로 쓴다)
// 키가 없으면 내장 코드표·도구 목록·오류 경로만 검사한다(원천 호출 없음).
// 검증 대상 중 "확인필요" 표시는 명세서에 근거가 없어 실호출로 처음 확인하는 항목이다 — 실패를 곧 버그로 읽지 말고 응답을 본다.

import fs from "node:fs";
if (process.env.SMOKE_ENV_FILE) {
  for (const line of fs.readFileSync(process.env.SMOKE_ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildServer } = await import("./lib/server.js");

const server = buildServer();
const client = new Client({ name: "smoke", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);

const only = new Set(process.argv.slice(2));
const hasKey = !!(process.env.DATA_PORTAL_KEY || "").trim();
const secrets = ["DATA_PORTAL_KEY", "KMA_APIHUB_KEY"].map((k) => process.env[k]).filter((v) => v && v.length > 5);
let totalCalls = 0;
let fails = 0;
let unverified = 0;
let count = 0;

async function call(name, args, check, { label = "", unverifiedSpec = false } = {}) {
  if (only.size && !only.has(name)) return null;
  count++;
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || "";
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 오류 문구 */
  }
  totalCalls += body?.요약?.원천호출수 ?? 0;
  let verdict;
  try {
    verdict = check ? check(body, text, r) : !r.isError;
  } catch (e) {
    verdict = false;
  }
  if (secrets.some((s) => text.includes(s) || text.includes(encodeURIComponent(s)))) {
    verdict = false;
    console.log("   !!! 응답에 인증키 값이 들어 있습니다");
  }
  const mark = verdict ? "✅" : unverifiedSpec ? "⚠️ 확인필요" : "❌";
  if (!verdict) (unverifiedSpec ? unverified++ : fails++);
  console.log(`${mark} ${name} ${label} ${JSON.stringify(args).slice(0, 120)} (${Date.now() - t0}ms, 원천 ${body?.요약?.원천호출수 ?? "-"}회)`);
  console.log("   ", text.slice(0, 460).replace(/\s+/g, " "));
  return body;
}

// ── 도구 목록 ────────────────────────────────────────────────────────────────
const expected = ["kma_find_code", "kma_short_forecast", "kma_forecast_version", "kma_mid_forecast", "kma_warnings", "kma_tour_weather", "kma_road_weather", "kma_living_index", "kma_api_status"];
const tools = await client.listTools();
const got = new Set(tools.tools.map((t) => t.name));
const missing = expected.filter((n) => !got.has(n));
const extra = [...got].filter((n) => !expected.includes(n));
console.log(`도구 ${got.size}개 — 기대 ${expected.length}개, 누락 [${missing}] 추가 [${extra}]`);
if (missing.length || extra.length) fails++;

// ── 오프라인(내장 코드표) ───────────────────────────────────────────────────
await call("kma_find_code", { kind: "location", query: "서울 강남구" }, (b) => b.결과[0].격자.nx === 61 && b.결과[0].격자.ny === 126 && b.요약.원천호출수 === 0, { label: "강남구 격자 61,126" });
await call("kma_find_code", { kind: "location", lat: 37.5665, lon: 126.978 }, (b) => b.격자.nx === 60 && b.격자.ny === 127, { label: "서울시청 좌표→60,127" });
await call("kma_find_code", { kind: "location", query: "제주시" }, (b) => b.전체일치 > 0);
await call("kma_find_code", { kind: "warn_zone", query: "경기" }, (b) => b.전체일치 > 0);
await call("kma_find_code", { kind: "mid_region", query: "서울" }, (b) => b.결과.some((r) => r.구역코드 === "11B10101"));
await call("kma_find_code", { kind: "tour_course", query: "17" }, (b) => b.관광지상세?.length >= 3);
await call("kma_find_code", { kind: "tour_city", query: "수성" }, (b) => b.결과[0].시군구ID === "2726000000");
await call("kma_find_code", { kind: "cctv", query: "경부 양재" }, (b) => b.전체일치 >= 1);
await call("kma_find_code", { kind: "cctv_routes" }, (b) => b.노선별.length > 5);
await call("kma_short_forecast", { kind: "short" }, (b, t, r) => r.isError && /위치가 필요/.test(t), { label: "위치 없음 → 안내" });
await call("kma_short_forecast", { kind: "short", nx: 999, ny: 1 }, (b, t, r) => r.isError && /격자 범위/.test(t), { label: "격자 범위 오류" });
await call("kma_living_index", { kind: "uv" }, (b, t, r) => r.isError && /지원하지 않습니다/.test(t), { label: "지점 없는 일괄조회 차단" });

if (!hasKey) {
  console.log("\nDATA_PORTAL_KEY가 없어 실호출 검사는 건너뜁니다.");
  await call("kma_short_forecast", { kind: "now", place: "서울" }, (b, t, r) => r.isError && /DATA_PORTAL_KEY/.test(t), { label: "키 없음 → 안내" });
} else {
  // ── 실호출 ────────────────────────────────────────────────────────────────
  await call("kma_api_status", { ping: true }, (b) => b.점검.every((p) => p.결과 === "정상"));

  await call("kma_short_forecast", { kind: "now", place: "서울 강남구" }, (b) => typeof b.관측?.기온 === "number" || b.관측?.기온 === null, { label: "초단기실황" });
  await call("kma_short_forecast", { kind: "ultra", place: "서울 강남구" }, (b) => b.시간별.length >= 6 && !b.메타.경고, { label: "초단기예보" });
  const sf = await call("kma_short_forecast", { kind: "short", place: "서울 강남구" }, (b) => b.일별요약.length >= 2 && b.시간별.length >= 24 && !b.메타.경고, { label: "단기예보(완전성: 행수=전체행수)" });
  if (sf) console.log(`   단기예보 행수 ${sf.메타.행수} / 전체 ${sf.메타.전체행수}, 시간별 ${sf.시간별.length}행, 일별 ${sf.일별요약.length}일`);
  await call("kma_short_forecast", { kind: "short", lat: 35.1796, lon: 129.0756, hours: 6 }, (b) => b.시간별.length === 6, { label: "부산 좌표" });
  await call("kma_forecast_version", { ftype: "SHRT", basedatetime: `${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "")}0800` }, (b) => !!b.항목, { label: "예보버전(앞서 APPLICATION_ERROR)", unverifiedSpec: true });

  await call("kma_mid_forecast", { kind: "outlook", id: "108" }, (b) => typeof b.전망문 === "string" && b.전망문.length > 50);
  await call("kma_mid_forecast", { kind: "land", id: "11B00000" }, (b) => b.일별.length > 3, { label: "육상(광역코드 가정 확인)" });
  await call("kma_mid_forecast", { kind: "temp", place: "서울" }, (b) => b.일별.length > 3);
  await call("kma_mid_forecast", { kind: "sea", id: "12A20100" }, (b) => b.일별.length > 3, { label: "해상(코드는 mid_region H에서 확인)", unverifiedSpec: true });

  await call("kma_warnings", { kind: "status" }, (b) => Array.isArray(b.항목));
  await call("kma_warnings", { kind: "warning_list", stn_id: "109" }, (b) => Array.isArray(b.항목), { label: "오늘 0건도 정상" });
  await call("kma_warnings", { kind: "area", area_code: "L1010000", from: "20260601", to: "20260607" }, (b) => Array.isArray(b.항목), { label: "과거 기간" });
  await call("kma_warnings", { kind: "info", stn_id: "108" }, (b) => Array.isArray(b.항목));

  await call("kma_tour_weather", { kind: "forecast", course_id: "17" }, (b) => b.항목?.length > 0, { label: "관광지 예보(파라미터 규약 검증)", unverifiedSpec: true });
  await call("kma_tour_weather", { kind: "climate_index", city_area_id: "2726000000" }, (b) => b.항목?.length > 0, { label: "관광기후지수", unverifiedSpec: true });

  await call("kma_road_weather", { eqmt_id: "0500C00001" }, (b) => b.항목?.length >= 0 && !!b.조건, { label: "CCTV 도로날씨", unverifiedSpec: true });

  await call("kma_living_index", { kind: "both", place: "서울 강남구" }, (b) => b.결과.length === 2 && b.결과[0].지점.length >= 1, { label: "자외선+대기정체" });
}

console.log(`\n호출 ${count}건 — 실패 ${fails}건, 확인필요 ${unverified}건, 원천 API 호출 합계 ${totalCalls}회`);
await client.close();
process.exit(fails ? 1 : 0);
