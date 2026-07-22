// ============================================================
// 入札公告 日次収集ロジック（中核モジュール）
//
// 対象:
//   - 九州防衛局（調達部・管理部の建設工事 一般競争入札）→ 北部九州4県＋対馬のみ
//   - 長崎県 対馬振興局（県発注 工事 公告）
//   - 対馬市（入札の公告／指名競争入札／制限付き一般競争入札）
//
// 使い方:
//   import { runCollection } from './bidNoticeCollector.js'
//   const res = await runCollection({ dryRun:false })   // DB投入
//   const res = await runCollection({ dryRun:true })     // 取得のみ（検証用・DB非投入）
//
// standalone 実行（Cron 用）は cron/collectBidNotices.js から呼ぶ。
// server.js からは管理者の「今すぐ収集」ボタン用に import する。
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import nodemailer from 'nodemailer';
import ws from 'ws';

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal-app-beryl.vercel.app';
const MAIL_FROM = process.env.MAIL_FROM || 'system_noreply@nakahara131.co.jp';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '中原建設社内システム';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 北部九州として収集する県（先頭の県名。「県」は付けない）
const NORTH_KYUSHU = ['福岡', '佐賀', '長崎', '大分'];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ── Supabase クライアント（cron/emailDigest.js と同じ流儀） ──
export function makeSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    { global: { headers: { 'x-client-info': 'portal-api-bid-collector' } }, realtime: { transport: ws } }
  );
}

// ── HTTP 取得 ──
// 通常は Node ネイティブ fetch。ただし www.mod.go.jp（九州防衛局）は
// WAF が Node/undici の TLS フィンガープリントを 403 で弾くため、curl を
// シェル経由で呼ぶ（curl の TLS 指紋は許可される）。curl 前提でローカル実行。
function fetchViaCurl(url, { method = 'GET', body = null, referer = null } = {}) {
  const args = ['-s', '--max-time', '40', '-A', UA, '-H', 'Accept-Language: ja,en;q=0.8'];
  if (referer) args.push('-e', referer);
  if (method === 'POST') {
    args.push('-X', 'POST', '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', body || '');
  }
  args.push(url);
  const buf = execFileSync('curl', args, { maxBuffer: 30 * 1024 * 1024 });
  return buf.toString('utf8');
}

async function fetchText(url, { method = 'GET', body = null, referer = null } = {}) {
  // 九州防衛局は curl 必須（403回避）
  if (url.includes('mod.go.jp')) {
    return fetchViaCurl(url, { method, body, referer });
  }
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.text();
}

// ── HTMLユーティリティ ──
function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
function tableRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
}
function rowCells(rowHtml) {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]));
}

// ── 日付正規化 ──
const WAREKI = { 令和: 2018, R: 2018, 平成: 1988, H: 1988 }; // 元号元年に足すオフセット（令和1=2019 → 2018+1）
// "R8.7.15" / "令和8年7月15日" / "2026/7/15" → "2026-07-15"（不能はnull）
function normDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // 西暦 YYYY/MM/DD or YYYY-MM-DD or YYYY年M月D日
  let m = s.match(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // 和暦記号 R8.7.15 / R8.7.15
  m = s.match(/([RH])\s*(\d{1,2})[.\-年]\s*(\d{1,2})[.\-月]\s*(\d{1,2})/);
  if (m) {
    const y = WAREKI[m[1]] + Number(m[2]);
    return `${y}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
  }
  // 和暦漢字 令和8年7月15日
  m = s.match(/(令和|平成)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const y = WAREKI[m[1]] + Number(m[2]);
    return `${y}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
  }
  return null;
}

// 「福岡県築上郡…」→ "福岡"（4県のいずれか、なければ ''）
function prefectureOf(location) {
  if (!location) return '';
  for (const p of ['福岡', '佐賀', '長崎', '大分', '熊本', '宮崎', '鹿児島']) {
    if (location.includes(p + '県') || location.startsWith(p)) return p;
  }
  return '';
}

// 簡易ハッシュ（安定した重複キー生成用）
function keyHash(...parts) {
  const s = parts.filter(Boolean).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}

