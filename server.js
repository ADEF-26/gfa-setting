/**
 * GFA 스마트채널 셋팅툴 서버
 * - 사내 GFA 프록시 중계 (X-API-Key + team_name 자동 부착)
 * - 소재세트 임시저장 (디스크 JSON + 이미지 파일)
 * - 발행 파이프라인: 이미지 업로드 → IMAGE_BANNER 소재 생성 → (옵션) OFF
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const GFA_PROXY_BASE = (process.env.GFA_PROXY_BASE || '').replace(/\/+$/, '');
const GFA_API_PATH_PREFIX = (process.env.GFA_API_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const GFA_API_KEY = process.env.GFA_API_KEY || '';
const TEAM_NAME = process.env.TEAM_NAME || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const CONCURRENCY = Math.max(1, parseInt(process.env.PUBLISH_CONCURRENCY || '3', 10));

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- DB (단순 JSON) ---------------- */
let db = { accounts: [], sets: [] };
try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (_) {}
db.accounts = db.accounts || [];
db.sets = db.sets || [];
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), () => {});
  }, 150);
}
const uid = () => crypto.randomBytes(5).toString('hex');

/* ---------------- 템플릿 매핑 ---------------- */
/* 750×160의 템플릿 코드는 문서에 픽셀 명시가 없어 BANNER_750로 가정.
   발행 실패 시 광고그룹 조회(includeCreativeTemplates=true)로 확인 후
   TEMPLATE_160 환경변수로 교체 가능. */
const TEMPLATE_160 = process.env.TEMPLATE_160 || 'BANNER_750';
function templateForSize(w, h) {
  if (w === 750 && h === 280) return 'BANNER_750X280';
  if (w === 750 && h === 200) return 'BANNER_750X200';
  if (w === 750 && h === 160) return TEMPLATE_160;
  if (w === 1250 && h === 560) return 'BANNER_1250X560';
  if (w === 1200 && h === 1200) return 'BANNER_1200X1200';
  return null;
}

