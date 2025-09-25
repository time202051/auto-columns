// AST 解析js文件，可以直接读取对象数据
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import type {
  File,
  Expression,
  TemplateLiteral,
  BinaryExpression,
  StringLiteral,
  Identifier,
} from "@babel/types";

export function extractSwaggerObjectMaps(
  code: string
): Map<string, Map<string, string>> {
  // 优先 AST，失败回退正则
  try {
    const ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "classProperties", "dynamicImport"],
    }) as File;
    const out = extractByAST(ast);
    if (out.size > 0) return out;
  } catch {}
  return extractByRegex(code);
}

function extractByAST(ast: File): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  let baseURL = "";

  // 1) 收集 baseURL（字面量）
  traverse(ast, {
    VariableDeclarator(path: any) {
      const id = path.node.id;
      if (id.type === "Identifier" && id.name === "baseURL") {
        const init = path.node.init;
        if (init && init.type === "StringLiteral") {
          baseURL = init.value || "";
        }
      }
    },
  });

  // 2) 找导出对象：export const Obj = { ... }
  traverse(ast, {
    ExportNamedDeclaration(path: any) {
      const decl = path.node.declaration;
      if (!decl || decl.type !== "VariableDeclaration") return;
      for (const d of decl.declarations) {
        if (d.id.type !== "Identifier") continue;
        const objName = d.id.name;
        const init = d.init;
        if (!init || init.type !== "ObjectExpression") continue;

        const kv = map.get(objName) || new Map<string, string>();
        for (const prop of init.properties) {
          if (prop.type !== "ObjectProperty") continue;
          // key
          let keyName = "";
          if (prop.key.type === "Identifier") keyName = prop.key.name;
          else if (prop.key.type === "StringLiteral") keyName = prop.key.value;
          if (!keyName) continue;

          const v = evalUrlExpr(prop.value as Expression, baseURL);
          if (typeof v === "string") kv.set(keyName, v);
        }
        if (kv.size > 0) map.set(objName, kv);
      }
    },
  });

  return map;
}

function evalUrlExpr(expr: Expression, baseURL: string): string | null {
  switch (expr.type) {
    case "StringLiteral":
      return (expr as StringLiteral).value;

    case "Identifier":
      return (expr as Identifier).name === "baseURL" ? baseURL : null;

    case "TemplateLiteral": {
      const t = expr as TemplateLiteral;
      let s = "";
      for (let i = 0; i < t.quasis.length; i++) {
        s += t.quasis[i].value.cooked || "";
        if (i < t.expressions.length) {
          const inner = t.expressions[i];
          const v = evalUrlExpr(inner as Expression, baseURL);
          if (typeof v === "string") s += v;
          else return null;
        }
      }
      return s;
    }

    case "BinaryExpression": {
      const be = expr as BinaryExpression;
      if (be.operator !== "+") return null;
      const left = evalUrlExpr(be.left as Expression, baseURL);
      const right = evalUrlExpr(be.right as Expression, baseURL);
      if (typeof left === "string" && typeof right === "string")
        return left + right;
      return null;
    }

    default:
      return null;
  }
}

// 作为兜底：保留你原先的正则实现（略有简化）
function extractByRegex(code: string): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  let baseURL = "";
  {
    const m = /const\s+baseURL\s*=\s*['"]([^'"]*)['"]/.exec(code);
    if (m) baseURL = m[1] || "";
  }
  const objRe = /export\s+(?:const|let|var)\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(code))) {
    const objName = m[1];
    const body = m[2];
    const kv = map.get(objName) || new Map<string, string>();
    const kvRe = /(?:"|')?([A-Za-z_$][\w$]*)(?:"|')?\s*:\s*([^,]+)\s*(?:,|$)/g;
    let kvm: RegExpExecArray | null;
    while ((kvm = kvRe.exec(body))) {
      const key = kvm[1];
      let raw = (kvm[2] || "")
        .replace(/\/\/.*$/m, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      let t = /^`([\s\S]*)`$/.exec(raw);
      if (t) {
        kv.set(key, t[1].replace(/\$\{\s*baseURL\s*\}/g, baseURL));
        continue;
      }
      t = /^['"]([^'"]*)['"]$/.exec(raw);
      if (t) {
        kv.set(key, t[1]);
        continue;
      }
      t = /^baseURL\s*\+\s*['"]([^'"]+)['"]$/.exec(raw);
      if (t) {
        kv.set(key, baseURL + t[1]);
        continue;
      }
    }
    if (kv.size > 0) map.set(objName, kv);
  }
  return map;
}
