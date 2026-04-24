// Korea Travel AI - Cloudflare Worker
// ENV: TOUR_API_KEY, GEMINI_API_KEY, TRANSLATION_CACHE (KV binding)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TOUR_BASE = 'https://apis.data.go.kr/B551011/KorService2';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const CONTENT_TYPES = {
  12: 'Tourist Spot',
  14: 'Cultural Facility',
  15: 'Festival/Event',
  25: 'Travel Course',
  28: 'Leisure/Sports',
  32: 'Accommodation',
  38: 'Shopping',
  39: 'Restaurant',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      if (path === '/api/nearby' && request.method === 'GET') return await handleNearby(url, env);
      if (path === '/api/search' && request.method === 'GET') return await handleSearch(url, env);
      if (path === '/api/detail' && request.method === 'GET') return await handleDetail(url, env);
      if (path === '/api/chat'   && request.method === 'POST') return await handleChat(request, env);
      if (path === '/api/health') return jsonResponse({ status: 'ok', time: new Date().toISOString() });
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      return jsonResponse({ error: e.message }, 500);
    }
  },
};

// ── 1. 위치 기반 주변 관광지 ────────────────────────────────────
async function handleNearby(url, env) {
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng');
  const radius = url.searchParams.get('radius') || '3000';
  const type = url.searchParams.get('type') || '';
  const numOfRows = url.searchParams.get('numOfRows') || '20';

  if (!lat || !lng) return jsonResponse({ error: 'lat, lng required' }, 400);

  const params = new URLSearchParams({
    serviceKey: env.TOUR_API_KEY,
    mapX: lng, mapY: lat, radius,
    MobileOS: 'ETC', MobileApp: 'KoreaTravelAI',
    _type: 'json', numOfRows, pageNo: '1', arrange: 'S',
  });
  if (type) params.set('contentTypeId', type);

  const res = await fetch(`${TOUR_BASE}/locationBasedList2?${params}`);
  const data = await res.json();
  const items = extractItems(data);

  const translated = await Promise.all(items.map(item => translateItem(item, env)));
  return jsonResponse({ items: translated, total: data?.response?.body?.totalCount || 0 });
}

// ── 2. 키워드 검색 ───────────────────────────────────────────────
async function handleSearch(url, env) {
  const keyword = url.searchParams.get('keyword');
  const areaCode = url.searchParams.get('areaCode') || '';
  const type = url.searchParams.get('type') || '';
  const numOfRows = url.searchParams.get('numOfRows') || '20';

  if (!keyword) return jsonResponse({ error: 'keyword required' }, 400);

  const params = new URLSearchParams({
    serviceKey: env.TOUR_API_KEY, keyword,
    MobileOS: 'ETC', MobileApp: 'KoreaTravelAI',
    _type: 'json', numOfRows, pageNo: '1', arrange: 'A',
  });
  if (areaCode) params.set('areaCode', areaCode);
  if (type) params.set('contentTypeId', type);

  const res = await fetch(`${TOUR_BASE}/searchKeyword2?${params}`);
  const data = await res.json();
  const items = extractItems(data);

  const translated = await Promise.all(items.map(item => translateItem(item, env)));
  return jsonResponse({ items: translated, total: data?.response?.body?.totalCount || 0 });
}