/* PNG/JPEG 크기 파싱 (의존성 없이) */
function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) { // PNG
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/* ---------------- GFA 프록시 호출 ---------------- */
let lastGfaExchange = null; // 디버그용
function buildProxyUrl(apiPath, query) {
  const parts = [GFA_PROXY_BASE];
  if (GFA_API_PATH_PREFIX) parts.push(GFA_API_PATH_PREFIX);
  parts.push(apiPath.replace(/^\/+/, ''));
  const u = new URL(parts.join('/'));
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  u.searchParams.set('team_name', TEAM_NAME);
  return u.toString();
}

async function gfa(method, apiPath, { query, json, form } = {}) {
  if (!GFA_PROXY_BASE || !GFA_API_KEY || !TEAM_NAME) {
    throw new Error('GFA_PROXY_BASE / GFA_API_KEY / TEAM_NAME 환경변수가 설정되지 않았습니다.');
  }
  const url = buildProxyUrl(apiPath, query);
  const headers = { 'X-API-Key': GFA_API_KEY };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) { body = form; } // fetch가 multipart boundary 자동 설정
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  lastGfaExchange = {
    at: new Date().toISOString(), method, url: url.replace(/team_name=[^&]*/, 'team_name=***'),
    status: res.status, response: typeof data === 'string' ? data.slice(0, 3000) : data,
  };
  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data).slice(0, 500) : String(data).slice(0, 500);
    const err = new Error(`GFA ${res.status}: ${msg}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

/* 응답 구조가 문서에 없어 방어적으로 배열/키 추출 */
function extractList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['content', 'items', 'list', 'data', 'result', 'campaigns', 'adSets', 'creatives']) {
      if (Array.isArray(data[k])) return data[k];
    }
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return [];
}
function deepFindNumber(obj, keys, depth = 0) {
  if (obj == null || depth > 6) return null;
  if (typeof obj === 'number') return null;
  if (typeof obj === 'object') {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    }
    for (const v of Object.values(obj)) {
      const found = deepFindNumber(v, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}
const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

/* ---------------- Express ---------------- */
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR, { maxAge: '1h' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.get('/api/health', (req, res) => res.json({
  ok: true,
  configured: Boolean(GFA_PROXY_BASE && GFA_API_KEY && TEAM_NAME),
  template160: TEMPLATE_160,
}));
app.get('/api/debug/last', (req, res) => res.json(lastGfaExchange || { note: '아직 GFA 호출 없음' }));

/* ---- 광고계정 등록 (수동 등록: 번호 + 별칭) ---- */
app.get('/api/accounts', (req, res) => res.json(db.accounts));
app.post('/api/accounts', (req, res) => {
  const no = parseInt(req.body.adAccountNo, 10);
  if (!no) return res.status(400).json({ error: 'adAccountNo 필요' });
  if (db.accounts.some(a => a.adAccountNo === no)) return res.status(409).json({ error: '이미 등록된 계정' });
  const acc = { adAccountNo: no, alias: String(req.body.alias || no).slice(0, 60) };
  db.accounts.push(acc); saveDb(); res.json(acc);
});
app.delete('/api/accounts/:no', (req, res) => {
  db.accounts = db.accounts.filter(a => a.adAccountNo !== parseInt(req.params.no, 10));
  saveDb(); res.json({ ok: true });
});

/* ---- GFA 조회 중계 ---- */
app.get('/api/gfa/campaigns/:accountNo', async (req, res) => {
  try {
    const list = [];
    for (let page = 0; page < 5; page++) {
      const data = await gfa('GET', `1/adAccounts/${req.params.accountNo}/campaigns`, { query: { page, size: 100 } });
      const chunk = extractList(data);
      list.push(...chunk);
      if (chunk.length < 100) break;
    }
    res.json(list.map(c => ({
      campaignNo: pick(c, ['campaignNo', 'no', 'id']),
      name: pick(c, ['name', 'campaignName']) || '(이름없음)',
      objective: pick(c, ['objective']),
      activated: pick(c, ['activated', 'isActivated']),
    })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/gfa/adsets/:accountNo/:campaignNo', async (req, res) => {
  try {
    const list = [];
    for (let page = 0; page < 5; page++) {
      const data = await gfa('GET', `1/adAccounts/${req.params.accountNo}/adSets`, {
        query: { campaignNo: req.params.campaignNo, page, size: 100 },
      });
      const chunk = extractList(data);
      list.push(...chunk);
      if (chunk.length < 100) break;
    }
    res.json(list.map(s => ({
      adSetNo: pick(s, ['adSetNo', 'no', 'id']),
      name: pick(s, ['name', 'adSetName']) || '(이름없음)',
      activated: pick(s, ['activated', 'isActivated']),
      placementGroupCodes: pick(s, ['placementGroupCodes']) || [],
    })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/* 광고그룹의 생성 가능 템플릿 확인 (750×160 코드 검증용) */
app.get('/api/gfa/templates/:accountNo/:adSetNo', async (req, res) => {
  try {
    const data = await gfa('GET', `1/adAccounts/${req.params.accountNo}/adSets/${req.params.adSetNo}`, {
      query: { includeCreativeTemplates: true },
    });
    res.json(data);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/* ---- 소재세트 CRUD ---- */
app.get('/api/sets', (req, res) => res.json(db.sets));
app.post('/api/sets', (req, res) => {
  const s = {
    id: uid(),
    name: String(req.body.name || '새 세트').slice(0, 60),
    color: req.body.color || '#03c75a',
    landingUrl: String(req.body.landingUrl || ''),
    altMessage: String(req.body.altMessage || ''),
    images: [], // {id, file, w, h, template, label, bytes}
    links: [],  // {adAccountNo, accountAlias, campaignNo, campaignName, adSetNo, adSetName}
    createdAt: Date.now(),
  };
  db.sets.push(s); saveDb(); res.json(s);
});
app.put('/api/sets/:id', (req, res) => {
  const s = db.sets.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '세트 없음' });
  for (const k of ['name', 'color', 'landingUrl', 'altMessage']) {
    if (req.body[k] !== undefined) s[k] = String(req.body[k]);
  }
  saveDb(); res.json(s);
});
app.delete('/api/sets/:id', (req, res) => {
  const s = db.sets.find(x => x.id === req.params.id);
  if (s) for (const img of s.images) fs.unlink(path.join(UPLOAD_DIR, img.file), () => {});
  db.sets = db.sets.filter(x => x.id !== req.params.id);
  saveDb(); res.json({ ok: true });
});

/* ---- 세트에 이미지 추가/삭제 ---- */
app.post('/api/sets/:id/images', upload.array('files', 30), (req, res) => {
  const s = db.sets.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '세트 없음' });
  const added = [], rejected = [];
  for (const f of req.files || []) {
    const size = imageSize(f.buffer);
    const template = size ? templateForSize(size.w, size.h) : null;
    if (!size || !template) {
      rejected.push({ name: f.originalname, reason: size ? `지원하지 않는 크기 ${size.w}×${size.h}` : '이미지 파싱 실패' });
      continue;
    }
    const ext = f.originalname.toLowerCase().endsWith('.jpg') || f.originalname.toLowerCase().endsWith('.jpeg') ? '.jpg' : '.png';
    const id = uid();
    const file = `${s.id}_${id}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), f.buffer);
    const img = {
      id, file, w: size.w, h: size.h, template,
      label: f.originalname.replace(/\.(png|jpe?g)$/i, '').slice(0, 80),
      bytes: f.buffer.length,
    };
    s.images.push(img); added.push(img);
  }
  saveDb(); res.json({ added, rejected, set: s });
});
app.delete('/api/sets/:id/images/:imgId', (req, res) => {
  const s = db.sets.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '세트 없음' });
  const img = s.images.find(i => i.id === req.params.imgId);
  if (img) fs.unlink(path.join(UPLOAD_DIR, img.file), () => {});
  s.images = s.images.filter(i => i.id !== req.params.imgId);
  saveDb(); res.json(s);
});

