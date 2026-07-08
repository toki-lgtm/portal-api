// ============================================================
// 翌日の現場別人員 抽出モジュール
//   各現場監督が夕方にグループLINEへ流す「翌営業日の作業予定＋人員」投稿を
//   Gemini で構造化する。cron(cron/lineExtractAssignments.js)と server.js の
//   両方から使えるよう、server.js には依存しない自己完結モジュールにする。
//
//   投稿の型（実例より）:
//     お疲れ様です。
//     <現場名>（＋曜日のことも）
//     <作業内容>
//
//     <人員: 個人名の列挙。協力会社は「◯◯さん5名」等の人数付き>
//   ・1投稿に複数現場が入ることがある（例: ユーティリティ工事＋関商店）。
//   ・挨拶・雑談・写真説明は無視する。
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// 個々の発言を Gemini に渡すテキストに整形する。
//   messages: [{ sender_name, sent_at, text }]（時系列）
export function buildAssignmentInput(messages) {
  const blocks = [];
  for (const m of messages) {
    const text = (m.text || '').trim();
    if (!text) continue;
    let hhmm = '';
    if (m.sent_at) {
      const jst = new Date(new Date(m.sent_at).getTime() + 9 * 3600 * 1000);
      hhmm = jst.toISOString().slice(11, 16); // HH:MM(JST)
    }
    blocks.push(`【${m.sender_name || '不明'}】(${hhmm})\n${text}`);
  }
  return blocks.join('\n----\n');
}

// members 配列から合計人数を計算（count 省略時は1名として数える）。
export function sumMembers(members) {
  if (!Array.isArray(members)) return 0;
  return members.reduce((acc, x) => {
    const c = Number(x?.count);
    return acc + (Number.isFinite(c) && c > 0 ? Math.round(c) : 1);
  }, 0);
}

// 社員名簿（在籍者の氏名＋ふりがな）を取得。名前照合の照合元に使う。
//   supabase を引数で受け取り、モジュールを server.js 非依存に保つ。
export async function loadStaffRoster(supabase) {
  try {
    const { data } = await supabase
      .from('staff_master')
      .select('name, furigana')
      .eq('is_active', true);
    return (data || [])
      .filter((r) => (r.name || '').trim())
      .map((r) => ({ name: r.name.trim(), furigana: (r.furigana || '').trim() }));
  } catch {
    return [];
  }
}

