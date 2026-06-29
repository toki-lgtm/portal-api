// 束ねPDF（コピー機スキャン）の資格者証を、ローカルで Gemini 解析→Drive保存→DB登録する。
// ポータルの証書ベースv5ロジックを踏襲。本番API(JWT)不要・Gemini直叩き・激安。
//
//   node scan_pdfs_local.mjs <pdf...> [--dry-run]   個別ファイル指定
//   node scan_pdfs_local.mjs --all     [--dry-run]   未処理(「読込済」非含)を全部
//
// 処理済みPDFはファイル名に「 読込済_Claude」を付与（人手の「読込済」と区別）。

import dotenv from 'dotenv';
import { readFileSync, renameSync, readdirSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import { driveUpload, ensureFolderPath, driveConfigured } from './googleDrive.js';
import { randomUUID } from 'crypto';

dotenv.config();
const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');
const CHUNK = 8; // Geminiへ一度に渡すページ数（MAX_TOKENS回避）
const BASE = 'G:/共有ドライブ/中原建設 共有/② その他/002.ISO関係/従業員資格一覧';
const SUBS = ['個人別　資格者証','個人別　資格者証（中央産業）','資格別　資格者証（中央産業）','資格別一覧表【講習・教育・研修】','資格別一覧表【免許関係】読込済'];

if (!driveConfigured()) { console.error('Drive 未設定'); process.exit(1); }
function readKeyFile(p) { try { const raw = readFileSync(p,'utf8'); const i = raw.indexOf('AIza'); return (i >= 0 ? raw.slice(i) : raw).trim().split(/\s/)[0]; } catch { return ''; } }
// 稼働中の有効キー（WorkScope）を優先。次に .env。
const GEMINI_KEY = readKeyFile('C:/ProgramData/WorkScope/GEMINI_API_KEY.txt') || process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) { console.error('有効な GEMINI_API_KEY が見つかりません。'); process.exit(1); }
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---- 対象ファイル決定 ----
let targets = [];
if (ALL) {
  for (const sub of SUBS) {
    const dir = `${BASE}/${sub}`;
    let files; try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.toLowerCase().endsWith('.pdf') && !f.includes('読込済')) targets.push(`${dir}/${f}`);
  }
} else {
  targets = process.argv.slice(2).filter(a => a.toLowerCase().endsWith('.pdf'));
}
if (targets.length === 0) { console.error('対象PDFがありません。引数にパスか --all を指定。'); process.exit(1); }

// ---- 正規化・照合（register_certs と同等） ----
const KANJI_NUM={'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9'};
const normQual=s=>String(s||'').replace(/[（(].*?[)）]/g,'').replace(/[一二三四五六七八九]/g,m=>KANJI_NUM[m]).replace(/[\s　]/g,'').toLowerCase();
const normName=s=>String(s||'').normalize('NFKC').replace(/[\s　]/g,'').replace(/[斎斉齋齊]/g,'斉').replace(/[邉邊]/g,'辺').replace(/[髙]/g,'高').replace(/[祐佑]/g,'祐');
const cleanIso=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s||''))?s:null;

const { data: staff } = await sb.from('staff_master').select('id,name,company,birth_date');
const { data: quals } = await sb.from('qualification_master').select('id,name,category,has_expiry');
const qualByNorm = new Map(quals.map(q=>[normQual(q.name),q]));

