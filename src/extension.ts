// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { SwaggerService } from './swaggerService';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "auto-columns" is now active!');

	// 注册提取Swagger信息的命令
	const extractSwaggerInfoCommand = vscode.commands.registerCommand('auto-columns.extractSwaggerInfo', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('请先打开一个文件');
			return;
		}

		const selection = editor.selection;
		if (selection.isEmpty) {
			vscode.window.showWarningMessage('请先选中一个URL地址');
			return;
		}

		const selectedText = editor.document.getText(selection);
		const swaggerService = SwaggerService.getInstance();
		
		// 从选中的文本中提取Swagger信息
		const swaggerInfo = swaggerService.extractSwaggerInfoFromUrl(selectedText);
		console.log(1111111, swaggerInfo,selectedText);
		
		if (!swaggerInfo) {
			vscode.window.showErrorMessage('无法从选中的文本中提取Swagger信息，请确保选中的是一个有效的API URL');
			return;
		}

		try {
			// 显示加载状态
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "正在解析Swagger API...",
				cancellable: false
			}, async (progress) => {
				console.log(444,progress,swaggerInfo);
				
				progress.report({ increment: 0 });
				
				// 解析Swagger API
				const apiInfo = await swaggerService.parseSwaggerApi(swaggerInfo.swaggerUrl, swaggerInfo.apiPath);
				console.log(5555,apiInfo);
				
				progress.report({ increment: 100 });
				
				if (apiInfo) {
					// 显示结果
					showSwaggerInfo(apiInfo, swaggerInfo.apiPath);
				} else {
					vscode.window.showErrorMessage('解析Swagger API失败');
				}
			});
		} catch (error) {
			vscode.window.showErrorMessage(`解析失败: ${error instanceof Error ? error.message : '未知错误'}`);
		}
	});

	// 注册Hello World命令（保留原有功能）
	const helloWorldCommand = vscode.commands.registerCommand('auto-columns.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from auto-columns!');
	});

	context.subscriptions.push(extractSwaggerInfoCommand, helloWorldCommand);
}

/**
 * 显示Swagger API信息
 */
function showSwaggerInfo(apiInfo: any, apiPath: string) {
	const panel = vscode.window.createWebviewPanel(
		'swaggerInfo',
		`Swagger API信息 - ${apiPath}`,
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);

	const html = generateSwaggerInfoHtml(apiInfo, apiPath);
	panel.webview.html = html;
}

/**
 * 生成响应字段的HTML - 树形结构（同一张表内）
 */
function generateResponsesHtml(responses: any[]): string {
	if (!responses || responses.length === 0) {
		return '<tr><td colspan="3" style="text-align: center; color: #666;">暂无响应信息</td></tr>';
	}

	return generateTreeHtml(responses, 0);
}

/**
 * 生成树形HTML（同表多行；父子行共享表格，统一 hover/样式）
 */
function generateTreeHtml(nodes: any[], level: number): string {
	return nodes.map(node => {
    if(node.type.includes('array')){
      console.log(1111, node);
    }
    console.log(2222, node);
		const indent = level * 20;
		const hasChildren = node.children && node.children.length > 0;
		const nodeId = `node-${Math.random().toString(36).substr(2, 9)}`;

		// 父行
		const currentRow = `
      <tr class="tree-row" data-level="${level}" data-node-id="${nodeId}">
        <td style="padding-left: ${indent + 12}px;">
          <span class="tree-node" data-node-id="${nodeId}">
            ${hasChildren ? `<button class="expand-btn" onclick="toggleNode('${nodeId}')">+</button>` : '<span class="no-expand"></span>'}
            <span class="field-name">${node.name}</span>
          </span>
        </td>
        <td><span class="type">${node.type}</span></td>
        <td>${node.description || '-'}</td>
        </tr>
        `;

		// 子行（默认隐藏，通过 data-parent 进行层级控制）
		const childrenRows = hasChildren
			? node.children.map((child: any) => generateChildRows(child, level + 1, nodeId)).join('')
			: '';
		return currentRow + childrenRows;
	}).join('');
}

/**
 * 生成子节点行（递归，仍在同一张表）
 */
function generateChildRows(node: any, level: number, parentId: string): string {
	const indent = level * 20;
	const hasChildren = node.children && node.children.length > 0;
	const nodeId = `node-${Math.random().toString(36).substr(2, 9)}`;

	const row = `
    <tr class="tree-row" data-level="${level}" data-parent="${parentId}" data-node-id="${nodeId}" style="display: none;">
      <td style="padding-left: ${indent + 12}px;">
        <span class="tree-node" data-node-id="${nodeId}">
          ${hasChildren ? `<button class="expand-btn" onclick="toggleNode('${nodeId}')">+</button>` : '<span class="no-expand"></span>'}
          <span class="field-name">${node.name}</span>
        </span>
      </td>
      <td><span class="type">${node.type}</span></td>
      <td>${node.description || '-'}</td>
    </tr>
  `;

	const childrenRows = hasChildren
		? node.children.map((child: any) => generateChildRows(child, level + 1, nodeId)).join('')
		: '';

	return row + childrenRows;
}

/**
 * 生成Swagger信息HTML（支持同路径多方法 Tab 切换）
 */
function generateSwaggerInfoHtml(apiInfo: any, apiPath: string): string {
	const methodOrder = ['GET','POST','PUT','DELETE','PATCH'];
	const available = methodOrder.filter(m => apiInfo.byMethod && apiInfo.byMethod[m]);
	const first = available[0];

	const tabsHtml = available.map(m => `
    <button class="tab-btn${m === first ? ' active' : ''}" data-method="${m}" onclick="switchMethod('${m}')">${m}</button>
  `).join('');

	const sectionsHtml = available.map(m => {
		const methodInfo = apiInfo.byMethod[m];
		const parametersHtml = (methodInfo.parameters || []).map((param: any) => `
      <tr>
        <td>${param.name}</td>
        <td><span class="type">${param.type}</span></td>
        <td><span class="${param.required ? 'required' : ''}">${param.required ? '是' : '否'}</span></td>
        <td>${param.description || '-'}</td>
      </tr>
    `).join('');

		const responsesHtml = generateResponsesHtml(methodInfo.responses || []);

		return `
      <div class="method-section" data-method="${m}" style="${m === first ? '' : 'display:none;'}">
        <div class="section">
          <h2>请求参数</h2>
          <table>
            <thead>
              <tr>
                <th>参数名</th>
                <th>类型</th>
                <th>必填</th>
                <th>描述</th>
              </tr>
            </thead>
            <tbody>
              ${parametersHtml || '<tr><td colspan="4" style="text-align: center; color: #666;">暂无参数信息</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="section">
          <h2>响应字段 (200状态码)</h2>
          <table>
            <thead>
              <tr>
                <th>字段名</th>
                <th>类型</th>
                <th>描述</th>
              </tr>
            </thead>
            <tbody>
              ${responsesHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
	}).join('');

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
        /* 统一 hover 效果，与 VS Code 列表 hover 接近 */
        tr:hover,
        .tree-row:hover {
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