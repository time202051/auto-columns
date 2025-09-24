# auto-columns

从 Swagger/OpenAPI 文档中提取分页接口的请求参数与 200 响应字段，在 VS Code 中以可视化方式展示，并一键复制为前端所需的配置结构。

## 功能
- 提取并展示同一路径下不同 HTTP 方法的请求参数与 200 响应字段
- 入参复制：生成搜索框配置（支持单选/多选、任意层级、类型映射）
- 响应复制：生成 `el-table` 列配置（支持单选/多选、任意层级）
- Webview 内置“复制选中 / 复制全部 / 单条复制”，并自动写入系统剪贴板

## 使用方式
1. 在代码中选中一个包含接口地址的文本（可包含完整 URL 或同域接口路径）
2. 运行命令：`Auto Columns: 提取 Swagger 信息`
3. 在弹出的面板中，切换到对应的 HTTP 方法 Tab
4. 根据需要“复制选中 / 复制全部 / 单条复制”

> 提示：支持从常见的 Swagger 文档地址推断 `swagger.json`（如 `/swagger/v1/swagger.json`、`/api-docs` 等）。

## 复制规则

### 请求参数（用于搜索框）
输出结构示例：
```json
[
  { "label": "区域编码", "value": "Code", "inputType": "text" },
  { "label": "区域名称", "value": "RegionName", "inputType": "text" },
  { "label": "区域属性", "value": "RegionAttributes", "inputType": "select", "children": [] }
]
```
- 单条复制：返回对象
- 多条/全部复制：返回数组
- 类型映射：
  - 枚举（存在 `enum`）→ `select`，并包含 `children: []`
  - 时间类（`format` 为 `date`/`date-time`/`datetime`/`time`/`timestamp`）→ `picker`
  - 其他 → `text`
- 支持 requestBody 任意层级（递归提取叶子字段），`value` 使用叶子字段名（不带父级路径）

### 响应字段（用于 el-table）
输出结构示例（部分）：
```json
[
  { "label": "", "minWidth": "", "type": "selection", "show": true },
  { "prop": "regionCode", "label": "区域编码", "minWidth": "", "sortable": false, "show": true }
]
```
- 仅“复制全部”会在首位包含 `selection` 列
- “复制选中”与“单条复制”不包含 `selection` 列
- `prop` 为叶子字段名（不带父级路径）
- 单条复制：返回对象；多条/全部复制：返回数组

## 命令
- `auto-columns.extractSwaggerInfo`: 解析选中文本中的接口地址并展示信息
- `auto-columns.helloWorld`: 示例命令

## 需求
- VS Code 1.85+（或与 `engines.vscode` 一致的版本）
- 可访问对应的 Swagger/OpenAPI 文档地址

## 反馈
有问题或建议，欢迎在仓库提交 Issue 或 PR。