// 高信頼の氏名OCR誤読 → 正しい社員名（曖昧なものは入れない＝誤割当回避）
const NAME_FIX_RAW={
  '早出幸晴':'早田幸晴','早田常晴':'早田幸晴','早田章晴':'早田幸晴',
  '栈原淳二':'桟原淳二','機原淳二':'桟原淳二','司機原淳二':'桟原淳二',
  '糸瀨廣範':'糸瀬廣範','糸瀬広平':'糸瀬廣範',
  '筑城尋雄':'築城尋雄','小宮沙耶華':'原田沙耶華','宮原恰也':'宮原怜也',
  '鳥居清':'島居清','中索康博':'中原康博','河内壁':'河内肇',
};
const NAME_FIX=new Map(Object.entries(NAME_FIX_RAW).map(([k,v])=>[String(k).normalize('NFKC').replace(/[\s　]/g,''),v]));
function matchStaff(name, birth) {
  const fixed=NAME_FIX.get(String(name||'').normalize('NFKC').replace(/[\s　]/g,''));
  const n=normName(fixed||name); if(!n) return null;
  let hits=staff.filter(s=>normName(s.name)===n);
  if(hits.length===1) return hits[0];
  if(hits.length>1 && birth){ const b=hits.filter(s=>s.birth_date===cleanIso(birth)); if(b.length===1) return b[0]; }
  if(hits.length>1) return hits[0];
  const part=staff.filter(s=>{const sn=normName(s.name);return sn.includes(n)||n.includes(sn);});
  return part.length===1?part[0]:null;
}
// qualification_master.id は "Q001" 形式の文字列PK（自動採番でない）。最大値+1で採番。
let nextQ = Math.max(0, ...quals.map(q=>/^Q(\d+)$/.test(q.id)?parseInt(q.id.slice(1),10):0));
async function ensureQual(name, expiry) {
  const key=normQual(name); if(!key) return null;
  if(qualByNorm.has(key)) return qualByNorm.get(key);
  for(const q of quals){const qk=normQual(q.name);if(qk&&(qk.includes(key)||key.includes(qk))) return q;}
  if(DRY) return {id:'(新規)',name,category:'その他',_new:true};
  // 名前の重複は既存を返す（冪等）
  const { data: dup } = await sb.from('qualification_master').select('*').eq('name',name).maybeSingle();
  if(dup){ qualByNorm.set(key,dup); return dup; }
  for(let tries=0; tries<5; tries++){
    const id='Q'+String(++nextQ).padStart(3,'0');
    const { data, error } = await sb.from('qualification_master').insert({id,name,category:'その他',has_expiry:!!cleanIso(expiry)}).select().single();
    if(!error){ quals.push(data); qualByNorm.set(key,data); return {...data,_new:true}; }
    if(error.code==='23505'){ // id か name の衝突。name衝突なら既存を返す
      const { data: ex } = await sb.from('qualification_master').select('*').eq('name',name).maybeSingle();
      if(ex){ qualByNorm.set(key,ex); return ex; }
      continue; // id衝突→次のidで再試行
    }
    throw error;
  }
  throw new Error('資格マスタID採番に失敗');
}

