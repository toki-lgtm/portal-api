// ===== Google Drive（共有ドライブ）ストレージ連携 =====
//
// 社内ポータルの「標準ストレージ方針」（重いファイルは Google Workspace 共有ドライブへ、
// 構造化データは Supabase 無料枠）を実現するための低レベルヘルパー。
//
// 既存コード（Gemini 連携）と同じく SDK を足さず、Node 標準の crypto と fetch で
// サービスアカウント認証（JWT → アクセストークン）と Drive REST を直接叩く。
//
// 必要な環境変数:
//   GOOGLE_SERVICE_ACCOUNT_JSON … サービスアカウントの鍵JSON（中身そのものを1行で）
//   DRIVE_FOLDER_ID             … 保存先フォルダ（共有ドライブ「社内システム」配下）のID
//
// 共有ドライブ（Shared Drive）配下のため、すべての API 呼び出しに
// supportsAllDrives=true を付ける点に注意。

import { createSign } from 'crypto';
import { readFileSync } from 'fs';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let cachedCreds = null;
function loadCreds() {
  if (cachedCreds) return cachedCreds;
  // 鍵の渡し方は2通り: 環境変数に中身を直接（Render向け）/ ファイルパス指定（ローカル向け）。
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw && process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    raw = readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
  }
  if (!raw) {
    const e = new Error('GOOGLE_SERVICE_ACCOUNT_JSON（中身）または GOOGLE_SERVICE_ACCOUNT_FILE（鍵JSONのパス）を設定してください。');
    e.status = 503;
    throw e;
  }
  try {
    cachedCreds = JSON.parse(raw);
  } catch {
    const e = new Error('GOOGLE_SERVICE_ACCOUNT_JSON のJSON解析に失敗しました。鍵JSONの中身をそのまま設定してください。');
    e.status = 500;
    throw e;
  }
  return cachedCreds;
}

let cachedToken = null; // { token, expMs }
async function getAccessToken() {
  if (cachedToken && cachedToken.expMs > Date.now() + 60_000) return cachedToken.token;

  const creds = loadCreds();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(creds.private_key));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive 認証に失敗しました（${res.status}）: ${text}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expMs: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// ファイルを共有ドライブのフォルダへアップロードし、fileId を返す。
// folderId 省略時は DRIVE_FOLDER_ID 直下に保存する。
export async function driveUpload({ name, buffer, mimeType, folderId }) {
  const parent = folderId || process.env.DRIVE_FOLDER_ID;
  if (!parent) {
    const e = new Error('DRIVE_FOLDER_ID が未設定です。共有ドライブの保存先フォルダIDを設定してください。');
    e.status = 503;
    throw e;
  }
  const token = await getAccessToken();
  const boundary = `boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadata = { name, parents: [parent] };

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive へのアップロードに失敗しました（${res.status}）: ${text}`);
  }
  const data = await res.json();
  return data.id;
}

// 既存ファイルの中身（メディア）だけを差し替える。fileId は不変なので
// DB の drive:<id> 参照はそのまま、画像の向き補正など「中身の作り直し」に使う。
export async function driveUpdateMedia(fileId, buffer, mimeType) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=id`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: buffer,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive メディア更新に失敗しました（${res.status}）: ${text}`);
  }
  return res.json();
}

// Drive 検索クエリ内のシングルクォートをエスケープする。
function escapeQ(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// 親フォルダ直下に name のサブフォルダを探し、無ければ作成して fileId を返す。
// ★ キャッシュには「Promise」を入れる。一括スキャンのように同じフォルダを同時(並列)に
//   要求しても、最初の1件だけが検索+作成し、残りは同じ Promise を待つ＝重複フォルダを防ぐ。
//   （結果値だけをキャッシュすると、並列呼び出しが全員「検索→無い→作成」を走らせて重複する）
const folderCache = new Map(); // key: `${parentId}/${name}` -> Promise<folderId>
export function ensureFolder(name, parentId) {
  const parent = parentId || process.env.DRIVE_FOLDER_ID;
  if (!parent) return Promise.reject(new Error('DRIVE_FOLDER_ID が未設定です。'));
  const key = `${parent}/${name}`;
  const cached = folderCache.get(key);
  if (cached) return cached;
  // 失敗時はキャッシュから外して次回リトライ可能にする
  const p = resolveFolder(name, parent).catch((e) => { folderCache.delete(key); throw e; });
  folderCache.set(key, p);
  return p;
}

async function resolveFolder(name, parent) {
  const token = await getAccessToken();
  // 1) 既存検索
  const q = `name='${escapeQ(name)}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + '&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1';
  const sres = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (sres.ok) {
    const sdata = await sres.json();
    if (sdata.files && sdata.files.length > 0) return sdata.files[0].id;
  }
  // 2) 無ければ作成
  const cres = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  });
  if (!cres.ok) {
    const text = await cres.text();
    throw new Error(`Drive フォルダ作成に失敗（${name}, ${cres.status}）: ${text}`);
  }
  const cdata = await cres.json();
  return cdata.id;
}

// fileId のメタ情報を取得する（name/parents 等）。フォルダ階層の特定やジョブ状態ファイルの
// 解決に使う汎用ヘルパ。fields はカンマ区切り（既定 id,name,parents）。
export async function driveFileMeta(fileId, fields = 'id,name,parents') {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
    + `?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive メタ取得に失敗（${res.status}）: ${await res.text()}`);
  return res.json();
}

// 親フォルダ直下の子（フォルダ/ファイル）を全件返す（ページング対応）。掃除・点検用。
export async function driveListChildren(parentId) {
  const parent = parentId || process.env.DRIVE_FOLDER_ID;
  const token = await getAccessToken();
  const out = [];
  let pageToken = '';
  do {
    const q = `'${parent}' in parents and trashed=false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
      + '&fields=nextPageToken,files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000'
      + (pageToken ? `&pageToken=${pageToken}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive 一覧取得に失敗（${res.status}）: ${await res.text()}`);
    const data = await res.json();
    out.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

// サービスアカウントが参加している共有ドライブ一覧 [{id,name}] を返す。
export async function driveListSharedDrives() {
  const token = await getAccessToken();
  const res = await fetch('https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`共有ドライブ一覧取得に失敗（${res.status}）: ${await res.text()}`);
  return (await res.json()).drives || [];
}

// 共有ドライブ横断でフォルダを名前検索する（[{id,name,driveId,parents}]）。
//   親フォルダの指定が無いとき（収集用「データ保管」等）の解決に使う。
export async function driveFindFolderByName(name) {
  const token = await getAccessToken();
  const q = `name='${escapeQ(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + '&fields=files(id,name,driveId,parents)&corpora=allDrives&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=20';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive 検索に失敗（${res.status}）: ${await res.text()}`);
  return (await res.json()).files || [];
}

// ファイル/フォルダの名前を変更する（fileId は不変＝DBの drive:<id> 参照は壊れない）。
export async function driveRename(fileId, newName) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    },
  );
  if (!res.ok) throw new Error(`Drive 改名に失敗（${res.status}）: ${await res.text()}`);
  return res.json();
}