/* ---- 연결(노드) 추가/삭제 ---- */
app.post('/api/sets/:id/links', (req, res) => {
  const s = db.sets.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '세트 없음' });
  const items = Array.isArray(req.body.links) ? req.body.links : [req.body];
  for (const l of items) {
    const adSetNo = parseInt(l.adSetNo, 10);
    const adAccountNo = parseInt(l.adAccountNo, 10);
    if (!adSetNo || !adAccountNo) continue;
    if (s.links.some(x => x.adSetNo === adSetNo)) continue;
    s.links.push({
      adAccountNo, adSetNo,
      accountAlias: String(l.accountAlias || adAccountNo),
      campaignNo: l.campaignNo || null,
      campaignName: String(l.campaignName || ''),
      adSetName: String(l.adSetName || adSetNo),
    });
  }
  saveDb(); res.json(s);
});
app.delete('/api/sets/:id/links/:adSetNo', (req, res) => {
  const s = db.sets.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '세트 없음' });
  s.links = s.links.filter(l => l.adSetNo !== parseInt(req.params.adSetNo, 10));
  saveDb(); res.json(s);
});

/* ---------------- 발행 파이프라인 ---------------- */
function semaphore(n) {
  let active = 0; const queue = [];
  const next = () => { if (active < n && queue.length) { active++; queue.shift()(); } };
  return async fn => new Promise((resolve, reject) => {
    queue.push(async () => {
      try { resolve(await fn()); } catch (e) { reject(e); }
      finally { active--; next(); }
    });
    next();
  });
}