// ---- Gemini 抽出（server.js の extractCertificatePages を移植） ----
const PROMPT=[
 'これは日本の建設業における資格関連書類をまとめたPDF/画像です。',
 'ページを走査し、下記スキーマの配列をJSONで返してください。1つの要素は「1つの名簿」または「1つの証書」です。',
 '【最重要】1ページに複数の資格の名簿が並ぶ場合は資格ごとに別 roster 要素で返す。資格名を連結しない。',
 '【type】index:索引 / roster:資格名見出し＋氏名一覧 / certificate:免許証・合格証明書・修了証等の証書 / other',
 '【certificate要素】page(整数), person_name(姓名間の空白除去・読めねば空), ',
 ' qualification_name(★表題でなく本文から資格名を判断。例「1級技術検定合格証明書」→本文の種目+級で「1級建築施工管理技士」。施工管理技士系は○級△△施工管理技士=建築/土木/電気工事/管工事/造園/建設機械/電気通信工事。「○○技能講習修了証」→講習名、「二級建築士免許証」→二級建築士), ',
 ' cert_number, acquired_date(YYYY-MM-DD 和暦は西暦), expiry_date(YYYY-MM-DD), birth_date(YYYY-MM-DD), honseki, issuer。',
 '【roster要素】page, qualification_name(見出しの資格名そのまま・補は付け足さない), holders(氏名配列)。',
 '90度回転も補正して読む。読めない項目は空文字。推測で埋めない。',
].join('\n');
const SCHEMA={type:'ARRAY',items:{type:'OBJECT',properties:{page:{type:'INTEGER'},type:{type:'STRING',enum:['index','roster','certificate','other']},qualification_name:{type:'STRING'},holders:{type:'ARRAY',items:{type:'STRING'}},person_name:{type:'STRING'},cert_number:{type:'STRING'},acquired_date:{type:'STRING'},expiry_date:{type:'STRING'},birth_date:{type:'STRING'},honseki:{type:'STRING'},issuer:{type:'STRING'}},required:['page','type']}};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function geminiPages(buffer){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const body={contents:[{parts:[{text:PROMPT},{inlineData:{mimeType:'application/pdf',data:buffer.toString('base64')}}]}],generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:32768,responseSchema:SCHEMA}};
  let resp;
  for(let attempt=0; attempt<5; attempt++){
    resp=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(resp.status===429||resp.status===503){ const wait=15000*(attempt+1); console.warn(`  Gemini ${resp.status} レート制限。${wait/1000}s 待機して再試行(${attempt+1}/5)`); await sleep(wait); continue; }
    break;
  }
  if(!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0,200)}`);
  const j=await resp.json(); const cand=j?.candidates?.[0];
  if(cand?.finishReason==='MAX_TOKENS') throw new Error('MAX_TOKENS');
  const text=cand?.content?.parts?.[0]?.text; if(!text) throw new Error('空応答');
  const parsed=JSON.parse(text); if(!Array.isArray(parsed)) throw new Error('配列でない');
  await sleep(1500); // RPM 配慮の小休止
  return parsed;
}

// PDFの指定ページ範囲(0始まり, 半開区間)を単一PDFに
async function subPdf(srcDoc, from, to){
  const out=await PDFDocument.create();
  const idx=[]; for(let i=from;i<to;i++) idx.push(i);
  const pgs=await out.copyPages(srcDoc, idx);
  for(const p of pgs) out.addPage(p);
  return Buffer.from(await out.save());
}
async function onePage(srcDoc, i0){
  const out=await PDFDocument.create();
  const [p]=await out.copyPages(srcDoc,[i0]); out.addPage(p);
  return Buffer.from(await out.save());
}

let TOT={cert:0,ins:0,upd:0,kept:0,fail:0,newq:0,unmatched:[]};

async function processPdf(path){
  const name=path.split('/').pop();
  console.log(`\n===== ${name} =====`);
  const bytes=readFileSync(path);
  const doc=await PDFDocument.load(bytes);
  const N=doc.getPageCount();
  // 8ページずつ Gemini 解析、ページ番号を原本に補正
  const certPages=[]; // {page(原本1始まり), person_name, qualification_name, ...}
  for(let start=0; start<N; start+=CHUNK){
    const end=Math.min(start+CHUNK,N);
    let sub; try{ sub=await subPdf(doc,start,end); }catch(e){ console.warn(`  ページ抽出失敗 ${start+1}-${end}: ${e.message}`); continue; }
    let pages;
    try{ pages=await geminiPages(sub); }
    catch(e){ if(e.message==='MAX_TOKENS'){ // さらに2分割でリトライ
        for(let s2=start;s2<end;s2+=Math.ceil(CHUNK/2)){const e2=Math.min(s2+Math.ceil(CHUNK/2),end);try{const sb2=await subPdf(doc,s2,e2);const pg2=await geminiPages(sb2);for(const el of pg2){if(el.type==='certificate'){el.page=s2+((el.page||1)-1);certPages.push(el);}}}catch(err){console.warn(`  再分割失敗 ${s2+1}-${e2}: ${err.message}`);}}
        continue;
      } console.warn(`  Gemini失敗 ${start+1}-${end}: ${e.message}`); continue; }
    for(const el of pages){ if(el.type==='certificate'){ el.page=start+((el.page||1)-1); certPages.push(el); } } // el.page=原本0始まりインデックスに変換
  }
  console.log(`  ページ数 ${N} / 証書ページ ${certPages.length}`);

  for(const c of certPages){
    TOT.cert++;
    const st=matchStaff(c.person_name, c.birth_date);
    if(!st){ TOT.unmatched.push(`${name} p${c.page+1}: ${c.person_name||'?'} / ${c.qualification_name||'?'}`); TOT.fail++; console.log(`  ? 未照合 p${c.page+1}: ${c.person_name||'?'} (${c.qualification_name||'?'})`); continue; }
    let q=null;
    try{
      q=await ensureQual(c.qualification_name, c.expiry_date);
      if(!q){ TOT.fail++; console.log(`  ? 資格名読取不可 p${c.page+1}: ${st.name}`); continue; }
      if(q._new) TOT.newq++;
      const acquired=cleanIso(c.acquired_date), expiry=cleanIso(c.expiry_date);
      // 先に既存を確認し、アップロードが必要な時だけ Drive へ（重複での孤立ファイルを防ぐ）
      const {data:ex}= DRY ? {data:null} : await sb.from('staff_qualifications').select('*').eq('staff_id',st.id).eq('qualification_id',q.id).maybeSingle();
      const nk=acquired||expiry||'', ok=ex?(ex.acquired_date||ex.expiry_date||''):'';
      const willInsert=!ex, willUpdate=ex&&nk>ok, fillImage=ex&&!willUpdate&&!ex.cert_image_path;
      if(DRY){ console.log(`  [dry] ${st.name} / ${q.name}${q._new?'(新規)':''} 取得${acquired||'-'} 期限${expiry||'-'} p${c.page+1}`); TOT.ins++; continue; }

      let cert_image_path=null;
      if(willInsert||willUpdate||fillImage){
        const segs=[String(st.company||'会社未設定').replace(/[\\/:*?"<>|]/g,'_'),String(st.name).replace(/[\\/:*?"<>|]/g,'_')];
        const buf=await onePage(doc,c.page);
        const folderId=await ensureFolderPath(segs);
        const fileId=await driveUpload({name:`${Date.now()}-${randomUUID().slice(0,8)}.pdf`,buffer:buf,mimeType:'application/pdf',folderId});
        cert_image_path=`drive:${fileId}`;
      }
      const row={staff_id:st.id,qualification_id:q.id,acquired_date:acquired,expiry_date:expiry,cert_number:c.cert_number||null,issuer:c.issuer||null,honseki:c.honseki||null,cert_image_path};
      if(willInsert){ const {error}=await sb.from('staff_qualifications').insert(row); if(error) throw error; TOT.ins++; console.log(`  + ${st.name} / ${q.name}`); }
      else if(willUpdate){ const upd={...row}; for(const k of ['acquired_date','expiry_date','cert_number','issuer','honseki','cert_image_path']) if(upd[k]==null) upd[k]=ex[k]; const {error}=await sb.from('staff_qualifications').update(upd).eq('id',ex.id); if(error) throw error; TOT.upd++; console.log(`  ~ ${st.name} / ${q.name}（更新）`); }
      else{ if(fillImage&&cert_image_path) await sb.from('staff_qualifications').update({cert_image_path}).eq('id',ex.id); TOT.kept++; }
    }catch(e){ TOT.fail++; console.error(`  ! 失敗 ${st.name} / ${q?.name}: ${e.message}`); }
  }

  // 処理済みリネーム（成功時のみ・dryでは行わない・既に読込済なら二重付与しない）
  if(!DRY && !path.includes('読込済')){
    const renamed=path.replace(/\.pdf$/i,' 読込済_Claude.pdf');
    if(!existsSync(renamed)){ try{ renameSync(path,renamed); console.log(`  → リネーム: ${renamed.split('/').pop()}`);}catch(e){ console.warn(`  リネーム失敗: ${e.message}`);} }
  }
}

console.log(`対象 ${targets.length} ファイル${DRY?'  [dry-run]':''}`);
for(const t of targets){ try{ await processPdf(t); }catch(e){ console.error(`!! ${t.split('/').pop()} 全体失敗: ${e.message}`); } }

console.log(`\n========== 完了${DRY?'（dry-run）':''} ==========`);
console.log(`証書ページ ${TOT.cert} / 追加 ${TOT.ins} 更新 ${TOT.upd} 据置 ${TOT.kept} 失敗(未照合等) ${TOT.fail} / 新規資格マスタ ${TOT.newq}`);
if(TOT.unmatched.length){ console.log(`\n--- 未照合（要手当て） ${TOT.unmatched.length}件 ---`); for(const u of TOT.unmatched) console.log('  '+u); }