// ファイル/フォルダを別の親へ移動する（fileId は不変＝DBの drive:<id> 参照は壊れない）。
export async function driveMove(fileId, addParentId, removeParentId) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`
    + `&addParents=${encodeURIComponent(addParentId)}`
    + (removeParentId ? `&removeParents=${encodeURIComponent(removeParentId)}` : '')
    + '&fields=id,parents';
  const res = await fetch(url, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive 移動に失敗（${res.status}）: ${await res.text()}`);
  return res.json();
}

// ["中原建設","田中太郎"] のような階層を順に ensureFolder して、末端フォルダの fileId を返す。
export async function ensureFolderPath(segments, rootId) {
  let parent = rootId || process.env.DRIVE_FOLDER_ID;
  for (const seg of segments) {
    if (!seg) continue;
    parent = await ensureFolder(seg, parent);
  }
  return parent;
}

// fileId のファイル本体を取得して { buffer, contentType } を返す（API経由のストリーム配信用）。
export async function driveDownload(fileId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    const e = new Error(`Drive からの取得に失敗しました（${res.status}）: ${text}`);
    e.status = res.status === 404 ? 404 : 502;
    throw e;
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

// 大容量ファイル向け：本体をメモリに溜めず、Drive のレスポンス（fetch Response）を
// そのまま返す。呼び出し側が res.body をクライアントへストリーム転送する。
//   range を渡すと Drive へ Range ヘッダを転送し、部分取得（206）に対応する。
//   → PDFビューア等が必要な範囲だけ取得でき、Render のメモリを圧迫しない。
export async function driveStreamMedia(fileId, { range } = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = range;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers },
  );
  return res; // 呼び出し側で res.ok / res.status / res.headers / res.body を扱う
}

// fileId の「軽量サムネイル」を取得して { buffer, contentType } を返す。
// Drive が自動生成する thumbnailLink を size px（長辺）でリサイズ取得する。
// 一覧表示などフル解像度が不要な場面用（2.6MB → 数十KB に軽量化）。
// サムネイルが無い場合は本体（driveDownload）にフォールバックする。
export async function driveThumbnail(fileId, size = 600) {
  const token = await getAccessToken();
  const mres = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=thumbnailLink&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (mres.ok) {
    const meta = await mres.json();
    if (meta.thumbnailLink) {
      const link = meta.thumbnailLink.includes('=s')
        ? meta.thumbnailLink.replace(/=s\d+(-c)?$/, `=s${size}`)
        : `${meta.thumbnailLink}=s${size}`;
      const tres = await fetch(link, { headers: { Authorization: `Bearer ${token}` } });
      if (tres.ok) {
        const contentType = tres.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await tres.arrayBuffer());
        return { buffer, contentType };
      }
    }
  }
  // サムネ未生成などは本体取得にフォールバック
  return driveDownload(fileId);
}

// fileId をゴミ箱へ移動する（trashed=true）。共有ドライブの「投稿者」権限でも実行可能で、
// 30日間は復元可能。※完全削除(driveDelete)は「管理者」権限が必要なため、通常はこちらを使う。
export async function driveTrash(fileId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Drive のゴミ箱移動に失敗しました（${res.status}）: ${text}`);
  }
}

// fileId のファイルを完全削除する（移行や差し替え時の後始末用）。
// 注: 共有ドライブでは「管理者」権限が必要。投稿者権限だと 404 になるため driveTrash を推奨。
export async function driveDelete(fileId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Drive の削除に失敗しました（${res.status}）: ${text}`);
  }
}

// Drive 連携が使える状態か（鍵 と 保存先フォルダID が揃っているか）を返す。
export function driveConfigured() {
  const hasKey = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
  return Boolean(hasKey && process.env.DRIVE_FOLDER_ID);
}