// ── 3. 상세 정보 ─────────────────────────────────────────────────
async function handleDetail(url, env) {
  const contentId = url.searchParams.get('contentId');
  const contentTypeId = url.searchParams.get('contentTypeId') || '12';
  if (!contentId) return jsonResponse({ error: 'contentId required' }, 400);

  const base = {
    serviceKey: env.TOUR_API_KEY,
    MobileOS: 'ETC', MobileApp: 'KoreaTravelAI',
    _type: 'json', contentId, contentTypeId,
  };

  const [commonRes, introRes, imageRes] = await Promise.all([
    fetch(`${TOUR_BASE}/detailCommon2?${new URLSearchParams({ ...base, defaultYN: 'Y', addrinfoYN: 'Y', overviewYN: 'Y', mapinfoYN: 'Y', firstImageYN: 'Y' })}`),
    fetch(`${TOUR_BASE}/detailIntro2?${new URLSearchParams(base)}`),
    fetch(`${TOUR_BASE}/detailImage2?${new URLSearchParams({ ...base, imageYN: 'Y', subImageYN: 'Y', numOfRows: '10' })}`),
  ]);

  const [commonData, introData, imageData] = await Promise.all([
    commonRes.json(), introRes.json(), imageRes.json(),
  ]);

  const common = extractItems(commonData)[0] || {};
  const intro = extractItems(introData)[0] || {};
  const images = extractItems(imageData);

  const cacheKey = `detail:${contentId}`;
  const cached = await getCache(env, cacheKey);
  if (cached) {
    return jsonResponse({ ...cached, images: images.map(i => i.originimgurl) });
  }

  // Extract type-specific intro fields
  const introFields = extractIntroFields(intro, contentTypeId);

  const toTranslate = {
    title: common.title || '',
    overview: common.overview || '',
    addr: common.addr1 || '',
    ...introFields,
  };

  const translated = await geminiTranslateObject(toTranslate, env);

  // Build translated typeInfo
  const typeInfo = {};
  for (const k of Object.keys(introFields)) {
    const v = translated[k] || introFields[k];
    if (v) typeInfo[k] = v;
  }

  const result = {
    contentId,
    contentTypeId,
    typeName: CONTENT_TYPES[contentTypeId] || 'Attraction',
    title: translated.title || common.title || '',
    overview: translated.overview || common.overview || '',
    address: translated.addr || common.addr1,
    mapx: common.mapx,
    mapy: common.mapy,
    tel: common.tel,
    homepage: common.homepage,
    firstImage: common.firstimage,
    typeInfo,
  };

  await setCache(env, cacheKey, result, 60 * 60 * 24 * 30);
  return jsonResponse({ ...result, images: images.map(i => i.originimgurl) });
}

// ── 4. AI 챗봇 ───────────────────────────────────────────────────
async function handleChat(request, env) {
  const body = await request.json();
  const { messages, location } = body;

  if (!messages || !Array.isArray(messages)) {
    return jsonResponse({ error: 'messages array required' }, 400);
  }

  const locationContext = location
    ? `User's current location: ${location.lat}, ${location.lng} (near ${location.name || 'Korea'})`
    : 'Location not provided';

  const systemPrompt = `You are a friendly and knowledgeable Korea travel guide AI assistant.
Your goal is to help foreign tourists discover amazing places in Korea.

${locationContext}

Guidelines:
- Always respond in English
- Be enthusiastic but concise
- Suggest specific places with brief descriptions
- Include practical tips (best time to visit, how to get there, what to try)
- Keep responses under 200 words unless asked for more detail
- Use emojis sparingly for friendliness`;

  const geminiMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const model = 'gemini-2.0-flash';
  const res = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiMessages,
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    console.error('Gemini error:', JSON.stringify(data));
    return jsonResponse({ error: 'AI service error', detail: data?.error?.message }, 500);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return jsonResponse({ reply: text });
}

// ── Gemini 번역 헬퍼 ─────────────────────────────────────────────
async function translateItem(item, env) {
  const cacheKey = `item:${item.contentid}`;
  const cached = await getCache(env, cacheKey);
  if (cached) return { ...item, ...cached, _cached: true };

  const translated = await geminiTranslateObject({
    title: item.title || '',
    addr: item.addr1 || '',
  }, env);

  const result = {
    contentId: item.contentid,
    contentTypeId: item.contenttypeid,
    typeName: CONTENT_TYPES[item.contenttypeid] || 'Attraction',
    title: translated.title || item.title,
    address: translated.addr || item.addr1,
    mapx: item.mapx, mapy: item.mapy,
    dist: item.dist, firstImage: item.firstimage, tel: item.tel,
  };

  await setCache(env, cacheKey, result, 60 * 60 * 24 * 30);
  return result;
}

async function geminiTranslateObject(obj, env) {
  const nonEmpty = Object.entries(obj).filter(([, v]) => v && String(v).trim());
  if (nonEmpty.length === 0) return obj;

  const prompt = `Translate the following Korean tourism information to natural English.
Return ONLY a JSON object with the same keys. Keep proper nouns as-is or add English name in parentheses.
Do not add any explanation.

Input:
${JSON.stringify(Object.fromEntries(nonEmpty))}`;

  const model = 'gemini-2.0-flash';
  const res = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
      }),
    }
  );

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    return { ...obj, ...JSON.parse(clean) };
  } catch {
    return obj;
  }
}

