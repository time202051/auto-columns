import * as vscode from "vscode";
import { extractSwaggerObjectMaps } from "./jsReadByAst";
export function findBasicImport(text: string): { modulePath: string } | null {
  // 匹配：import { Basic } from '...swagger...'
  const re = /import\s*\{\s*Basic\s*\}\s*from\s*['"]([^'"]*swagger[^'"]*)['"]/g;
  const m = re.exec(text);
  if (!m) return null;
  return { modulePath: m[1] };
}

export function collectBasicKeys(text: string): string[] {
  const keys = new Set<string>();
  // Basic.xxx
  const dotRe = /\bBasic\.(\w+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = dotRe.exec(text))) {
    keys.add(m[1]);
  }
  // Basic['xxx'] 或 Basic["xxx"]
  const bracketRe = /\bBasic\[['"](\w+)['"]\]/g;
  while ((m = bracketRe.exec(text))) {
    keys.add(m[1]);
  }
  return Array.from(keys);
}

export async function resolveBasicUrlMap(
  importPath: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) return map;

  for (const f of folders) {
    const root = f.uri;
    const candidates = buildImportCandidates(root, importPath);
    for (const uri of candidates as any) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat) {
          const buf = await vscode.workspace.fs.readFile(uri);
          const code = Buffer.from(buf).toString("utf8");
          extractBasicObjectUrls(code, map);
          if (map.size > 0) return map;
        }
      } catch {
        // ignore not found
      }
    }
  }
  return map;
}

export function extractBasicObjectUrls(code: string, out: Map<string, string>) {
  // 在被导入模块里找：
  // export const Basic = { key: '/api/xxx', ... }
  // 允许有换行和注释，先定位到对象文本，再提取键值对（仅处理字符串字面量）
  const objRe = /export\s+(?:const|let|var)\s+Basic\s*=\s*\{([\s\S]*?)\}\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(code))) {
    const body = m[1];
    // 匹配：key: 'xxx' 或 "xxx"
    const kvRe = /(\w+)\s*:\s*['"]([^'"]+)['"]/g;
    let kv: RegExpExecArray | null;
    while ((kv = kvRe.exec(body))) {
      const k = kv[1];
      const v = kv[2];
      out.set(k, v);
    }
  }

  // 兼容：先定义 Basic，再 export { Basic }
  if (out.size === 0) {
    const defRe = /(?:const|let|var)\s+Basic\s*=\s*\{([\s\S]*?)\}\s*;?/g;
    while ((m = defRe.exec(code))) {
      const body = m[1];
      const kvRe = /(\w+)\s*:\s*['"]([^'"]+)['"]/g;
      let kv: RegExpExecArray | null;
      while ((kv = kvRe.exec(body))) {
        out.set(kv[1], kv[2]);
      }
    }
  }
}

