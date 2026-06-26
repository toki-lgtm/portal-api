// WorkScope 導入状況の点検（読み取り専用）。
//   node check_workscope.mjs            # 最近のDL/同意/release
//   node check_workscope.mjs 里加        # 名前/メールで絞り込み
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const q = (process.argv[2] || '').toLowerCase();
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const match = (r) =>
  !q ||
  String(r.user_name || '').toLowerCase().includes(q) ||
  String(r.user_email || '').toLowerCase().includes(q);

const { data: rel } = await s.from('workscope_release')
  .select('version,uploaded_at').order('uploaded_at', { ascending: false }).limit(1).maybeSingle();
console.log('現行インストーラ:', rel ? `v${rel.version}` : '(なし)');

const { data: dl } = await s.from('workscope_downloads')
  .select('user_name,user_email,version,created_at').order('created_at', { ascending: false }).limit(50);
console.log('\n=== ダウンロード ===');
for (const r of (dl || []).filter(match)) console.log(`${r.created_at}  ${r.user_name || ''}  ${r.user_email}  v${r.version}`);

const { data: cs } = await s.from('workscope_consents')
  .select('user_name,user_email,eula_version,agreed_at').order('agreed_at', { ascending: false }).limit(50);
console.log('\n=== 同意 ===');
for (const r of (cs || []).filter(match)) console.log(`${r.agreed_at}  ${r.user_name || ''}  ${r.user_email}  版${r.eula_version}`);

process.exit(0);