// ── Intro 타입별 파싱 ─────────────────────────────────────────────
function stripHtml(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractIntroFields(intro, typeId) {
  const tid = String(typeId);
  const raw = {};

  if (tid === '12') {
    if (intro.usetime)        raw.usetime        = intro.usetime;
    if (intro.restdate)       raw.restdate       = intro.restdate;
    if (intro.parking)        raw.parking        = intro.parking;
    if (intro.chkpet)         raw.chkpet         = intro.chkpet;
    if (intro.chkbabycarriage) raw.chkbabycarriage = intro.chkbabycarriage;
    if (intro.chkcreditcard)  raw.chkcreditcard  = intro.chkcreditcard;
    if (intro.accomcount)     raw.accomcount     = intro.accomcount;
  } else if (tid === '14') {
    if (intro.usetimeculture)       raw.usetime        = intro.usetimeculture;
    if (intro.restdateculture)      raw.restdate       = intro.restdateculture;
    if (intro.usefee)               raw.usefee         = intro.usefee;
    if (intro.parking)              raw.parking        = intro.parking;
    if (intro.chkbabycarriageculture) raw.chkbabycarriage = intro.chkbabycarriageculture;
    if (intro.chkpetculture)        raw.chkpet         = intro.chkpetculture;
  } else if (tid === '15') {
    if (intro.eventstartdate)  raw.eventstartdate = intro.eventstartdate;
    if (intro.eventenddate)    raw.eventenddate   = intro.eventenddate;
    if (intro.eventplace)      raw.eventplace     = intro.eventplace;
    if (intro.usetimefestival) raw.usetime        = intro.usetimefestival;
    if (intro.playtime)        raw.playtime       = intro.playtime;
    if (intro.program)         raw.program        = intro.program;
  } else if (tid === '32') {
    if (intro.checkintime)      raw.checkintime  = intro.checkintime;
    if (intro.checkouttime)     raw.checkouttime = intro.checkouttime;
    if (intro.parkinglodging)   raw.parking      = intro.parkinglodging;
    if (intro.breakfast)        raw.breakfast    = intro.breakfast;
    if (intro.roomcount)        raw.roomcount    = intro.roomcount;
    if (intro.reservationlodging) raw.reservation = intro.reservationlodging;
  } else if (tid === '38') {
    if (intro.opentimeshopping)    raw.usetime    = intro.opentimeshopping;
    if (intro.restdateshopping)    raw.restdate   = intro.restdateshopping;
    if (intro.parkingshopping)     raw.parking    = intro.parkingshopping;
    if (intro.chkcreditcardshopping) raw.creditcard = intro.chkcreditcardshopping;
    if (intro.saleitem)            raw.saleitem   = intro.saleitem;
  } else if (tid === '39') {
    if (intro.opentimefood)      raw.usetime     = intro.opentimefood;
    if (intro.restdatefood)      raw.restdate    = intro.restdatefood;
    if (intro.parkingfood)       raw.parking     = intro.parkingfood;
    if (intro.chkcreditcardfood) raw.creditcard  = intro.chkcreditcardfood;
    if (intro.firstmenu)         raw.firstmenu   = intro.firstmenu;
    if (intro.seat)              raw.seat        = intro.seat;
    if (intro.takeoutpossible)   raw.takeout     = intro.takeoutpossible;
    if (intro.reservationfood)   raw.reservation = intro.reservationfood;
  }

  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    const s = stripHtml(v);
    if (s) result[k] = s;
  }
  return result;
}

// ── KV 캐시 헬퍼 ─────────────────────────────────────────────────
async function getCache(env, key) {
  try {
    if (!env.TRANSLATION_CACHE) return null;
    return await env.TRANSLATION_CACHE.get(key, 'json');
  } catch { return null; }
}

async function setCache(env, key, value, ttl = 86400) {
  try {
    if (!env.TRANSLATION_CACHE) return;
    await env.TRANSLATION_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch { /* ignore */ }
}

// ── 공통 헬퍼 ────────────────────────────────────────────────────
function extractItems(data) {
  const items = data?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
