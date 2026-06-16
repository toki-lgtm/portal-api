// ============================================================
// 法令集：取得対象カタログ（Phase 0）
//
// 取込パイプライン（regulations/sync.js）がこの定義を読み、
// e-Gov法令API v2（https://laws.e-gov.go.jp/api/2/）で法令IDを解決して
// 本文XMLを取得・構造化する。
//
// 方針:
//   - CORE_LAWS … 業務直結の必須法令。本法＋施行令＋施行規則を確実に投入し
//                 is_core=true で優先表示・優先同期する（Phase 1 対象）。
//   - SWEEP_CATEGORIES … 事項別分類コードによる広域取得（Phase 4 で拡張）。
//                 Supabase 無料枠の容量を計測しながら段階投入する。
//
// 出典: e-Gov法令検索（https://laws.e-gov.go.jp/）
// ============================================================

// 事項別分類コード → 日本語分野名（e-Gov の事項別分類）
export const CATEGORY_LABELS = {
  '19': '商業',
  '20': '労働',
  '22': '土地',
  '24': '金融・保険',
  '27': '都市計画',
  '32': '道路',
  '40': '社会保険',
  '43': '農業',
  '46': '民事',
  '47': '建築・住宅',
  '48': '林業',
};

// e-Gov法令種別 → 日本語ラベル
export const LAW_TYPE_LABELS = {
  Constitution: '憲法',
  Act: '法律',
  CabinetOrder: '政令',
  ImperialOrder: '勅令',
  MinisterialOrdinance: '省令',
  Rule: '規則',
};

// 本法に付帯する施行令・施行規則の名称サフィックス（紐付け推定用）
// 本法名 + サフィックス で law_title 部分一致検索し parent_law_id を構築する。
export const ENFORCEMENT_SUFFIXES = [
  { suffix: '施行令', relation: 'enforcement_order', law_type: 'CabinetOrder' },
  { suffix: '施行規則', relation: 'enforcement_regulation', law_type: 'MinisterialOrdinance' },
  { suffix: '施行細則', relation: 'enforcement_regulation', law_type: 'MinisterialOrdinance' },
];

