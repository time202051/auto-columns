// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import {
  findBasicImport,
  collectBasicKeys,
  parseSwaggerImport,
  collectImportedObjectUsages,
  resolveSwaggerObjectMaps,
  extractDirectUrls,
} from "./utils";
import { SwaggerService } from "./swaggerService";

const GLOBAL_KEY_SWAGGER_BASE = "autoColumns.swaggerBaseUrl";
function joinUrl(base: string, path: string): string {
  if (!base) return path || "";
  if (!path) return base || "";
  const a = base.endsWith("/") ? base.slice(0, -1) : base;
  const b = path.startsWith("/")
    ? path.slice(0, 1) === "/"
      ? path.replace(/^\/+/, "/")
      : path
    : `/${path}`;
  // 避免双斜杠：a + b（确保 b 以 / 开头）
  return a + (b.startsWith("/") ? b : `/${b}`);
}

async function getOrAskSwaggerBaseUrl(
  context: vscode.ExtensionContext
): Promise<string> {
  const cached = context.globalState.get<string>(GLOBAL_KEY_SWAGGER_BASE) || "";
  if (cached) return cached;

  const input = await vscode.window.showInputBox({
    title: "请输入 Swagger 基地址（如 https://api.example.com 或空）",
    value: cached,
    ignoreFocusOut: true,
    placeHolder: "例如：https://api.example.com",
    prompt:
      "该地址将会自动拼接到所有收集到的 URL 前面，可随时通过“设置 Swagger 基地址”命令修改",
  });
  const val = (input || "").trim();
  await context.globalState.update(GLOBAL_KEY_SWAGGER_BASE, val);
  return val;
}

async function setSwaggerBaseUrl(context: vscode.ExtensionContext) {
  const current =
    context.globalState.get<string>(GLOBAL_KEY_SWAGGER_BASE) || "";
  const input = await vscode.window.showInputBox({
    title: "设置 Swagger 基地址",
    value: current,
    ignoreFocusOut: true,
    placeHolder: "例如：https://api.example.com，留空表示不拼接",
  });
  if (input === undefined) return; // 用户取消
  const val = (input || "").trim();
  await context.globalState.update(GLOBAL_KEY_SWAGGER_BASE, val);
  vscode.window.showInformationMessage(
    `Swagger 基地址已更新${val ? `：${val}` : "（为空）"}`
  );
}
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated

  // 注册提取Swagger信息的命令
  const extractSwaggerInfoCommand = vscode.commands.registerCommand(
    "auto-columns.extractSwaggerInfo",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("请先打开一个文件");
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage("请先选中一个URL地址");
        return;
      }

      const selectedText = editor.document.getText(selection);

      const base = await getOrAskSwaggerBaseUrl(context);
      const finalUrls = joinUrl(base, selectedText);

      const swaggerService = SwaggerService.getInstance();

      // 从选中的文本中提取Swagger信息（支持多URL）
      const swaggerInfos = swaggerService.extractSwaggerInfoFromUrls(finalUrls);

      if (!swaggerInfos || swaggerInfos.length === 0) {
        vscode.window.showErrorMessage(
          "无法从选中的文本中提取Swagger信息，请确保选中的是有效的API URL或URL数组"
        );
        return;
      }

      try {
        // 显示加载状态
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `正在解析${swaggerInfos.length}个Swagger API...`,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ increment: 0 });

            // 解析多个Swagger API
            const apiInfos = await swaggerService.parseMultipleSwaggerApis(
              swaggerInfos
            );

            progress.report({ increment: 100 });

            if (Object.keys(apiInfos).length > 0) {
              // 显示结果
              showMultipleSwaggerInfo(apiInfos);
            } else {
              vscode.window.showErrorMessage("解析Swagger API失败");
            }
          }
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `解析失败: ${error instanceof Error ? error.message : "未知错误"}`
        );
      }
    }
  );

  const collectApiUrlsCommand = vscode.commands.registerCommand(
    "auto-columns.collectApiUrls",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("未检测到接口");
        return;
      }

      const doc = editor.document;
      const lang = doc.languageId;
      if (lang !== "vue" && lang !== "javascript") {
        vscode.window.showInformationMessage("未检测到接口");
        return;
      }

      const text = doc.getText();

      // 解析任何包含 swagger 的导入（命名/命名空间）
      const parseds: any = parseSwaggerImport(text);
      const arrUrls: string[] = [];

      // 使用 for...of 循环替代 forEach，确保异步操作按顺序执行
      for (const parsed of parseds) {
        if (parsed) {
          const namedLocals = parsed.named.map((n: any) => n.local);
          const usages = collectImportedObjectUsages(
            text,
            namedLocals,
            parsed.namespace
          );

          if (usages.length === 0) {
            vscode.window.showInformationMessage("未检测到接口");
            continue; // 使用 continue 替代 return
          }

          // 读取 swagger 模块，构建 导出对象 -> (键->URL)
          const maps = await resolveSwaggerObjectMaps(
            parsed.modulePath,
            doc.uri
          );

          // 本地名 -> 导出名 的映射（用于重命名导入）
          const localToExported = new Map<string, string>();
          for (const n of parsed.named) {
            localToExported.set(n.local, n.exported);
          }

          const urls: string[] = [];
          for (const u of usages) {
            // 命名导入用法：object 是本地名，需要还原成导出名
            const exportedObject =
              localToExported.get(u.object) || // 命名导入本地名
              u.object; // 命名空间用法已经是导出对象名（ns.Object.key）
            const url = maps.get(exportedObject)?.get(u.key);
            if (url) urls.push(url);
          }
          const dedup = Array.from(new Set(urls));
          const base = await getOrAskSwaggerBaseUrl(context);
          const finalUrls = dedup.map((u) => joinUrl(base, u));
          arrUrls.push(...finalUrls);
        }
      }
      // 2. 收集直接写死的URL
      const directUrls = extractDirectUrls(text);
      if (directUrls.length > 0) {
        const base = await getOrAskSwaggerBaseUrl(context);
        const finalDirectUrls = directUrls.map((u) => joinUrl(base, u));
        arrUrls.push(...finalDirectUrls);
      }
      await runExtractSwaggerInfoFlow(arrUrls);

      // 回退：老的 Basic 用法（保持返回 [] 的语义）
      const importInfo = findBasicImport(text);
      if (!importInfo) {
        vscode.window.showInformationMessage("未检测到接口");
        return;
      }
      const basicKeys = collectBasicKeys(text);
      if (basicKeys.length === 0) {
        vscode.window.showInformationMessage("未检测到接口");
        return;
      }
      // const urlMap = await resolveBasicUrlMap(importInfo.modulePath);
      // const urls: string[] = [];
      // for (const k of basicKeys) {
      //   const v = urlMap.get(k);
      //   if (v) urls.push(v);
      // }
      // const dedup = Array.from(new Set(urls));
      // const base = await getOrAskSwaggerBaseUrl(context);
      // const finalUrls = dedup.map((u) => joinUrl(base, u));
      // // await vscode.env.clipboard.writeText(JSON.stringify(finalUrls, null, 2));
      // // vscode.window.showInformationMessage(`已复制 ${finalUrls.length} 个URL`);
      // // 追加：直接进入 extractSwaggerInfo 流程
      // await runExtractSwaggerInfoFlow(finalUrls);
    }
  );

  // 设置全局变量，swagger服务地址
  const setSwaggerBaseUrlCommand = vscode.commands.registerCommand(
    "auto-columns.setSwaggerBaseUrl",
    async () => {
      await setSwaggerBaseUrl(context);
    }
  );

  context.subscriptions.push(
    extractSwaggerInfoCommand,
    collectApiUrlsCommand,
    setSwaggerBaseUrlCommand
  );
}
async function runExtractSwaggerInfoFlow(selectedText: string[]) {
  const swaggerService = SwaggerService.getInstance();

  // 从选中的文本中提取Swagger信息（支持多URL）

  const swaggerInfos = swaggerService.extractSwaggerInfoFromUrls(selectedText);

  if (!swaggerInfos || swaggerInfos.length === 0) {
    vscode.window.showErrorMessage(
      "无法从选中的文本中提取Swagger信息，请确保选中的是有效的API URL或URL数组"
    );
    return;
  }

  try {
    // 显示加载状态
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在解析${swaggerInfos.length}个Swagger API...`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0 });

        // 解析多个Swagger API
        const apiInfos = await swaggerService.parseMultipleSwaggerApis(
          swaggerInfos
        );

        progress.report({ increment: 100 });

        if (Object.keys(apiInfos).length > 0) {
          // 显示结果
          showMultipleSwaggerInfo(apiInfos);
        } else {
          vscode.window.showErrorMessage("解析Swagger API失败");
        }
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `解析失败: ${error instanceof Error ? error.message : "未知错误"}`
    );
  }
}
/**
 * 显示Swagger API信息
 */
function showSwaggerInfo(apiInfo: any, apiPath: string) {
  const panel = vscode.window.createWebviewPanel(
    "swaggerInfo",
    `Swagger API信息 - ${apiPath}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const html = generateSwaggerInfoHtml(apiInfo, apiPath);
  panel.webview.html = html;

  // 接收 Webview 消息并写入剪贴板
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "copy" && typeof msg.text === "string") {
      await vscode.env.clipboard.writeText(msg.text);
      vscode.window.showInformationMessage("已复制到剪贴板");
    }
  });
}