// ============================================================
// ソース1: 九州防衛局（建設工事 一般競争入札）
//   列: [工事名(+PDF), 施行場所, 公告日, 受付期限, 開札予定日, 種別, 概要]
//   北部九州4県＋対馬のみ採用。
// ============================================================
async function collectKyushuDefense() {
  const base = 'https://www.mod.go.jp/rdb/kyushu/contract/construction/kyushu/';
  const pages = [
    { agency: '九州防衛局（調達部）', url: base + 'koukoku_11kouji-ippan/index.html' },
    { agency: '九州防衛局（管理部）', url: base + 'koukoku_31tabukouji/index.html' },
  ];
  const out = [];
  for (const pg of pages) {
    let html;
    try {
      html = await fetchText(pg.url);
    } catch (e) {
      console.warn(`[kyushu_defense] ${pg.url} 取得失敗: ${e.message}`);
      continue;
    }
    for (const row of tableRows(html)) {
      const cells = rowCells(row);
      if (cells.length < 5) continue;
      const name = cells[0];
      if (!name || name === '工事名' || name.includes('現在公告はありません')) continue;
      const location = cells[1] || '';
      const pref = prefectureOf(location);
      const isTsushima = location.includes('対馬');
      if (!NORTH_KYUSHU.includes(pref) && !isTsushima) continue; // 対象外の県は捨てる
      const href = (row.match(/href="([^"]+\.pdf)"/i) || [])[1];
      const url = href ? new URL(href, pg.url).href : pg.url;
      const externalKey = href ? 'kd_' + href.split('/').pop() : keyHash('kd', name, cells[2]);
      out.push({
        source: 'kyushu_defense',
        source_agency: pg.agency,
        notice_url: url,
        external_key: externalKey,
        project_name: name,
        work_type: '',
        bid_method: '一般競争入札',
        location,
        prefecture: pref,
        is_tsushima: isTsushima,
        summary: cells[6] || cells[5] || '',
        notice_date: normDate(cells[2]),
        question_due: null,
        bid_date: normDate(cells[3]), // 受付期限＝入札書提出締切
        opening_date: normDate(cells[4]),
        budget_price: null,
      });
    }
  }
  return out;
}

// ============================================================
// ソース2: 長崎県 対馬振興局（県発注 工事 公告）
//   POST /Zyouhoukoukai/Koukoku/SearchEnter
//   SelectedNyusatuKikan=80(対馬振興局) / SelectedKensetuFlg=0(工事)
//   結果列: [執行方法, 発注機関, 工事名, 公告日(YYYY/MM/DD), 入札日(YYYY/MM/DD)]
// ============================================================
async function collectNagasakiPref() {
  const origin = 'https://www.doboku.pref.nagasaki.jp';
  const formUrl = origin + '/Zyouhoukoukai/Koukoku';
  const searchUrl = origin + '/Zyouhoukoukai/Koukoku/SearchEnter';
  try {
    await fetchText(formUrl); // セッション用（Cookie未使用だが作法として）
  } catch {
    /* noop */
  }
  const params = new URLSearchParams({
    SelectedNyusatuKikan: '80', // 対馬振興局
    SelectedKensetuFlg: '0', // 工事
    SelectedKeisaiType: '', // 公告・結果両方（公告のみだと取りこぼす場合があるため両方取得しリンクで判別）
    SelectedSikkohoNm: '',
    SelectedRakusatuhoCd: '',
    SelectedKoukokuDt: '',
    tbKoujiNo: '',
    tbKoujiNm: '',
    Search: 'True',
    SearchCount: '0',
    Page: '1',
  });
  let html;
  try {
    html = await fetchText(searchUrl, { method: 'POST', body: params.toString(), referer: formUrl });
  } catch (e) {
    console.warn(`[nagasaki_pref] 検索失敗: ${e.message}`);
    return [];
  }
  const out = [];
  for (const row of tableRows(html)) {
    const cells = rowCells(row);
    // データ行は「執行方法・対馬振興局・工事名・日付・日付」の5列以上
    if (cells.length < 5) continue;
    const agency = cells[1] || '';
    if (!agency.includes('振興局') && !agency.includes('対馬')) continue;
    const name = cells[2];
    const noticeDate = normDate(cells[3]);
    if (!name || !noticeDate) continue;
    out.push({
      source: 'nagasaki_pref',
      source_agency: '長崎県' + agency,
      notice_url: formUrl,
      external_key: keyHash('np', name, noticeDate),
      project_name: name,
      work_type: '',
      bid_method: cells[0] || '',
      location: '対馬市',
      prefecture: '長崎',
      is_tsushima: true,
      summary: '',
      notice_date: noticeDate,
      question_due: null,
      bid_date: normDate(cells[4]),
      opening_date: null,
      budget_price: null,
    });
  }
  return out;
}

// ============================================================
// ソース3: 対馬市（入札の公告 等）
//   ページが不定形（表・PDFリンク混在）のため、本文テキストを Gemini で構造化抽出。
// ============================================================
const TSUSHIMA_PAGES = [
  { label: '入札の公告', url: 'https://www.city.tsushima.nagasaki.jp/gyousei/shisei/nyusatsu_keiyaku/joho/2265.html' },
  { label: '指名競争入札', url: 'https://www.city.tsushima.nagasaki.jp/gyousei/shisei/nyusatsu_keiyaku/joho/6955.html' },
  { label: '制限付き一般競争入札', url: 'https://www.city.tsushima.nagasaki.jp/gyousei/shisei/nyusatsu_keiyaku/joho/6957.html' },
];