// ── 必須コアリスト（業種別） ─────────────────────────────────
// title は e-Gov の正式名称に合わせる。withEnforcement=true の本法は
// 「{title}施行令」「{title}施行規則」も自動で探索・取込する。
export const CORE_LAWS = [
  // ── 建設・土木 ──────────────────────────────────────────
  { domain: '建設・土木', title: '建設業法', category: ['38', '47'], withEnforcement: true },
  { domain: '建設・土木', title: '建築基準法', category: ['47'], withEnforcement: true },
  { domain: '建設・土木', title: '建築士法', category: ['47'], withEnforcement: true },
  { domain: '建設・土木', title: '都市計画法', category: ['27'], withEnforcement: true },
  { domain: '建設・土木', title: '公共工事の品質確保の促進に関する法律', category: ['38'], withEnforcement: false },
  { domain: '建設・土木', title: '公共工事の入札及び契約の適正化の促進に関する法律', category: ['38'], withEnforcement: true },
  { domain: '建設・土木', title: '入札談合等関与行為の排除及び防止並びに職員による入札等の公正を害すべき行為の処罰に関する法律', category: ['38'], withEnforcement: false },
  { domain: '建設・土木', title: '建設工事に係る資材の再資源化等に関する法律', category: ['47'], withEnforcement: true },
  { domain: '建設・土木', title: '宅地造成及び特定盛土等規制法', category: ['22', '27'], withEnforcement: true },
  { domain: '建設・土木', title: '道路法', category: ['32'], withEnforcement: true },
  { domain: '建設・土木', title: '河川法', category: ['22'], withEnforcement: true },
  { domain: '建設・土木', title: '砂防法', category: ['22'], withEnforcement: true },
  { domain: '建設・土木', title: '測量法', category: ['22'], withEnforcement: true },
  { domain: '建設・土木', title: '土壌汚染対策法', category: ['22'], withEnforcement: true },

  // ── 不動産 ──────────────────────────────────────────────
  { domain: '不動産', title: '宅地建物取引業法', category: ['22', '47'], withEnforcement: true },
  { domain: '不動産', title: '借地借家法', category: ['46'], withEnforcement: false },
  { domain: '不動産', title: '建物の区分所有等に関する法律', category: ['46'], withEnforcement: false },
  { domain: '不動産', title: '不動産登記法', category: ['46'], withEnforcement: true },
  { domain: '不動産', title: '国土利用計画法', category: ['22', '27'], withEnforcement: true },
  { domain: '不動産', title: 'マンションの管理の適正化の推進に関する法律', category: ['47'], withEnforcement: true },

  // ── 林業 ────────────────────────────────────────────────
  { domain: '林業', title: '森林法', category: ['48'], withEnforcement: true },
  { domain: '林業', title: '森林・林業基本法', category: ['48'], withEnforcement: false },
  { domain: '林業', title: '都市の低炭素化の促進に関する法律', category: ['47'], withEnforcement: true },
  { domain: '林業', title: '脱炭素社会の実現に資する等のための建築物等における木材の利用の促進に関する法律', category: ['48'], withEnforcement: false },

  // ── 労務・安全 ──────────────────────────────────────────
  { domain: '労務・安全', title: '労働基準法', category: ['20'], withEnforcement: true },
  { domain: '労務・安全', title: '労働安全衛生法', category: ['20'], withEnforcement: true },
  { domain: '労務・安全', title: '労働契約法', category: ['20'], withEnforcement: false },
  { domain: '労務・安全', title: '労働者災害補償保険法', category: ['20', '40'], withEnforcement: true },
  { domain: '労務・安全', title: '雇用保険法', category: ['20', '40'], withEnforcement: true },
  { domain: '労務・安全', title: '労働者派遣事業の適正な運営の確保及び派遣労働者の保護等に関する法律', category: ['20'], withEnforcement: true },
  { domain: '労務・安全', title: '最低賃金法', category: ['20'], withEnforcement: true },
  { domain: '労務・安全', title: '健康保険法', category: ['40'], withEnforcement: true },
  { domain: '労務・安全', title: '厚生年金保険法', category: ['40'], withEnforcement: true },
  { domain: '労務・安全', title: '高年齢者等の雇用の安定等に関する法律', category: ['20'], withEnforcement: true },
  { domain: '労務・安全', title: '育児休業、介護休業等育児又は家族介護を行う労働者の福祉に関する法律', category: ['20'], withEnforcement: true },

  // ── 会社経営・民商法 ────────────────────────────────────
  { domain: '会社経営・民商法', title: '民法', category: ['46'], withEnforcement: false },
  { domain: '会社経営・民商法', title: '商法', category: ['19'], withEnforcement: false },
  { domain: '会社経営・民商法', title: '会社法', category: ['19'], withEnforcement: true },
  { domain: '会社経営・民商法', title: '商業登記法', category: ['19'], withEnforcement: true },
  { domain: '会社経営・民商法', title: '下請代金支払遅延等防止法', category: ['38'], withEnforcement: false },
  { domain: '会社経営・民商法', title: '私的独占の禁止及び公正取引の確保に関する法律', category: ['38'], withEnforcement: true },
  { domain: '会社経営・民商法', title: '個人情報の保護に関する法律', category: ['46'], withEnforcement: true },
  { domain: '会社経営・民商法', title: '印紙税法', category: ['24'], withEnforcement: true },
  { domain: '会社経営・民商法', title: '電子計算機を使用して作成する国税関係帳簿書類の保存方法等の特例に関する法律', category: ['24'], withEnforcement: true },

  // ── 環境 ────────────────────────────────────────────────
  { domain: '環境', title: '廃棄物の処理及び清掃に関する法律', category: ['22'], withEnforcement: true },
  { domain: '環境', title: '騒音規制法', category: ['22'], withEnforcement: true },
  { domain: '環境', title: '振動規制法', category: ['22'], withEnforcement: true },
  { domain: '環境', title: '大気汚染防止法', category: ['22'], withEnforcement: true },
  { domain: '環境', title: '水質汚濁防止法', category: ['22'], withEnforcement: true },
];

// ── 広域取得（Phase 4 拡張用） ──────────────────────────────
// 指定カテゴリの全法令（本法・政令・省令）を取得し索引化する。
// 容量計測のうえ段階的に有効化する。
export const SWEEP_CATEGORIES = ['20', '22', '27', '47', '48', '46', '19'];
export const SWEEP_LAW_TYPES = ['Act', 'CabinetOrder', 'MinisterialOrdinance', 'Rule'];

// e-Gov法令API v2 のベースURL・呼び出し時の推奨ウェイト（ms）
export const EGOV_API_BASE = 'https://laws.e-gov.go.jp/api/2';
export const EGOV_REQUEST_DELAY_MS = 300;

// Google Drive 保存先（社内システム/法令集/ 配下）
export const DRIVE_ROOT_SEGMENTS = ['社内システム', '法令集'];
export const DRIVE_SUBDIRS = {
  xml: 'xml',             // 原本XML
  attachments: 'attachments', // 別表・様式（PDF/JPG）
  snapshots: 'snapshots', // 月次同期ログ
};

export const SOURCE_ATTRIBUTION = '出典：e-Gov法令検索（https://laws.e-gov.go.jp/）';