/**
 * 显示多个Swagger API信息
 */
function showMultipleSwaggerInfo(apiInfos: { [apiPath: string]: any }) {
  const panel = vscode.window.createWebviewPanel(
    "swaggerInfo",
    `Swagger API信息 - ${Object.keys(apiInfos).length}个接口`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const html = generateMultipleSwaggerInfoHtml(apiInfos);
  panel.webview.html = html;

  // 接收 Webview 消息并写入剪贴板
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "copy" && typeof msg.text === "string") {
      await vscode.env.clipboard.writeText(msg.text);
      vscode.window.showInformationMessage("已复制到剪贴板");
    }
  });
}

/**
 * 生成响应字段的HTML - 树形结构（同一张表内）
 */
function generateResponsesHtml(
  responses: any[],
  method: string,
  apiPath?: string
): string {
  if (!responses || responses.length === 0) {
    return '<tr><td colspan="5" style="text-align: center; color: #666;">暂无响应信息</td></tr>';
  }

  return generateTreeHtml(responses, 0, method, "", apiPath);
}

/**
 * 生成树形HTML（同表多行；父子行共享表格，统一 hover/样式）
 * 所有层级：均可选择与复制
 */
function generateTreeHtml(
  nodes: any[],
  level: number,
  method: string,
  parentPath: string,
  apiPath?: string
): string {
  return nodes
    .map((node) => {
      const indent = level * 20;
      const hasChildren = node.children && node.children.length > 0;
      const nodeId = `node-${Math.random().toString(36).substr(2, 9)}`;
      const path = parentPath ? `${parentPath}.${node.name}` : `${node.name}`;

      const currentRow = `
      <tr class="tree-row" data-level="${level}" data-node-id="${nodeId}" data-method="${method}" data-path="${path}"${
        apiPath ? ` data-api-path="${apiPath}"` : ""
      }>
        <td class="select-col">
          <input type="checkbox" class="resp-check" data-method="${method}" data-prop="${
        node.name
      }" data-prop-path="${path}"${
        apiPath ? ` data-api-path="${apiPath}"` : ""
      }>
        </td>
        <td style="padding-left: ${indent + 12}px;">
          <span class="tree-node" data-node-id="${nodeId}">
            ${
              hasChildren
                ? `<button class="expand-btn" onclick="toggleNode('${nodeId}')">+</button>`
                : '<span class="no-expand"></span>'
            }
            <span class="field-name">${node.name}</span>
          </span>
        </td>
        <td><span class="type">${node.type}</span></td>
        <td>${node.description || "-"}</td>
        <td class="op-col">
          <button class="copy-btn small" onclick="copySingleResponse('${method}','${path.replace(
        /'/g,
        "\\'"
      )}'${apiPath ? `,'${apiPath}'` : ""}, this)">复制</button>
        </td>
      </tr>
      `;

      const childrenRows = hasChildren
        ? node.children
            .map((child: any) =>
              generateChildRows(child, level + 1, nodeId, method, path, apiPath)
            )
            .join("")
        : "";
      return currentRow + childrenRows;
    })
    .join("");
}

