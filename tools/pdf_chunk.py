# PDF を任意のページ範囲で切り出す（過去工事アーカイブ セグメント抽出の前処理）。
# 引数は JSON ファイル経由（日本語パスの argv 文字化けを避ける）。
#   python pdf_chunk.py <args.json>
#   args.json = {"input": "<PDFパス>", "out_dir": "<出力先(ASCII)>",
#                "ranges": [[start,end], ...]}   # 1始まり・両端含む。省略で page_count のみ返す
# 標準出力に JSON: {"page_count": N, "files": [{"file","start_page","end_page"}]}
import sys, json, os
import fitz  # PyMuPDF

def main():
    args = json.load(open(sys.argv[1], encoding='utf-8'))
    doc = fitz.open(args['input'])
    n = doc.page_count
    res = {'page_count': n}
    ranges = args.get('ranges')
    if ranges:
        out = args['out_dir']
        os.makedirs(out, exist_ok=True)
        files = []
        for s, e in ranges:
            s = max(1, int(s)); e = min(n, int(e))
            if e < s:
                continue
            nd = fitz.open()
            nd.insert_pdf(doc, from_page=s - 1, to_page=e - 1)
            f = os.path.join(out, f'r_{s}_{e}.pdf')
            nd.save(f, deflate=True, garbage=3)
            nd.close()
            files.append({'file': f, 'start_page': s, 'end_page': e})
        res['files'] = files
    doc.close()
    sys.stdout.write(json.dumps(res))

if __name__ == '__main__':
    main()