async function geminiExtractTsushima(pageLabel, pageText, pdfLinks) {
  if (!GEMINI_API_KEY) return [];
  const prompt = [
    'あなたは日本の自治体（対馬市）の入札情報ページを解析する担当です。',
    `以下は対馬市の「${pageLabel}」ページのテキストです。`,
    '現在募集中（または最近公告された）の【個別の建設工事の入札案件】だけを抽出してください。',
    '「様式ダウンロード」「申請書」「要綱」「保証に関する説明」など、個別工事でない一般的な案内は除外してください。',
    '各案件について JSON 配列で返してください。項目:',
    '- project_name: 工事名（必須。これが取れないものは含めない）',
    '- bid_method: 入札方式（例: 制限付き一般競争入札 / 指名競争入札 / 一般競争入札）',
    '- location: 工事場所（地区名など。分かる範囲。不明は空文字）',
    '- notice_date: 公告日（YYYY-MM-DD。和暦は西暦に変換。不明は空文字）',
    '- bid_date: 入札日または開札日（YYYY-MM-DD。不明は空文字）',
    '- budget_price: 予定価格（円・半角数字のみ。公表がなければ空文字）',
    '- summary: 概要（任意・短く）',
    '該当が無ければ空配列 [] を返してください。推測で項目を埋めないこと。',
    '',
    '=== ページ本文 ===',
    pageText.slice(0, 12000),
    '',
    '=== ページ内PDFリンク（工事名の手掛かり） ===',
    pdfLinks.slice(0, 40).join('\n'),
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            project_name: { type: 'STRING' },
            bid_method: { type: 'STRING' },
            location: { type: 'STRING' },
            notice_date: { type: 'STRING' },
            bid_date: { type: 'STRING' },
            budget_price: { type: 'STRING' },
            summary: { type: 'STRING' },
          },
          required: ['project_name'],
        },
      },
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.warn(`[tsushima_city] Gemini ${pageLabel} エラー ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return [];
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function collectTsushimaCity() {
  const out = [];
  for (const pg of TSUSHIMA_PAGES) {
    let html;
    try {
      html = await fetchText(pg.url);
    } catch (e) {
      console.warn(`[tsushima_city] ${pg.url} 取得失敗: ${e.message}`);
      continue;
    }
    // 本文テキスト＋PDFリンク（絶対URL化）
    const pageText = stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''));
    const pdfLinks = [...html.matchAll(/<a[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => {
      const u = new URL(m[1], pg.url).href;
      return `${stripTags(m[2])} => ${u}`;
    });
    const items = await geminiExtractTsushima(pg.label, pageText, pdfLinks);
    for (const it of items) {
      if (!it.project_name) continue;
      // 工事名に一致するPDFがあればそれを notice_url に
      const match = pdfLinks.find((l) => l.includes(it.project_name.slice(0, 8)));
      const noticeUrl = match ? match.split(' => ').pop() : pg.url;
      out.push({
        source: 'tsushima_city',
        source_agency: '対馬市',
        notice_url: noticeUrl,
        external_key: keyHash('tc', it.project_name, it.notice_date || pg.label),
        project_name: it.project_name,
        work_type: '',
        bid_method: it.bid_method || pg.label,
        location: it.location || '対馬市',
        prefecture: '長崎',
        is_tsushima: true,
        summary: it.summary || '',
        notice_date: normDate(it.notice_date),
        question_due: null,
        bid_date: normDate(it.bid_date),
        opening_date: null,
        budget_price: /^\d+$/.test(String(it.budget_price || '')) ? Number(it.budget_price) : null,
      });
    }
  }
  return out;
}

// ============================================================
// 日次メール通知（新着があれば入札担当者へ要約送信）
// ============================================================
function smtpTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null; // 未設定ならメールはスキップ
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

// 送信先: 入札案件管理の権限を持つ社員 ＋ 管理者（重複・空は除外）
async function getBidRecipients(supabase) {
  const [{ data: perms }, { data: admins }] = await Promise.all([
    supabase.from('staff_app_permissions').select('staff_id').eq('app_key', 'bids'),
    supabase.from('staff_master').select('id, email, app_role'),
  ]);
  const adminMap = new Map((admins || []).map((a) => [a.id, a]));
  const ids = new Set((perms || []).map((p) => p.staff_id));
  for (const a of admins || []) if (a.app_role === 'admin') ids.add(a.id);
  const emails = [...ids]
    .map((id) => (adminMap.get(id)?.email || '').trim())
    .filter(Boolean);
  return [...new Set(emails)];
}

async function sendDigestEmail(supabase, newItems) {
  const transporter = smtpTransporter();
  if (!transporter) {
    console.log('[mail] SMTP未設定のためメール送信をスキップしました');
    return { sent: false, reason: 'smtp_unconfigured' };
  }
  const to = await getBidRecipients(supabase);
  if (!to.length) {
    console.log('[mail] 送信先（入札権限者）が居ないためスキップ');
    return { sent: false, reason: 'no_recipients' };
  }

  const lines = ['入札公告の新着が届きました。', '', `新着 ${newItems.length} 件`, ''];
  for (const n of newItems) {
    const deadline = n.bid_date || null;
    lines.push(`● ${n.project_name}`);
    lines.push(`   ${n.source_agency || ''}${n.location ? ' / ' + n.location : ''}`);
    lines.push(`   公告 ${n.notice_date || '—'}${deadline ? ' / 締切 ' + deadline : ''}`);
    if (n.notice_url) lines.push(`   ${n.notice_url}`);
    lines.push('');
  }
  lines.push(`ポータルで確認 → ${PORTAL_URL}`);
  const text = lines.join('\n');
  const subject = `【入札公告】新着 ${newItems.length} 件（${new Date().toLocaleDateString('ja-JP')}）`;

  await transporter.sendMail({
    from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`,
    to: to.join(', '),
    subject,
    text,
  });
  console.log(`[mail] 送信完了: ${to.length}名へ / 新着${newItems.length}件`);
  return { sent: true, recipients: to.length };
}