/**
 * 生成子节点行（递归，仍在同一张表；所有层级可选/可复制）
 */
function generateChildRows(
  node: any,
  level: number,
  parentId: string,
  method: string,
  parentPath: string,
  apiPath?: string
): string {
  const indent = level * 20;
  const hasChildren = node.children && node.children.length > 0;
  const nodeId = `node-${Math.random().toString(36).substr(2, 9)}`;
  const path = parentPath ? `${parentPath}.${node.name}` : `${node.name}`;

  const row = `
    <tr class="tree-row" data-level="${level}" data-parent="${parentId}" data-node-id="${nodeId}" data-method="${method}" data-path="${path}" style="display: none;"${
    apiPath ? ` data-api-path="${apiPath}"` : ""
  }>
      <td class="select-col">
        <input type="checkbox" class="resp-check" data-method="${method}" data-prop="${
    node.name
  }" data-prop-path="${path}"${apiPath ? ` data-api-path="${apiPath}"` : ""}>
      </td>
      <td style="padding-left: ${indent + 12}px;">
        <span class="tree-node" data-node-id="${nodeId}">
          ${
            hasChildren
              ? `<button class="expand-btn" onclick="toggleNode('${nodeId}')">+</button>`
              : '<span class="no-expand"></span>'
          }
          <span class="field-name">${node.name}</span>
        </span>
      </td>
      <td><span class="type">${node.type}</span></td>
      <td>${node.description || "-"}</td>
      <td class="op-col">
        <button class="copy-btn small" onclick="copySingleResponse('${method}','${path.replace(
    /'/g,
    "\\'"
  )}'${apiPath ? `,'${apiPath}'` : ""}, this)">复制</button>
      </td>
    </tr>
  `;

  const childrenRows = hasChildren
    ? node.children
        .map((child: any) =>
          generateChildRows(child, level + 1, nodeId, method, path, apiPath)
        )
        .join("")
    : "";

  return row + childrenRows;
}

/**
 * 生成Swagger信息HTML（支持同路径多方法 Tab 切换）
 */
