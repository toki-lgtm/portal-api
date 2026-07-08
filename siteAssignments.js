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

// LINE発言群 → 現場別人員の配列を抽出する。
//   返り値: [{ site_name, work_content, members:[{name,company,count}], member_count, source_sender }]
export async function extractSiteAssignments(messages) {
  if (!GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY が未設定です。Render の環境変数に設定してください。');
    e.status = 503;
    throw e;
  }
  const input = buildAssignmentInput(messages);
  if (!input.trim()) return [];

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
    '- members: その現場に入る人員の配列。',
    '    ・個人名は name にそのまま入れ（敬称も本文のまま）、count は 1、company は空文字。',
    '    ・協力会社が「◯◯さん5名」「◯◯工業 3名」のように人数付きなら、name に会社名、company に会社名、count にその人数。',
    '- member_count: その現場に入る合計人数（個人名の数＋協力会社の人数の合計）。',
    '- source_sender: その現場を報告した【名前】。',
    '- 本文に書かれていない人を推測で足さないでください。読み取れない項目は空文字/空配列にしてください。',
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
      .map((m) => ({
        name: (m.name || '').trim(),
        company: (m.company || '').trim(),
        count: Number.isFinite(Number(m.count)) && Number(m.count) > 0 ? Math.round(Number(m.count)) : 1,
      }))
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