export function extractAllExportedObjectUrls(code: string): string[] {
  const urls: string[] = [];
  // 解析 baseURL
  let baseURL = "";
  {
    const m = /const\s+baseURL\s*=\s*['"]([^'"]*)['"]/.exec(code);
    if (m) baseURL = m[1] || "";
  }

  // 遍历所有 export const X = { ... }
  const objRe = /export\s+(?:const|let|var)\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(code))) {
    const body = m[2];

    // 抽取属性值：支持
    // - 模板字符串 `...${baseURL}...` 或 `...`
    // - 拼接 baseURL + '...'
    // - 纯字符串 '...' / "..."
    const kvRe = /(\w+)\s*:\s*([^,]+)\s*(?:,|$)/g;
    let kv: RegExpExecArray | null;
    while ((kv = kvRe.exec(body))) {
      const rawVal = kv[2].trim();

      // 1) 模板字符串
      let t = /^`([^`]*)`$/.exec(rawVal);
      if (t) {
        let s = t[1];
        // 仅处理 ${baseURL} 占位；其余占位保留原样
        s = s.replace(/\$\{\s*baseURL\s*\}/g, baseURL);
        urls.push(s);
        continue;
      }
      // 2) baseURL + '...'
      t = /^baseURL\s*\+\s*['"]([^'"]+)['"]$/.exec(rawVal);
      if (t) {
        urls.push(baseURL + t[1]);
        continue;
      }
      // 3) '...' 或 "..."
      t = /^['"]([^'"]+)['"]$/.exec(rawVal);
      if (t) {
        urls.push(t[1]);
        continue;
      }
      // 4) 其它复杂表达式暂不处理
    }
  }

  return urls;
}

export async function resolveSwaggerObjectMaps(
  importPath: string,
  fromDoc?: vscode.Uri
): Promise<Map<string, Map<string, string>>> {
  const result = new Map<string, Map<string, string>>();
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) return result;

  // 以“当前文档所在 workspace 根”为优先
  const roots: vscode.Uri[] = [];
  if (fromDoc) {
    const ws = vscode.workspace.getWorkspaceFolder(fromDoc);
    if (ws) roots.push(ws.uri);
  }
  for (const f of folders) {
    if (!roots.find((r) => r.toString() === f.uri.toString()))
      roots.push(f.uri);
  }

  // 1) 基于规则（包含 "@/"" -> "<root>/src"）尝试候选文件
  for (const root of roots) {
    const candidates = await buildImportCandidates(root, importPath, fromDoc);

    for (const uri of candidates) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);

        if (!stat) continue;
        const buf = await vscode.workspace.fs.readFile(uri);
        const code = Buffer.from(buf).toString("utf8");

        const map = extractSwaggerObjectMaps(code);

        if (map.size > 0) return map;
      } catch {
        // ignore
      }
    }
  }

  // 2) 自动全局搜索并选择“距离当前文档最近”的文件
  const auto = await autoFindSwaggerFile(importPath, fromDoc);
  if (auto) {
    try {
      const buf = await vscode.workspace.fs.readFile(auto);
      const code = Buffer.from(buf).toString("utf8");
      const map = extractSwaggerObjectMaps(code);
      if (map.size > 0) return map;
    } catch {}
  }

  // 3) 兜底：让用户手动选择一次（保留）
  try {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "选择 swagger 文件",
      filters: { "JS/TS": ["js", "ts", "mjs", "cjs"] },
    });
    if (picked && picked[0]) {
      const buf = await vscode.workspace.fs.readFile(picked[0]);
      const code = Buffer.from(buf).toString("utf8");
      const map = extractSwaggerObjectMaps(code);
      if (map.size > 0) return map;
    }
  } catch {}

  return result;
}
// 自动搜索 + 选择最近的 swagger 文件
async function autoFindSwaggerFile(
  importPath: string,
  fromDoc?: vscode.Uri
): Promise<vscode.Uri | null> {
  const path = require("path");
  const base = importPath
    .replace(/^@\//, "src/")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
  const patterns = [
    `**/${base}.{ts,js,mjs,cjs}`,
    `**/${base}/index.{ts,js,mjs,cjs}`,
  ];
  for (const p of patterns) {
    const uris = await vscode.workspace.findFiles(p, "**/node_modules/**", 50);
    if (uris.length === 0) continue;
    if (!fromDoc) return uris[0];

    // 选距离当前文档最近的
    const docDir = path.dirname(fromDoc.fsPath);
    let best: vscode.Uri | null = null;
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const u of uris) {
      const dist = distanceByCommonPrefix(docDir, u.fsPath);
      if (dist < bestDist) {
        bestDist = dist;
        best = u;
      }
    }
    if (best) return best;
  }
  return null;
}
function distanceByCommonPrefix(a: string, b: string): number {
  const pa = a.split(/[\\/]+/);
  const pb = b.split(/[\\/]+/);
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  // 距离越小越近：剩余层级总和
  return pa.length - i + (pb.length - i);
}
export async function buildImportCandidates(
  root: vscode.Uri,
  importPath: string,
  fromDoc?: vscode.Uri
): Promise<vscode.Uri[]> {
  const path = require("path");
  // 只考虑 JS
  const exts = [".js"];
  const out: vscode.Uri[] = [];

  const addFileVariants = (base: vscode.Uri) => {
    for (const ext of exts) out.push(vscode.Uri.parse(base.toString() + ext));
  };

  // 相对路径（相对当前文档）
  if (/^\.\.?\//.test(importPath) && fromDoc) {
    const dir = vscode.Uri.file(path.dirname(fromDoc.fsPath));
    addFileVariants(vscode.Uri.joinPath(dir, importPath));
  }

  // 固定规则：@/xxx => <root>/src/xxx
  if (importPath.startsWith("@/")) {
    const noAt = importPath.replace(/^@\//, "");
    addFileVariants(vscode.Uri.joinPath(root, "src", noAt));
  }

  // 绝对子路径（视作相对工程根）
  if (importPath.startsWith("/")) {
    const sub = importPath.replace(/^\//, "");
    addFileVariants(vscode.Uri.joinPath(root, sub));
  }

  // 无前缀：尝试 <root>/<path> 与 <root>/src/<path>
  if (!/^(?:\.\.?\/|@\/|\/)/.test(importPath)) {
    addFileVariants(vscode.Uri.joinPath(root, importPath));
    addFileVariants(vscode.Uri.joinPath(root, "src", importPath));
  }

  // 去重
  const seen = new Set<string>();
  return out.filter((u) => {
    const k = u.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function findSwaggerImport(text: string): { modulePath: string } | null {
  // 保留老接口，兼容之前调用
  const re = /import[\s\S]*?from\s*['"]([^'"]*swagger[^'"]*)['"]/g;
  const m = re.exec(text);
  if (!m) return null;
  return { modulePath: m[1] };
}

type NamedImport = { exported: string; local: string };
type ParsedSwaggerImport = {
  modulePath: string;
  named?: NamedImport[];
  namespace?: string;
  defaultImport?: string;
};

export function parseSwaggerImport(text: string): ParsedSwaggerImport[] {
  const results: ParsedSwaggerImport[] = [];

  // 1️⃣ 命名导入：import { Basic, Stacker as SK } from '...swagger'
  const namedRe =
    /import\s*\{\s*([^}]+?)\s*\}\s*from\s*['"]([^'"]*swagger[^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(text))) {
    const modulePath = m[2];
    const named = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const mm = s.match(
          /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/i
        );
        return { exported: mm?.[1] || s, local: mm?.[2] || mm?.[1] || s };
      });
    results.push({ modulePath, named });
  }

  // 2️⃣ 命名空间导入：import * as API from '...swagger'
  const nsRe =
    /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]*swagger[^'"]*)['"]/g;
  while ((m = nsRe.exec(text))) {
    results.push({ modulePath: m[2], namespace: m[1] });
  }

  // 3️⃣ 默认导入：import Swagger from '...swagger'
  const defRe =
    /import\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]*swagger[^'"]*)['"]/g;
  while ((m = defRe.exec(text))) {
    results.push({ modulePath: m[2], defaultImport: m[1] });
  }

  return results;
}

export function collectImportedObjectUsages(
  text: string,
  namedLocals: string[],
  namespace?: string
): Array<{ object: string; key: string }> {
  const out: Array<{ object: string; key: string }> = [];
  const seen = new Set<string>();

  // 1) 命名导入：local.key / local['key']
  for (const local of namedLocals) {
    // local.key
    const dot = new RegExp(
      "\\b" + local.replace(/\$/g, "\\$") + "\\.(\\w+)\\b",
      "g"
    );
    let m: RegExpExecArray | null;
    while ((m = dot.exec(text))) {
      const id = `${local}.${m[1]}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ object: local, key: m[1] });
      }
    }
    // local['key']
    const br = new RegExp(
      "\\b" + local.replace(/\$/g, "\\$") + "\\[['\"](\\w+)['\"]\\]",
      "g"
    );
    while ((m = br.exec(text))) {
      const id = `${local}.${m[1]}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ object: local, key: m[1] });
      }
    }
  }

  // 2) 命名空间导入：ns.Object.key / ns.Object['key']
  if (namespace) {
    // ns.Object.key
    const nsDot = new RegExp("\\b" + namespace + "\\.(\\w+)\\.(\\w+)\\b", "g");
    let m: RegExpExecArray | null;
    while ((m = nsDot.exec(text))) {
      const obj = m[1];
      const key = m[2];
      const id = `${obj}.${key}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ object: obj, key });
      }
    }
    // ns.Object['key']
    const nsBr = new RegExp(
      "\\b" + namespace + "\\.(\\w+)\\[['\"](\\w+)['\"]\\]",
      "g"
    );
    while ((m = nsBr.exec(text))) {
      const obj = m[1];
      const key = m[2];
      const id = `${obj}.${key}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ object: obj, key });
      }
    }
  }

  return out;
}