function generateSwaggerInfoHtml(apiInfo: any, apiPath: string): string {
  const methodOrder = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  const available = methodOrder.filter(
    (m) => apiInfo.byMethod && apiInfo.byMethod[m]
  );
  const first = available[0];

  const tabsHtml = available
    .map(
      (m) => `
    <button class="tab-btn${
      m === first ? " active" : ""
    }" data-method="${m}" onclick="switchMethod('${m}')">${m}</button>
  `
    )
    .join("");

  const sectionsHtml = available
    .map((m) => {
      const methodInfo = apiInfo.byMethod[m];
      const parametersHtml = (methodInfo.parameters || [])
        .map(
          (param: any) => `
      <tr data-method="${m}">
        <td class="select-col"><input type="checkbox" class="param-check" data-method="${m}" data-name="${
            param.name
          }"></td>
        <td>${param.name}</td>
        <td><span class="type">${param.type}</span></td>
        <td><span class="${param.required ? "required" : ""}">${
            param.required ? "是" : "否"
          }</span></td>
        <td>${param.description || "-"}</td>
        <td class="op-col"><button class="copy-btn small" onclick="copySingleParam('${m}','${param.name.replace(
            /'/g,
            "\\'"
          )}', this)">复制</button></td>
      </tr>
    `
        )
        .join("");

      const responsesHtml = generateResponsesHtml(
        methodInfo.responses || [],
        m
      );

      return `
      <div class="method-section" data-method="${m}" style="${
        m === first ? "" : "display:none;"
      }">
        <div class="section">
          <h2>请求参数</h2>
          <div class="ops">
            <button class="copy-btn" onclick="copyParams('${m}','selected', this)">复制选中</button>
            <button class="copy-btn" onclick="copyParams('${m}','all', this)">复制全部</button>
            <label class="select-all">
              <input type="checkbox" onclick="toggleSelectAll('params','${m}',this)"> 全选
            </label>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width:44px;"></th>
                <th>参数名</th>
                <th>类型</th>
                <th>必填</th>
                <th>描述</th>
                <th style="width:72px;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                parametersHtml ||
                '<tr><td colspan="6" style="text-align: center; color: #666;">暂无参数信息</td></tr>'
              }
            </tbody>
          </table>
        </div>

        <div class="section">
          <h2>响应字段 (200状态码)</h2>
          <div class="ops">
            <button class="copy-btn" onclick="copyResponses('${m}','selected', this)">复制选中</button>
            <button class="copy-btn" onclick="copyResponses('${m}','all', this)">复制全部</button>
            <label class="select-all">
              <input type="checkbox" onclick="toggleSelectAll('responses','${m}',this)"> 全选(当前可见层级)
            </label>
          </div>
          <table class="responses-table">
            <thead>
              <tr>
                <th style="width:44px;"></th>
                <th>字段名</th>
                <th>类型</th>
                <th>描述</th>
                <th style="width:72px;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${responsesHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
    })
    .join("");

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Swagger API信息</title>
       <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          margin: 0;
          padding: 20px;
          background-color: var(--vscode-editor-background, #1e1e1e);
          color: var(--vscode-foreground, #d4d4d4);
        }
        .container {
          max-width: 1200px;
          margin: 0 auto;
          background: var(--vscode-editorWidget-background, #252526);
          border-radius: 6px;
          border: 1px solid var(--vscode-panel-border, #3c3c3c);
          overflow: hidden;
        }
        .header {
          background: var(--vscode-titleBar-activeBackground, #3c3c3c);
          color: var(--vscode-titleBar-activeForeground, #ffffff);
          padding: 16px 20px;
          text-align: left;
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .header h1 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }
        .header p {
          margin: 8px 0 0 0;
          opacity: 0.8;
        }
        .content {
          padding: 16px 20px 20px 20px;
        }
        .tabs {
          display: flex;
          gap: 8px;
          padding: 8px 0 16px 0;
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
          margin-bottom: 16px;
        }
        .tab-btn {
          background: var(--vscode-button-secondaryBackground, #3a3d41);
          color: var(--vscode-button-foreground, #ffffff);
          border: 1px solid var(--vscode-panel-border, #3c3c3c);
          padding: 4px 10px;
          border-radius: 4px 4px 0 0;
          cursor: pointer;
          font-weight: 600;
        }
        .tab-btn.active {
          background: var(--vscode-button-background, #0e639c);
          border-bottom-color: transparent;
        }
        .section {
          margin-bottom: 24px;
        }
        .section h2 {
          color: var(--vscode-foreground, #d4d4d4);
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
          padding-bottom: 8px;
          margin-bottom: 12px;
          font-size: 14px;
        }
        .ops {
          display:flex;
          align-items:center;
          gap:8px;
          margin:8px 0;
        }
        .copy-btn {
          background: var(--vscode-button-background, #0e639c);
          color: var(--vscode-button-foreground, #ffffff);
          border: 1px solid transparent;
          padding: 2px 10px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }
        .copy-btn.small {
          padding: 0 8px;
          height: 20px;
        }
        .copy-btn:active {
          transform: scale(0.96);
        }
        .copy-btn.copied {
          background: var(--vscode-testing-iconPassed, #2ea043);
          border-color: transparent;
        }
        .copy-btn.copied::after {
          content: ' ✓';
        }
        .select-all {
          margin-left: 8px;
          opacity: .9;
          font-size: 12px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 6px;
          background: transparent;
        }
        th, td {
          padding: 8px 10px;
          text-align: left;
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
          color: var(--vscode-foreground, #d4d4d4);
          vertical-align: middle;
        }
        th {
          background-color: var(--vscode-editorWidget-background, #252526);
          font-weight: 600;
          color: var(--vscode-foreground, #d4d4d4);
        }
        /* hover 效果：统一与参数表一致，并确保响应表全层级生效 */
        tr:hover,
        .tree-row:hover,
        .responses-table tr:hover,
        .responses-table .tree-row:hover {
          background-color: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
        }
        .required {
          color: var(--vscode-errorForeground, #f14c4c);
          font-weight: 600;
        }
        .type {
          display: inline-block !important;
          background-color: var(--vscode-badge-background, #4d4d4d) !important;
          color: var(--vscode-badge-foreground, #ffffff) !important;
          padding: 1px 4px !important;
          border-radius: 3px !important;
          font-family: 'Courier New', monospace !important;
          font-size: 10px !important;
          white-space: nowrap !important;
          line-height: 1.2 !important;
          height: auto !important;
          min-height: auto !important;
          max-height: none !important;
          width: auto !important;
          max-width: none !important;
        }
        /* 强制覆盖表格单元格内的类型徽章 */
        td .type {
          display: inline-block !important;
          height: auto !重要;
          min-height: auto !important;
          vertical-align: baseline !important;
        }
        .field-name {
          font-family: 'Courier New', monospace;
          font-weight: 600;
          color: var(--vscode-foreground, #d4d4d4);
        }
        .expand-btn {
          background: var(--vscode-button-background, #0e639c);
          color: var(--vscode-button-foreground, #ffffff);
          border: 1px solid transparent;
          padding: 0 6px;
          border-radius: 3px;
          cursor: pointer;
          margin-right: 8px;
          font-size: 12px;
          font-weight: bold;
          width: 18px;
          height: 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .expand-btn:hover {
          background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .no-expand {
          display: inline-block;
          width: 18px;
          height: 18px;
          margin-right: 8px;
        }
        .tree-row {
          transition: background-color 0.15s ease-in-out;
        }
        .tree-node {
          display: inline-flex;
          align-items: center;
        }
        tbody td {
          color: var(--vscode-foreground, #d4d4d4);
        }
        /* 仅通过缩进表现层级，避免与主题冲突的底色 */
        .tree-row[data-level="0"],
        .tree-row[data-level="1"],
        .tree-row[data-level="2"],
        .tree-row[data-level="3"] {
          background-color: transparent;
          font-weight: normal;
        }
        .select-col { width: 44px; }
        .op-col { width: 72px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Swagger API信息</h1>
          <p>API路径: ${apiPath}</p>
        </div>
        <div class="content">
          <div class="tabs">
            ${tabsHtml}
          </div>

          ${sectionsHtml}
        </div>
      </div>
      
      <script>
        const vscode = acquireVsCodeApi();
        const __API_BY_METHOD__ = ${JSON.stringify(apiInfo.byMethod || {})};

        function switchMethod(method) {
          document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-method') === method);
          });
          document.querySelectorAll('.method-section').forEach(sec => {
            sec.style.display = sec.getAttribute('data-method') === method ? '' : 'none';
          });
        }

        function toggleNode(nodeId) {
          const children = Array.from(document.querySelectorAll(\`tr[data-parent="\${nodeId}"]\`));
          if (children.length === 0) return;

          const isHidden = children[0].style.display === 'none';
          setChildrenVisibility(nodeId, isHidden);

          const headerBtn = document.querySelector(\`.tree-node[data-node-id="\${nodeId}"] .expand-btn\`);
          if (headerBtn) headerBtn.textContent = isHidden ? '-' : '+';
        }

        function setChildrenVisibility(parentId, show) {
          const rows = Array.from(document.querySelectorAll(\`tr[data-parent="\${parentId}"]\`));
          rows.forEach(row => {
            row.style.display = show ? 'table-row' : 'none';

            const nid = row.getAttribute('data-node-id');
            if (!show && nid) {
              const btn = row.querySelector('.expand-btn');
              if (btn) btn.textContent = '+';
              setChildrenVisibility(nid, false);
            }
          });
        }

        function mapInputType(t) {
          const type = String(t || '').toLowerCase();
          if (type === 'integer' || type === 'number') return 'number';
          if (type === 'boolean') return 'switch';
          return 'text';
        }

        function copyText(text) {
          vscode.postMessage({ type: 'copy', text });
        }

        function feedback(btn) {
          if (!btn) return;
          const old = btn.textContent;
          btn.disabled = true;
          btn.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = old;
            btn.classList.remove('copied');
          }, 900);
        }

        function buildParams(method, mode) {
          const raw = __API_BY_METHOD__[method]?.parameters || [];
          let pickedNames = null;
          if (mode === 'selected') {
            pickedNames = Array.from(document.querySelectorAll('.param-check[data-method="'+method+'"]:checked')).map(i => i.getAttribute('data-name'));
          }
          const list = raw
            .filter(p => !pickedNames || pickedNames.includes(p.name))
            .map(p => {
              // 输入类型映射：enum => select；时间类(format) => picker；其它 => text
              const fmt = String(p.format || '').toLowerCase();
              const isTime = fmt === 'date' || fmt === 'date-time' || fmt === 'datetime' || fmt === 'time' || fmt === 'timestamp';
              const isSelect = Array.isArray(p.enum) && p.enum.length > 0;
              const inputType = isSelect ? 'select' : (isTime ? 'picker' : 'text');
              const item = {
                label: p.description || p.name || '',
                value: p.name || '',
                inputType,
              };
              if (inputType === 'select') {
                item['children'] = [];
              }
              return item;
            });
          return list;
        }

        // 遍历辅助：按路径找到节点
        function findNodeByPath(roots, path) {
          if (!path) return null;
          const parts = path.split('.');
          let cur = null;
          let curList = roots;
          for (const seg of parts) {
            cur = (curList || []).find(n => n.name === seg);
            if (!cur) return null;
            curList = cur.children || [];
          }
          return cur;
        }

        // 将节点展开为“叶子字段列”
        function collectLeavesFromNode(node, basePath) {
          const out = [];
          if (!node) return out;

          const curPath = basePath ? basePath : node.name;
          const hasChildren = Array.isArray(node.children) && node.children.length > 0;

          if (!hasChildren) {
            const leafProp = String(curPath || node.name || '').split('.').pop() || '';
            out.push({
              prop: leafProp,
              label: node.description || (node.name || ''),
              sortable: false,
              show: true,
            });
            return out;
          }

          // 对象/数组：向下收集所有叶子
          for (const child of (node.children || [])) {
            const childPath = curPath ? (curPath + '.' + child.name) : child.name;
            out.push(...collectLeavesFromNode(child, childPath));
          }
          return out;
        }

        // 将整个根集合展开为叶子（用于“全部”）
        function collectAllLeaves(roots) {
          const out = [];
          for (const r of (roots || [])) {
            out.push(...collectLeavesFromNode(r, r.name));
          }
          return out;
        }

        function buildResponses(method, mode) {
          const roots = __API_BY_METHOD__[method]?.responses || [];
          let cols = [];

          if (mode === 'all') {
            const leaves = collectAllLeaves(roots);
            cols = [
              { label: "", type: "selection", show: true },
              ...leaves
            ];
            return cols;
          }

          // selected：允许任意层级
          const pickedPaths = Array.from(document.querySelectorAll('.resp-check[data-method="'+method+'"]:checked')).map(i => i.getAttribute('data-prop-path'));
          const seen = new Set();
          for (const p of pickedPaths) {
            const node = findNodeByPath(roots, p || '');
            if (!node) continue;
            const leaves = collectLeavesFromNode(node, p || node.name);
            for (const col of leaves) {
              if (seen.has(col.prop)) continue;
              seen.add(col.prop);
              cols.push(col);
            }
          }
          return cols;
        }

        function copyParams(method, mode, btn) {
          const data = buildParams(method, mode);
          // 单选返回对象，多选返回数组；全部复制始终数组
          if (mode === 'selected') {
            const selectedChecks = Array.from(document.querySelectorAll('.param-check[data-method="'+method+'"]:checked'));
            const payload = selectedChecks.length === 1 ? (data[0] || {}) : data;
            copyText(JSON.stringify(payload, null, 2));
          } else {
            copyText(JSON.stringify(data, null, 2));
          }
          feedback(btn);
        }
        function copySingleParam(method, name, btn) {
          const data = buildParams(method, 'all').find(i => i.value === name);
          if (data) {
            // 单条复制直接返回对象
            copyText(JSON.stringify(data, null, 2));
            feedback(btn);
          }
        }
        function copyResponses(method, mode, btn) {
          const data = buildResponses(method, mode);
          copyText(JSON.stringify(data, null, 2));
          feedback(btn);
        }
        function copySingleResponse(method, path, btn) {
          const roots = __API_BY_METHOD__[method]?.responses || [];
          const node = findNodeByPath(roots, path);
          if (!node) return;
          const cols = collectLeavesFromNode(node, path);
          const payload = cols.length === 1 ? cols[0] : cols;
          copyText(JSON.stringify(payload, null, 2));
          feedback(btn);
        }
        function toggleSelectAll(kind, method, el) {
          if (kind === 'params') {
            document.querySelectorAll('.param-check[data-method="'+method+'"]').forEach(i => i.checked = el.checked);
          } else {
            // 响应：当前可见层级（仅当前展开显示的行）
            document.querySelectorAll('.resp-check[data-method="'+method+'"]').forEach((i) => {
              const tr = i.closest('tr');
              if (tr && tr.style.display !== 'none') {
                i.checked = el.checked;
              }
            });
          }
        }
        
        // 页面加载完成后，默认展开第一层
        document.addEventListener('DOMContentLoaded', function() {
          const firstLevelButtons = document.querySelectorAll('.tree-row[data-level="0"] .expand-btn');
          firstLevelButtons.forEach(btn => btn.click());
        });
      </script>
    </body>
    </html>
  `;
}

/**
 * 生成多个Swagger信息HTML
 */
function generateMultipleSwaggerInfoHtml(apiInfos: {
  [apiPath: string]: any;
}): string {
  const apiPaths = Object.keys(apiInfos);
  const firstApiPath = apiPaths[0];

  // 生成API路径标签页
  const tabsHtml = apiPaths
    .map(
      (apiPath) => `
    <button class="api-tab-btn${
      apiPath === firstApiPath ? " active" : ""
    }" data-api-path="${apiPath}" onclick="switchApi('${apiPath}')">${apiPath}</button>
  `
    )
    .join("");

  // 生成每个API的内容
  const apiSectionsHtml = apiPaths
    .map((apiPath) => {
      const apiInfo = apiInfos[apiPath];
      const methodOrder = ["GET", "POST", "PUT", "DELETE", "PATCH"];
      const available = methodOrder.filter(
        (m) => apiInfo.byMethod && apiInfo.byMethod[m]
      );
      const first = available[0];

      const methodTabsHtml = available
        .map(
          (m) => `
        <button class="tab-btn${
          m === first ? " active" : ""
        }" data-method="${m}" data-api-path="${apiPath}" onclick="switchMethod('${m}', '${apiPath}')">${m}</button>
      `
        )
        .join("");

      const methodSectionsHtml = available
        .map((m) => {
          const methodInfo = apiInfo.byMethod[m];
          const parametersHtml = (methodInfo.parameters || [])
            .map(
              (param: any) => `
          <tr data-method="${m}" data-api-path="${apiPath}">
            <td class="select-col"><input type="checkbox" class="param-check" data-method="${m}" data-api-path="${apiPath}" data-name="${
                param.name
              }"></td>
            <td>${param.name}</td>
            <td><span class="type">${param.type}</span></td>
            <td><span class="${param.required ? "required" : ""}">${
                param.required ? "是" : "否"
              }</span></td>
            <td>${param.description || "-"}</td>
            <td class="op-col"><button class="copy-btn small" onclick="copySingleParam('${m}','${param.name.replace(
                /'/g,
                "\\'"
              )}', '${apiPath}', this)">复制</button></td>
          </tr>
        `
            )
            .join("");

          const responsesHtml = generateResponsesHtml(
            methodInfo.responses || [],
            m,
            apiPath
          );

          return `
          <div class="method-section" data-method="${m}" data-api-path="${apiPath}" style="${
            m === first ? "" : "display:none;"
          }">
            <div class="section">
              <h2>请求参数</h2>
              <div class="ops">
                <button class="copy-btn" onclick="copyParams('${m}','selected', '${apiPath}', this)">复制选中</button>
                <button class="copy-btn" onclick="copyParams('${m}','all', '${apiPath}', this)">复制全部</button>
                <label class="select-all">
                  <input type="checkbox" onclick="toggleSelectAll('params','${m}','${apiPath}',this)"> 全选
                </label>
              </div>
              <table>
                <thead>
                  <tr>
                    <th style="width:44px;"></th>
                    <th>参数名</th>
                    <th>类型</th>
                    <th>必填</th>
                    <th>描述</th>
                    <th style="width:72px;">操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    parametersHtml ||
                    '<tr><td colspan="6" style="text-align: center; color: #666;">暂无参数信息</td></tr>'
                  }
                </tbody>
              </table>
            </div>

            <div class="section">
              <h2>响应字段 (200状态码)</h2>
              <div class="ops">
                <button class="copy-btn" onclick="copyResponses('${m}','selected', '${apiPath}', this)">复制选中</button>
                <button class="copy-btn" onclick="copyResponses('${m}','all', '${apiPath}', this)">复制全部</button>
                <label class="select-all">
                  <input type="checkbox" onclick="toggleSelectAll('responses','${m}','${apiPath}',this)"> 全选(当前可见层级)
                </label>
              </div>
              <table class="responses-table">
                <thead>
                  <tr>
                    <th style="width:44px;"></th>
                    <th>字段名</th>
                    <th>类型</th>
                    <th>描述</th>
                    <th style="width:72px;">操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${responsesHtml}
                </tbody>
              </table>
            </div>
          </div>
        `;
        })
        .join("");

      return `
        <div class="api-section" data-api-path="${apiPath}" style="${
        apiPath === firstApiPath ? "" : "display:none;"
      }">
          <div class="tabs">
            ${methodTabsHtml}
          </div>
          ${methodSectionsHtml}
        </div>
      `;
    })
    .join("");

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Swagger API信息</title>
       <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          margin: 0;
          padding: 20px;
          background-color: var(--vscode-editor-background, #1e1e1e);
          color: var(--vscode-foreground, #d4d4d4);
        }
        .container {
          max-width: 1200px;
          margin: 0 auto;
          background: var(--vscode-editorWidget-background, #252526);
          border-radius: 6px;
          border: 1px solid var(--vscode-panel-border, #3c3c3c);
          overflow: hidden;
        }
        .header {
          background: var(--vscode-titleBar-activeBackground, #3c3c3c);
          color: var(--vscode-titleBar-activeForeground, #ffffff);
          padding: 16px 20px;
          text-align: left;
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .header h1 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }
        .header p {
          margin: 8px 0 0 0;
          opacity: 0.8;
        }
        .content {
          padding: 16px 20px 20px 20px;
        }
        .api-tabs {
          display: flex;
          gap: 8px;
          padding: 8px 0 16px 0;
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
          margin-bottom: 16px;
        }
        .api-tab-btn {
          background: var(--vscode-button-secondaryBackground, #3a3d41);
          color: var(--vscode-button-foreground, #ffffff);
          border: 1px solid var(--vscode-panel-border, #3c3c3c);
          padding: 8px 16px;
          border-radius: 4px 4px 0 0;
          cursor: pointer;
          font-weight: 600;
          font-size: 14px;
        }
        .api-tab-btn.active {
          background: var(--vscode-button-background, #0e639c);
          border-bottom-color: transparent;
        }
        .tabs {
          display: flex;
          gap: 8px;
          padding: 8px 0 16px 0;
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
          margin-bottom: 16px;
        }
        .tab-btn {
          background: var(--vscode-button-secondaryBackground, #3a3d41);
          color: var(--vscode-button-foreground, #ffffff);
          border: 1px solid var(--vscode-panel-border, #3c3c3c);
          padding: 4px 10px;
          border-radius: 4px 4px 0 0;
          cursor: pointer;
          font-weight: 600;
        }
        .tab-btn.active {
          background: var(--vscode-button-background, #0e639c);
          border-bottom-color: transparent;
        }
        .section {
          margin-bottom: 24px;
        }
        .section h2 {
          color: var(--vscode-foreground, #d4d4d4);
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
          padding-bottom: 8px;
          margin-bottom: 12px;
          font-size: 14px;
        }
        .ops {
          display:flex;
          align-items:center;
          gap:8px;
          margin:8px 0;
        }
        .copy-btn {
          background: var(--vscode-button-background, #0e639c);
          color: var(--vscode-button-foreground, #ffffff);
          border: 1px solid transparent;
          padding: 2px 10px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }
        .copy-btn.small {
          padding: 0 8px;
          height: 20px;
        }
        .copy-btn:active {
          transform: scale(0.96);
        }
        .copy-btn.copied {
          background: var(--vscode-testing-iconPassed, #2ea043);
          border-color: transparent;
        }
        .copy-btn.copied::after {
          content: ' ✓';
        }
        .select-all {
          margin-left: 8px;
          opacity: .9;
          font-size: 12px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 6px;
          background: transparent;
        }
        th, td {
          padding: 8px 10px;
          text-align: left;
          border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
          color: var(--vscode-foreground, #d4d4d4);
          vertical-align: middle;
        }
        th {
          background-color: var(--vscode-editorWidget-background, #252526);
          font-weight: 600;
          color: var(--vscode-foreground, #d4d4d4);
        }
        /* hover 效果：统一与参数表一致，并确保响应表全层级生效 */
        tr:hover,
        .tree-row:hover,
        .responses-table tr:hover,
        .responses-table .tree-row:hover {
          background-color: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
        }
        .required {
          color: var(--vscode-errorForeground, #f14c4c);
          font-weight: 600;
        }
        .type {
          display: inline-block !important;
          background-color: var(--vscode-badge-background, #4d4d4d) !important;
          color: var(--vscode-badge-foreground, #ffffff) !important;
          padding: 1px 4px !important;
          border-radius: 3px !important;
          font-family: 'Courier New', monospace !important;
          font-size: 10px !important;
          white-space: nowrap !important;
          line-height: 1.2 !important;
          height: auto !important;
          min-height: auto !important;
          max-height: none !important;
          width: auto !important;
          max-width: none !important;
        }
        /* 强制覆盖表格单元格内的类型徽章 */
        td .type {
          display: inline-block !important;
          height: auto !important;
          min-height: auto !important;
          vertical-align: baseline !important;
        }
        .field-name {
          font-family: 'Courier New', monospace;
          font-weight: 600;
          color: var(--vscode-foreground, #d4d4d4);
        }
        .expand-btn {
          background: var(--vscode-button-background, #0e639c);
          color: var(--vscode-button-foreground, #ffffff);
          border: 1px solid transparent;
          padding: 0 6px;
          border-radius: 3px;
          cursor: pointer;
          margin-right: 8px;
          font-size: 12px;
          font-weight: bold;
          width: 18px;
          height: 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .expand-btn:hover {
          background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .no-expand {
          display: inline-block;
          width: 18px;
          height: 18px;
          margin-right: 8px;
        }
        .tree-row {
          transition: background-color 0.15s ease-in-out;
        }
        .tree-node {
          display: inline-flex;
          align-items: center;
        }
        tbody td {
          color: var(--vscode-foreground, #d4d4d4);
        }
        /* 仅通过缩进表现层级，避免与主题冲突的底色 */
        .tree-row[data-level="0"],
        .tree-row[data-level="1"],
        .tree-row[data-level="2"],
        .tree-row[data-level="3"] {
          background-color: transparent;
          font-weight: normal;
        }
        .select-col { width: 44px; }
        .op-col { width: 72px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Swagger API信息</h1>
          <p>共${apiPaths.length}个接口</p>
        </div>
        <div class="content">
          <div class="api-tabs">
            ${tabsHtml}
          </div>

          ${apiSectionsHtml}
        </div>
      </div>
      
      <script>
        const vscode = acquireVsCodeApi();
        const __API_INFOS__ = ${JSON.stringify(apiInfos)};

        function switchApi(apiPath) {
          document.querySelectorAll('.api-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-api-path') === apiPath);
          });
          document.querySelectorAll('.api-section').forEach(sec => {
            sec.style.display = sec.getAttribute('data-api-path') === apiPath ? '' : 'none';
          });
        }

        function switchMethod(method, apiPath) {
          document.querySelectorAll(\`.tab-btn[data-api-path="\${apiPath}"]\`).forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-method') === method);
          });
          document.querySelectorAll(\`.method-section[data-api-path="\${apiPath}"]\`).forEach(sec => {
            sec.style.display = sec.getAttribute('data-method') === method ? '' : 'none';
          });
        }

        function toggleNode(nodeId) {
          const children = Array.from(document.querySelectorAll(\`tr[data-parent="\${nodeId}"]\`));
          if (children.length === 0) return;

          const isHidden = children[0].style.display === 'none';
          setChildrenVisibility(nodeId, isHidden);

          const headerBtn = document.querySelector(\`.tree-node[data-node-id="\${nodeId}"] .expand-btn\`);
          if (headerBtn) headerBtn.textContent = isHidden ? '-' : '+';
        }

        function setChildrenVisibility(parentId, show) {
          const rows = Array.from(document.querySelectorAll(\`tr[data-parent="\${parentId}"]\`));
          rows.forEach(row => {
            row.style.display = show ? 'table-row' : 'none';

            const nid = row.getAttribute('data-node-id');
            if (!show && nid) {
              const btn = row.querySelector('.expand-btn');
              if (btn) btn.textContent = '+';
              setChildrenVisibility(nid, false);
            }
          });
        }

        function mapInputType(t) {
          const type = String(t || '').toLowerCase();
          if (type === 'integer' || type === 'number') return 'number';
          if (type === 'boolean') return 'switch';
          return 'text';
        }

        function copyText(text) {
          vscode.postMessage({ type: 'copy', text });
        }

        function feedback(btn) {
          if (!btn) return;
          const old = btn.textContent;
          btn.disabled = true;
          btn.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = old;
            btn.classList.remove('copied');
          }, 900);
        }

        function buildParams(method, mode, apiPath) {
          const raw = __API_INFOS__[apiPath]?.byMethod?.[method]?.parameters || [];
          let pickedNames = null;
          if (mode === 'selected') {
            pickedNames = Array.from(document.querySelectorAll(\`.param-check[data-method="\${method}"][data-api-path="\${apiPath}"]:checked\`)).map(i => i.getAttribute('data-name'));
          }
          const list = raw
            .filter(p => !pickedNames || pickedNames.includes(p.name))
            .map(p => {
              // 输入类型映射：enum => select；时间类(format) => picker；其它 => text
              const fmt = String(p.format || '').toLowerCase();
              const isTime = fmt === 'date' || fmt === 'date-time' || fmt === 'datetime' || fmt === 'time' || fmt === 'timestamp';
              const isSelect = Array.isArray(p.enum) && p.enum.length > 0;
              const inputType = isSelect ? 'select' : (isTime ? 'picker' : 'text');
              const item = {
                label: p.description || p.name || '',
                value: p.name || '',
                inputType,
              };
              if (inputType === 'select') {
                item['children'] = [];
              }
              return item;
            });
          return list;
        }

        // 遍历辅助：按路径找到节点
        function findNodeByPath(roots, path) {
          if (!path) return null;
          const parts = path.split('.');
          let cur = null;
          let curList = roots;
          for (const seg of parts) {
            cur = (curList || []).find(n => n.name === seg);
            if (!cur) return null;
            curList = cur.children || [];
          }
          return cur;
        }

        // 将节点展开为"叶子字段列"
        function collectLeavesFromNode(node, basePath) {
          const out = [];
          if (!node) return out;

          const curPath = basePath ? basePath : node.name;
          const hasChildren = Array.isArray(node.children) && node.children.length > 0;

          if (!hasChildren) {
            const leafProp = String(curPath || node.name || '').split('.').pop() || '';
            out.push({
              prop: leafProp,
              label: node.description || (node.name || ''),
              sortable: false,
              show: true,
            });
            return out;
          }

          // 对象/数组：向下收集所有叶子
          for (const child of (node.children || [])) {
            const childPath = curPath ? (curPath + '.' + child.name) : child.name;
            out.push(...collectLeavesFromNode(child, childPath));
          }
          return out;
        }

        // 将整个根集合展开为叶子（用于"全部"）
        function collectAllLeaves(roots) {
          const out = [];
          for (const r of (roots || [])) {
            out.push(...collectLeavesFromNode(r, r.name));
          }
          return out;
        }

        function buildResponses(method, mode, apiPath) {
          const roots = __API_INFOS__[apiPath]?.byMethod?.[method]?.responses || [];
          let cols = [];

          if (mode === 'all') {
            const leaves = collectAllLeaves(roots);
            cols = [
              { label: "", type: "selection", show: true },
              ...leaves
            ];
            return cols;
          }

          // selected：允许任意层级
          const pickedPaths = Array.from(document.querySelectorAll(\`.resp-check[data-method="\${method}"][data-api-path="\${apiPath}"]:checked\`)).map(i => i.getAttribute('data-prop-path'));
          const seen = new Set();
          for (const p of pickedPaths) {
            const node = findNodeByPath(roots, p || '');
            if (!node) continue;
            const leaves = collectLeavesFromNode(node, p || node.name);
            for (const col of leaves) {
              if (seen.has(col.prop)) continue;
              seen.add(col.prop);
              cols.push(col);
            }
          }
          return cols;
        }

        function copyParams(method, mode, apiPath, btn) {
          const data = buildParams(method, mode, apiPath);
          // 单选返回对象，多选返回数组；全部复制始终数组
          if (mode === 'selected') {
            const selectedChecks = Array.from(document.querySelectorAll(\`.param-check[data-method="\${method}"][data-api-path="\${apiPath}"]:checked\`));
            const payload = selectedChecks.length === 1 ? (data[0] || {}) : data;
            copyText(JSON.stringify(payload, null, 2));
          } else {
            copyText(JSON.stringify(data, null, 2));
          }
          feedback(btn);
        }
        function copySingleParam(method, name, apiPath, btn) {
          const data = buildParams(method, 'all', apiPath).find(i => i.value === name);
          if (data) {
            // 单条复制直接返回对象
            copyText(JSON.stringify(data, null, 2));
            feedback(btn);
          }
        }
        function copyResponses(method, mode, apiPath, btn) {
          const data = buildResponses(method, mode, apiPath);
          copyText(JSON.stringify(data, null, 2));
          feedback(btn);
        }
        function copySingleResponse(method, path, apiPath, btn) {
          const roots = __API_INFOS__[apiPath]?.byMethod?.[method]?.responses || [];
          const node = findNodeByPath(roots, path);
          if (!node) return;
          const cols = collectLeavesFromNode(node, path);
          const payload = cols.length === 1 ? cols[0] : cols;
          copyText(JSON.stringify(payload, null, 2));
          feedback(btn);
        }
        function toggleSelectAll(kind, method, apiPath, el) {
          if (kind === 'params') {
            document.querySelectorAll(\`.param-check[data-method="\${method}"][data-api-path="\${apiPath}"]\`).forEach(i => i.checked = el.checked);
          } else {
            // 响应：当前可见层级（仅当前展开显示的行）
            document.querySelectorAll(\`.resp-check[data-method="\${method}"][data-api-path="\${apiPath}"]\`).forEach((i) => {
              const tr = i.closest('tr');
              if (tr && tr.style.display !== 'none') {
                i.checked = el.checked;
              }
            });
          }
        }
        
        // 页面加载完成后，默认展开第一层
        document.addEventListener('DOMContentLoaded', function() {
          const firstLevelButtons = document.querySelectorAll('.tree-row[data-level="0"] .expand-btn');
          firstLevelButtons.forEach(btn => btn.click());
        });
      </script>
    </body>
    </html>
  `;
}

// This method is called when your extension is deactivated
export function deactivate() {}