app.post('/api/publish', async (req, res) => {
  const setIds = Array.isArray(req.body.setIds) ? req.body.setIds : [];
  const turnOff = Boolean(req.body.turnOff);
  const sets = db.sets.filter(s => setIds.includes(s.id));
  if (!sets.length) return res.status(400).json({ error: '발행할 세트가 없습니다.' });

  // 사전 검증
  const problems = [];
  for (const s of sets) {
    if (!s.images.length) problems.push(`[${s.name}] 이미지가 없습니다.`);
    if (!s.links.length) problems.push(`[${s.name}] 연결된 광고그룹이 없습니다.`);
    if (!/^https?:\/\//.test(s.landingUrl)) problems.push(`[${s.name}] 랜딩 URL이 유효하지 않습니다.`);
    const alt = (s.altMessage || '').trim();
    if (alt.length < 2 || alt.length > 100) problems.push(`[${s.name}] 광고 안내 문구는 2~100자여야 합니다.`);
  }
  if (problems.length) return res.status(400).json({ error: problems.join('\n') });

  const limit = semaphore(CONCURRENCY);
  const imageNoCache = new Map(); // `${accountNo}:${imgId}` → imageNo
  const results = [];
  const createdByAccount = new Map(); // accountNo → [creativeNo]

  async function uploadImage(accountNo, img) {
    const key = `${accountNo}:${img.id}`;
    if (imageNoCache.has(key)) return imageNoCache.get(key);
    const buf = fs.readFileSync(path.join(UPLOAD_DIR, img.file));
    const form = new FormData();
    form.append('creativeTemplateCode', img.template);
    const type = img.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    form.append('file', new Blob([buf], { type }), img.file);
    const data = await gfa('POST', `1/adAccounts/${accountNo}/creatives/image`, { form });
    const imageNo = deepFindNumber(data, ['imageNo', 'no', 'id', 'mediaNo']);
    if (!imageNo) throw new Error(`이미지 업로드 응답에서 imageNo를 찾지 못함: ${JSON.stringify(data).slice(0, 300)}`);
    imageNoCache.set(key, imageNo);
    return imageNo;
  }

  const jobs = [];
  for (const s of sets) {
    for (const link of s.links) {
      for (const img of s.images) {
        jobs.push(limit(async () => {
          const base = {
            set: s.name, image: img.label, size: `${img.w}×${img.h}`,
            adSet: `${link.accountAlias} / ${link.adSetName}`,
          };
          try {
            const imageNo = await uploadImage(link.adAccountNo, img);
            const name = `${s.name}_${img.label}`.slice(0, 128);
            const created = await gfa('POST', `1/adAccounts/${link.adAccountNo}/creatives/IMAGE_BANNER`, {
              json: {
                adSetNo: link.adSetNo,
                altMessage: s.altMessage.trim(),
                creativeTemplateCode: img.template,
                imageNo,
                name: name.length >= 2 ? name : `소재_${name}`,
                url: s.landingUrl,
              },
            });
            const creativeNo = deepFindNumber(created, ['creativeNo', 'no', 'id']);
            if (creativeNo) {
              if (!createdByAccount.has(link.adAccountNo)) createdByAccount.set(link.adAccountNo, []);
              createdByAccount.get(link.adAccountNo).push(creativeNo);
            }
            results.push({ ...base, ok: true, creativeNo: creativeNo || '(응답에서 미확인)' });
          } catch (e) {
            results.push({ ...base, ok: false, error: e.message });
          }
        }));
      }
    }
  }
  await Promise.allSettled(jobs);

  // 생성 후 OFF 옵션 (계정별 100개 단위)
  const offResults = [];
  if (turnOff) {
    for (const [accountNo, nos] of createdByAccount) {
      const valid = nos.filter(n => typeof n === 'number');
      for (let i = 0; i < valid.length; i += 100) {
        const chunk = valid.slice(i, i + 100);
        try {
          await gfa('POST', `1/adAccounts/${accountNo}/creatives/activate`, {
            query: { activated: false, creativeNos: chunk.join(',') },
          });
          offResults.push({ accountNo, count: chunk.length, ok: true });
        } catch (e) {
          offResults.push({ accountNo, count: chunk.length, ok: false, error: e.message });
        }
      }
    }
  }

  const okCount = results.filter(r => r.ok).length;
  res.json({ total: results.length, ok: okCount, failed: results.length - okCount, results, offResults });
});

app.listen(PORT, () => console.log(`GFA 셋팅툴 서버 실행: :${PORT} (동시성 ${CONCURRENCY})`));
