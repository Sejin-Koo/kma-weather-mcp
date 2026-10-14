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
const expected = ["kma_find_code", "kma_short_forecast", "kma_forecast_version", "kma_mid_forecast", "kma_warnings", "kma_warning_history", "kma_warning_map", "kma_forecast_text", "kma_impact_forecast", "kma_highway_weather", "kma_tour_weather", "kma_road_weather", "kma_living_index", "kma_uv_observation", "kma_api_status"];
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
await call("kma_find_code", { kind: "location", query: "광주 북구" }, (b) => b.결과[0].중기예보구역_추정.중기기온.구역코드 === "11F20501" && b.결과[0].특보구역_추정.every((w) => w.특보구역코드 !== "L1013400"), { label: "전남광주통합 → 광주광역시 구역(경기 광주 아님)" });
await call("kma_find_code", { kind: "cctv_routes" }, (b) => b.노선별.length > 5);
await call("kma_find_code", { kind: "location", query: "광주광역시" }, (b) => b.결과[0].지역 === "전남광주통합특별시 서구", { label: "옛 광주광역시 → 서구(무안 좌표 아님)" });
await call("kma_find_code", { kind: "fcst_text_region", query: "춘천" }, (b) => b.결과.some((r) => r.코드 === "11D10301"));
await call("kma_find_code", { kind: "highway", query: "경부 기흥" }, (b) => b.결과.some((r) => r.지점 === "기흥IC" && r.노선코드 === "01" && r.실황지점코드 === "010137"));
await call("kma_find_code", { kind: "highway_route" }, (b) => b.노선.length === 17 && b.노선.every((x) => x.방향.length === 2));
await call("kma_forecast_text", { kind: "land", reg_id: "11D10000" }, (b, t, r) => r.isError && /도시\(C\)/.test(t), { label: "광역 코드 → 도시 코드 안내" });
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
  await call("kma_forecast_version", { ftype: "SHRT", basedatetime: `${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "")}0800` }, (b) => !!b.항목?.length, { label: "예보버전(1970=발표없음)" });

  await call("kma_mid_forecast", { kind: "outlook", id: "108" }, (b) => typeof b.전망문 === "string" && b.전망문.length > 50);
  await call("kma_mid_forecast", { kind: "land", id: "11B00000" }, (b) => b.일별.length > 3, { label: "육상(광역코드 가정 확인)" });
  await call("kma_mid_forecast", { kind: "temp", place: "서울" }, (b) => b.일별.length > 3);
  await call("kma_mid_forecast", { kind: "sea", id: "12A20000" }, (b) => b.일별.length > 3, { label: "해상(서해중부)" });

  await call("kma_warnings", { kind: "status" }, (b) => Array.isArray(b.항목));
  await call("kma_warnings", { kind: "warning_list", stn_id: "109" }, (b) => Array.isArray(b.항목), { label: "오늘 0건도 정상" });
  await call("kma_warnings", { kind: "area", area_code: "L1010000", from: new Date(Date.now() + 9 * 3600e3 - 5 * 86400e3).toISOString().slice(0, 10).replace(/-/g, "") }, (b) => Array.isArray(b.항목), { label: "최근 5일" });
  await call("kma_warnings", { kind: "area", area_code: "L1010000", from: "20260101" }, (b, t, r) => r.isError && /60일/.test(t), { label: "60일 초과 차단" });
  await call("kma_warnings", { kind: "info", stn_id: "108" }, (b) => Array.isArray(b.항목));
  await call("kma_warnings", { kind: "warning_list", stn_id: "108", from: new Date(Date.now() + 9 * 3600e3 - 6 * 86400e3).toISOString().slice(0, 10).replace(/-/g, "") }, (b) => Array.isArray(b.항목), { label: "목록 6일 전 = 허용" });
  await call("kma_warnings", { kind: "info_list", stn_id: "108", from: new Date(Date.now() + 9 * 3600e3 - 7 * 86400e3).toISOString().slice(0, 10).replace(/-/g, "") }, (b, t, r) => r.isError && /6일 전/.test(t) && /kma_warning_history/.test(t) && /원천 API 호출 수: 0/.test(t), { label: "목록 7일 전 = 서버 사전 차단" });

  // API허브 특보 계열(기간 지정)
  await call("kma_warning_history", { kind: "events", from: "20260109", to: "20260112", wrn: "대설", area_code: "L1020000", limit: 3 }, (b) => b.발효요약.some((s) => s.특보 === "대설 경보") && b.맞춘구역.some((z) => z.includes("L1025020")), { label: "2026-01 강원 대설(경보=변경 명령, 옛 북부산지 구역)" });
  await call("kma_warning_history", { kind: "events", from: "20260101", to: "20260131", wrn: "대설", place: "강원 정선군" }, (b) => b.전체행수 > 0 && b.맞춘구역.some((z) => z.includes("정선")) && b.목록.some((r) => r.폐지), { label: "현재 정선 ↔ 옛 정선평지 구역" });
  await call("kma_warning_history", { kind: "events", from: "20150101", to: "20150110", wrn: "강풍", limit: 1 }, (b) => b.전체행수 > 0, { label: "2015년 이력" });
  await call("kma_warning_history", { kind: "events", from: "20250101", to: "20251231" }, (b, t, r) => r.isError && /92일/.test(t), { label: "전 종류 1년 차단" });
  await call("kma_warning_history", { kind: "status_at", tm: "202601100600", limit: 5 }, (b) => b.기준시각 === "2026-01-10 06:00" && b.목록.length === 5 && b.종류별구역.some((g) => g.특보.startsWith("대설")), { label: "과거 시각 특보현황" });
  await call("kma_warning_history", { kind: "info", from: "20260110", to: "20260111", stn: "105", limit: 2, max_chars: 100 }, (b) => b.문서.length === 2 && b.문서.every((d) => d.발표관서.includes("105")), { label: "기상정보 문서(강원)" });
  await call("kma_warning_history", { kind: "commentary", stn: "108", subcd: "13", limit: 1 }, (b) => b.문서.length === 1 && b.문서[0].구분 === "중기", { label: "날씨해설(중기)" });
  {
    const r = await client.callTool({ name: "kma_warning_map", arguments: { place: "강원 춘천시", range: 150, tm: "202601101000", wrn: "대설" } });
    const img = r.content.find((x) => x.type === "image");
    count++;
    const okImg = !r.isError && img && img.mimeType === "image/png" && img.data.length > 2000;
    if (!okImg) fails++;
    console.log(`${okImg ? "✅" : "❌"} kma_warning_map 특보 이미지 (${img ? img.data.length : 0} b64)`);
  }
  // API허브: 통보문·영향예보·고속도로·과거 초단기·AWS 구역(2026-10-14 추가)
  await call("kma_forecast_text", { kind: "land", place: "춘천" }, (b) => b.구역.구역코드 === "11D10301" && b.예보.length >= 6 && b.예보.some((x) => x.최저기온 !== undefined), { label: "도시 반나절 예보" });
  await call("kma_forecast_text", { kind: "land", place: "서울 강남구" }, (b) => b.구역.구역코드 === "11B10101" && b.구역해석.추정, { label: "좌표 최근접 도시 구역" });
  await call("kma_forecast_text", { kind: "situation", place: "강원 강릉" }, (b) => b.관서.includes("105") && b.기상개황.length > 30, { label: "기상개황(강원)" });
  await call("kma_forecast_text", { kind: "sea", place: "서해중부앞바다" }, (b) => b.예보.length >= 4 && !!b.예보[0].파고, { label: "해상" });
  await call("kma_impact_forecast", { kind: "status", from: "20250801", to: "20250802", ifpar: "hw", lat: 35.87, lon: 128.6 }, (b) => b.위험수준요약.some((x) => x.위험수준 === "위험") && b.조건.구역.includes("L1070100"), { label: "2025-08 대구 폭염 위험(옛 구역코드)" });
  await call("kma_impact_forecast", { kind: "counts", from: "20250801", to: "20250801", ifpar: "hw", limit: 3 }, (b) => b.전체행수 > 0 && b.목록[0].지역수 > 0);
  {
    const r = await client.callTool({ name: "kma_impact_forecast", arguments: { kind: "map", tmfc: "20250801", ifpar: "hw" } });
    const img = r.content.find((x) => x.type === "image");
    count++;
    const okImg = !r.isError && img && img.mimeType === "image/png" && img.data.length > 100000;
    if (!okImg) fails++;
    console.log(`${okImg ? "✅" : "❌"} kma_impact_forecast 분포도(Content-Type 오표기 PNG) (${img ? img.data.length : 0} b64)`);
  }
  await call("kma_highway_weather", { kind: "now", point: "기흥IC" }, (b) => b.실황.length >= 1 && typeof b.실황[0].기온 === "number", { label: "고속도로 실황" });
  await call("kma_highway_weather", { kind: "trip", from: "양재IC", to: "구서IC" }, (b) => b.경로.노선코드 === "02" && b.지점별.length === 88, { label: "서울→부산 = 경부선 하행 88지점" });
  await call("kma_short_forecast", { kind: "ultra", place: "서울 중구", base_date: "20240101", base_time: "1130" }, (b) => b.시간별.length === 6 && b.발표시각 === "2024-01-01 11:00", { label: "과거 초단기예보(지점 조회)" });
  await call("kma_find_code", { kind: "aws_zone", query: "강원 정선군 정선읍", tm: "202601100900" }, (b) => b.구역.특보구역코드 === "L1021010", { label: "개편 전 구역(정선군평지)" });
  await call("kma_find_code", { kind: "aws_zone", query: "강원 정선군 정선읍" }, (b) => b.구역.특보구역코드.startsWith("L102") && b.구역.특보구역코드 !== "L1021010", { label: "현재 구역" });
  await call("kma_warning_history", { kind: "events", from: "20260101", to: "20260131", wrn: "대설", place: "강원 강릉시 성산면", limit: 2 }, (b) => b.전체행수 > 0 && /AWS/.test(b.구역해석.방식), { label: "읍면동 → AWS 구역" });

  await call("kma_tour_weather", { kind: "forecast", course_id: "17" }, (b) => b.항목?.length > 0, { label: "관광지 예보" });
  await call("kma_tour_weather", { kind: "forecast", course_id: "17", hours: 108 }, (b) => b.항목.length > 0 && !b.항목.some((r) => Number(r.sky) === 0 && Number(r.th3) === 0) && (!b.예보범위 || b.예보범위.제외행수 > 0), { label: "범위 밖 0값 행 제외" });
  await call("kma_tour_weather", { kind: "climate_index", city_area_id: "2726000000" }, (b) => b.항목?.length > 0, { label: "관광기후지수" });

  // CCTV 지점별로 최근 결과가 없는 시간대가 있다(코드 03) — 2026-10-14 오후 0500C00001·0001C00003이 그랬다. 두 지점 중 하나라도 자료가 오면 통과
  {
    const r1 = await call("kma_road_weather", { eqmt_id: "0500C00001" }, (b, t) => b?.항목?.length > 0 || /코드 03/.test(t), { label: "CCTV 도로날씨(03은 지점 사정)" });
    const r2 = await call("kma_road_weather", { eqmt_id: "2023T1" }, (b, t) => b?.항목?.length > 0 || /코드 03/.test(t), { label: "CCTV 도로날씨 양재" });
    // 2026-10-14 실측: 14:05에는 2023T1 자료가 있었고 15시대에는 두 지점 모두 코드 03 — 시간대에 따라 비는 서비스라 실패가 아니라 확인필요로 센다
    if (!(r1?.항목?.length || r2?.항목?.length)) { unverified++; console.log("   ⚠️ 두 CCTV 지점 모두 지금은 자료 없음(코드 03) — 다른 시각에 다시 확인"); }
  }

  await call("kma_uv_observation", {}, (b) => b.지점수 >= 5 && b.관측.some((r) => r.지점 === 108 && r.지점명 === "서울"), { label: "최신 전 지점" });
  await call("kma_uv_observation", { place: "제주 서귀포시" }, (b) => b.관측소선택.선택관측소.includes("13") && b.관측[0].지점명 === "고산센터", { label: "서귀포→가장 가까운 관측소(고산)" });
  await call("kma_uv_observation", { stn: "108", hours: 3 }, (b) => b.추이.length === 3, { label: "서울 3시간 추이" });
  await call("kma_uv_observation", { tm: "202203211500", stn: "108" }, (b) => b.관측[0].자외선지수 === 1.6, { label: "과거 시각(2022-03-21 15:00 서울=1.6)" });
  // 지상관측소 지점정보(stn_inf SFC)
  await call("kma_find_code", { kind: "station", query: "정선" }, (b) => b.결과[0].지점 === 217 && b.결과[0].영문명 === "Jeongseon Gun" && b.결과[0].예보구역코드 === "11D10502" && b.전체지점수 >= 90, { label: "영문명 공백 지점 파싱" });
  await call("kma_find_code", { kind: "station", query: "100" }, (b) => b.결과[0].지점명 === "대관령" && b.결과[0].육상예보구역.구역코드 === "11D20000", { label: "예보구역→육상 광역" });
  await call("kma_find_code", { kind: "station", query: "강원 정선군", near: true }, (b) => b.가까운관측소[0].지점 === 217 && b.가까운관측소[0].거리km < 15, { label: "지역명→가까운 관측소" });
  await call("kma_find_code", { kind: "station", query: "북부산", tm: "202211300900" }, (b) => b.전체일치 === 0 && b.전체지점수 < 97, { label: "과거 구성(2022-11: 북부산 없음)" });
  await call("kma_find_code", { kind: "uv_station", tm: "201501010900" }, (b) => b.전체지점수 === 6, { label: "UV 2015 구성 6곳" });
  await call("kma_mid_forecast", { kind: "temp", place: "경북 울릉군" }, (b) => /지상관측소/.test(b.구역해석.근거) && !!b.구역해석.구역.구역코드 && b.일별.length > 3, { label: "이름 미일치→관측소 배정 보완" });
  await call("kma_mid_forecast", { kind: "temp", place: "광주 북구" }, (b) => b.구역해석.구역.구역코드 === "11F20501", { label: "전남광주통합·동명 구역(광주광역시)" });
  await call("kma_mid_forecast", { kind: "land", place: "강원 평창군" }, (b) => b.구역해석.구역.구역코드 === "11D10000" && !!b.구역해석.참고_가까운지상관측소, { label: "육상 + 관측소 대조" });
  await call("kma_living_index", { kind: "both", place: "서울 강남구" }, (b) => b.결과.length === 2 && b.결과[0].지점.length >= 1 && !!b.자외선단계별주의사항, { label: "자외선+대기정체" });
}

console.log(`\n호출 ${count}건 — 실패 ${fails}건, 확인필요 ${unverified}건, 원천 API 호출 합계 ${totalCalls}회`);
await client.close();
process.exit(fails ? 1 : 0);