// ============================================================
// メイン: 収集 → 重複排除 → 投入 → 実行ログ → メール
// ============================================================
export async function runCollection({ dryRun = false, sendEmail = false } = {}) {
  const sources = [
    { name: 'kyushu_defense', fn: collectKyushuDefense },
    { name: 'nagasaki_pref', fn: collectNagasakiPref },
    { name: 'tsushima_city', fn: collectTsushimaCity },
  ];

  const supabase = dryRun ? null : makeSupabase();
  const summary = { dryRun, perSource: {}, totalFound: 0, totalNew: 0, newItems: [] };

  for (const src of sources) {
    const started = new Date().toISOString();
    let items = [];
    let ok = true;
    let errMsg = null;
    try {
      items = await src.fn();
    } catch (e) {
      ok = false;
      errMsg = e.message;
      console.error(`[${src.name}] 失敗: ${e.message}`);
    }
    const found = items.length;
    let newCount = 0;

    if (!dryRun && ok && items.length) {
      // 既存 external_key を取得して重複排除
      const keys = items.map((i) => i.external_key);
      const { data: existing } = await supabase
        .from('bid_notices')
        .select('external_key')
        .eq('source', src.name)
        .in('external_key', keys);
      const existingSet = new Set((existing || []).map((r) => r.external_key));
      const fresh = items.filter((i) => !existingSet.has(i.external_key));
      if (fresh.length) {
        const { data: inserted, error } = await supabase
          .from('bid_notices')
          .upsert(fresh, { onConflict: 'source,external_key', ignoreDuplicates: true })
          .select('id, project_name, source_agency, notice_url, notice_date, bid_date, location');
        if (error) {
          ok = false;
          errMsg = error.message;
          console.error(`[${src.name}] 投入エラー: ${error.message}`);
        } else {
          newCount = inserted?.length || 0;
          summary.newItems.push(...(inserted || []));
        }
      }
      // 実行ログ
      await supabase.from('bid_collection_runs').insert({
        source: src.name,
        started_at: started,
        finished_at: new Date().toISOString(),
        found_count: found,
        target_count: found, // フィルタ後に集めているので found=target
        new_count: newCount,
        ok,
        error: errMsg,
      });
    }

    summary.perSource[src.name] = { found, new: newCount, ok, error: errMsg, items: dryRun ? items : undefined };
    summary.totalFound += found;
    summary.totalNew += newCount;
  }

  // 新着があればメール通知（dryRun時・新着0件時は送らない）
  if (!dryRun && sendEmail && summary.newItems.length) {
    try {
      summary.mail = await sendDigestEmail(supabase, summary.newItems);
    } catch (e) {
      console.error('[mail] 送信失敗:', e.message);
      summary.mail = { sent: false, error: e.message };
    }
  }

  // realtime(ws) ハンドルを閉じる。Windows で process.exit() 時に libuv が
  // アボートするのを防ぐため、明示的に切断してイベントループを drain させる。
  if (supabase) {
    try {
      await supabase.removeAllChannels();
      supabase.realtime.disconnect();
    } catch {
      /* noop */
    }
  }

  return summary;
}