// 呼び名→正式氏名の対応表を取得。抽出後にコード側で確定的に置き換える。
export async function loadNameAliases(supabase) {
  try {
    const { data } = await supabase.from('name_aliases').select('alias, full_name');
    const map = new Map();
    for (const r of data || []) {
      if ((r.alias || '').trim() && (r.full_name || '').trim()) {
        map.set(r.alias.trim(), r.full_name.trim());
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// LINE発言群 → 現場別人員の配列を抽出する。
//   roster: [{name, furigana}] を渡すと、人員名を社員名簿の正式氏名へ寄せる（曖昧なら元の呼び名のまま）。
//   aliases: Map<呼び名, 正式氏名>。AI結果より優先してコード側で確定置き換えする。
//   返り値: [{ site_name, work_content, members:[{name,raw_name,company,count,matched}], member_count, source_sender }]
export async function extractSiteAssignments(messages, roster = [], aliases = new Map()) {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY が未設定です。Render の環境変数に設定してください。');
    e.status = 503;
    throw e;
  }
  const input = buildAssignmentInput(messages);
  if (!input.trim()) return [];

  // 名簿ブロック（氏名（ふりがな）を列挙）。照合の手掛かりにする。
  const rosterBlock = (roster || [])
    .map((r) => (r.furigana ? `${r.name}（${r.furigana}）` : r.name))
    .join('\n');

  const prompt = [
    'これは日本の建設会社の社内LINEグループで、各現場監督が「翌営業日の作業予定と人員配置」を報告した発言の集まりです。',
    '各発言は「----」で区切られ、先頭の【名前】がその発言をした現場監督（＝報告者）です。',
    '内容を読み取り、翌営業日に「どの現場に・誰が入るか」を現場ごとに JSON で返してください。',
    '',
    '# ルール',
    '- 1つの発言に複数の現場が含まれることがあります（現場名ごとに分けて出力）。',
    '- ただし、複数の現場名が続けて書かれ、その後の人員が1組だけの場合は、同じ班が複数箇所を担当する1件の作業とみなし、site_name を「市営漁港・小綱漁港」のように連結して1件にまとめてください（人員を各現場に重複計上しない）。',
    '- 「〜完了」「〜済み」など既に終わった作業ではなく、翌営業日に行う作業と人員を対象にしてください（例:「◯◯完了。明日は△△に行きます」なら現場は△△）。',
    '- 挨拶（お疲れ様です等）、雑談、写真だけの投稿、無関係な連絡は無視してください。',
    '- site_name: 現場名（例: 目達原（6）、国道382号共同溝(その2)、関商店 など本文の表記のまま）。',
    '- work_content: その現場の作業内容を簡潔に（本文の要約でよい）。',
    '- members: その現場に入る人員の配列。各要素は次のとおり。',
    '    ・raw_name: 本文中の呼び名をそのまま（例: 弘さん、ヒロミ、北森くん）。',
    '    ・name: 下の「社員名簿」に確実に一致する社員がいれば、その正式氏名に置き換える（matched=true）。',
    '            姓・下の名前・敬称(さん/くん)を外した漢字表記で、名簿と1人に特定できれば置き換える。',
    '            ただし、カタカナ/ひらがなだけの通称（例: ヒロミ、りえ、ぶんじゅ）は、名簿に同じ読みの「ふりがな」が登録されている場合のみ置き換える。',
    '            漢字の当て字・読みの推測だけで別姓の社員に結び付けてはいけない（例: カタカナ「ヒロミ」を、氏名が「廣美」というだけの別人に当てない）。',
    '            該当者がいない、候補が複数で1人に絞れない、確証がない場合は、置き換えずに raw_name と同じ呼び名を入れ matched=false。',
    '    ・matched: 名簿の社員に確定できたら true、できなければ false。',
    '    ・company: 協力会社なら会社名、社員・個人なら空文字。',
    '    ・count: 個人は 1。協力会社が「◯◯さん5名」「◯◯工業 3名」のように人数付きなら、name/raw_name に会社名・company に会社名・count にその人数。',
    '- 協力会社（会社名）は社員名簿と照合しない（matched=false のまま）。',
    '- member_count: その現場に入る合計人数（個人名の数＋協力会社の人数の合計）。',
    '- source_sender: その現場を報告した【名前】（これも名簿に一致すれば正式氏名に）。',
    '- 本文に書かれていない人を推測で足さないでください。読み取れない項目は空文字/空配列にしてください。',
    '',
    '# 社員名簿（氏名（ふりがな）。人員名の照合に使う。ここに無ければ置き換えない）',
    rosterBlock || '（名簿なし）',
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: `${prompt}\n\n# 発言\n${input}` }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          assignments: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                site_name: { type: 'STRING' },
                work_content: { type: 'STRING' },
                members: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      name: { type: 'STRING' },
                      raw_name: { type: 'STRING' },
                      matched: { type: 'BOOLEAN' },
                      company: { type: 'STRING' },
                      count: { type: 'INTEGER' },
                    },
                    required: ['name'],
                  },
                },
                member_count: { type: 'INTEGER' },
                source_sender: { type: 'STRING' },
              },
              required: ['site_name'],
            },
          },
        },
        required: ['assignments'],
      },
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    const e = new Error(`Gemini API エラー (${resp.status}): ${t.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini から有効な応答が得られませんでした');
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('Gemini 応答の解析に失敗しました'); }

  const out = [];
  for (const a of p.assignments || []) {
    const site = (a.site_name || '').trim();
    if (!site) continue;
    const members = (Array.isArray(a.members) ? a.members : [])
      .map((m) => {
        const gName = (m.name || '').trim();
        const raw = (m.raw_name || '').trim() || gName;
        const company = (m.company || '').trim();
        // 対応表が最優先: 呼び名(raw)またはAI判定名(gName)が登録済みなら確定置き換え。
        // 協力会社は対象外。
        const aliasHit = !company ? (aliases.get(raw) || aliases.get(gName)) : null;
        return {
          name: aliasHit || gName || raw,
          raw_name: raw,
          matched: aliasHit ? true : !!m.matched,
          company,
          count: Number.isFinite(Number(m.count)) && Number(m.count) > 0 ? Math.round(Number(m.count)) : 1,
        };
      })
      .filter((m) => m.name);
    const declared = Number(a.member_count);
    const member_count = Number.isFinite(declared) && declared > 0 ? Math.round(declared) : sumMembers(members);
    out.push({
      site_name: site,
      work_content: (a.work_content || '').trim(),
      members,
      member_count,
      source_sender: (a.source_sender || '').trim(),
    });
  }
  return out;
}

// company_holidays（公休日・計画有給）を「非稼働日」とみなし、fromDate の翌稼働日を返す。
//   fromDate: 'YYYY-MM-DD'（この日は含めず、翌日以降で最初の稼働日）。
//   holidays が取れない場合は単純に翌日を返す（安全側＝止めない）。
export async function nextWorkingDay(supabase, fromDate) {
  const start = new Date(`${fromDate}T00:00:00+09:00`);
  // 最大14日先まで探索（連休・年末年始を跨いでも決まる範囲）
  const candidates = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(start.getTime() + i * 24 * 3600 * 1000);
    candidates.push(new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10));
  }
  let holidaySet = new Set();
  try {
    const { data } = await supabase
      .from('company_holidays')
      .select('day')
      .in('day', candidates);
    holidaySet = new Set((data || []).map((r) => r.day));
  } catch {
    // 休日データが取れなければ翌日をそのまま返す
    return candidates[0];
  }
  for (const c of candidates) {
    if (!holidaySet.has(c)) return c;
  }
  return candidates[0];
}
