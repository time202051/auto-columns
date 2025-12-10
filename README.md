# auto-columns

从 Swagger/OpenAPI 文档中提取接口的请求参数与 200 响应字段，在 VS Code 中以可视化方式展示，并一键复制为前端所需的配置结构。

## 功能

- **Webview 可视化展示**：内置"复制选中 / 复制全部 / 单条复制"，并自动写入系统剪贴板
- **智能接口收集**：自动识别并收集代码中使用的 API 接口地址
- **Swagger 基地址配置**：支持全局配置 Swagger 服务地址，自动拼接接口路径

## 效果截图

![提取单个接口展示](https://raw.githubusercontent.com/time202051/auto-columns/master/images/demo-dark.png)
![多接口切换与复制](https://raw.githubusercontent.com/time202051/auto-columns/master/images/demo-light.png)

## 使用方式

### 自动收集接口

1. 在 Vue 或 JavaScript 文件中右键
2. 选择 `提取页面Swagger接口信息` 命令
3. 插件会自动：
   - 扫描当前文件中的 swagger 模块导入
   - 识别实际使用的接口调用
   - 收集直接写死的 URL 路径
   - 解析 swagger.js 文件获取真实 URL
   - 自动进入 Swagger 信息提取流程

> 提示：支持从常见的 Swagger 文档地址推断 `swagger.json`（如 `/swagger/v1/swagger.json`、`/api-docs` 等）。

#### 支持的接口用法

```javascript
import { Basic } from "@/api/request/swagger";
import { Warehouse } from "@/api/swagger";

// 命名导入用法
this.post({
  url: Basic.exportWorkBench,
});

// 条件选择
this.get({
  url: true ? Basic.selectWarehouseList : Basic.deleteClasses,
});
// 直接写死
this.get({
  url: "/api/app/product/product-pages",
});
```

#### 自动收集要求

**swagger.js 文件要求**：

- 接口地址文件必须命名为 `swagger.js`
- URL 必须是完整的，如 swagger 文档中地址为 `/api/app/warehouse/cargo-location/{cargoLocationId}`，那 url 必须包含 `{cargoLocationId}` 不能省略

## 配置说明

### Swagger 基地址配置

首次使用时会提示输入 Swagger 基地址（如 `https://api.example.com`），该地址会自动拼接到所有收集到的 URL 前面。

**配置方式：**

- 右键选择：`设置 Swagger 基地址`（在任何文件中都可用）
- 或在首次使用自动收集功能时输入

**路径拼接规则：**

- 基地址：`https://api.example.com`
- 接口路径：`/api/app/user/list`
- 最终 URL：`https://api.example.com/api/app/user/list`

### 路径解析规则

插件支持以下路径解析方式：

1. **别名路径**：`@/api/request/swagger` → `<项目根>/src/api/request/swagger.js`
2. **相对路径**：`./api/swagger` → `<当前文件目录>/api/swagger.js`
3. **绝对路径**：`/api/swagger` → `<项目根>/api/swagger.js`

**注意：**

- `@` 别名默认映射到 `<项目根>/src/` 目录
- 仅支持 `.js` 文件格式，不支持 `.ts` 或其他格式

### 接口文件格式要求

swagger.js 文件需要遵循以下格式：

```javascript
const baseURL = "";

export const Basic = {
  getCustomerList: `${baseURL}/api/app/customer/list`,
  selectCompanyList: `${baseURL}/api/app/company/select`,
  exportCustomer: `${baseURL}/api/app/customer/export`,
};

export const accountUser = {
  currentUser: `${baseURL}/api/app/user/current`,
};

// 支持命名空间导出
export const User = {
  getUserList: `${baseURL}/api/app/user/list`,
  getUserDetail: `${baseURL}/api/app/user/{userId}`,
};
```

**支持的值类型：**

- 模板字符串：`` `${baseURL}/api/path` ``
- 字符串拼接：`baseURL + '/api/path'`
- 纯字符串：`'/api/path'`

## 复制规则

### 请求参数（用于搜索框）

输出结构示例：

```json
[
  { "label": "区域编码", "value": "Code", "inputType": "text" },
  { "label": "区域名称", "value": "RegionName", "inputType": "text" },
  {
    "label": "区域属性",
    "value": "RegionAttributes",
    "inputType": "select",
    "children": []
  }
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
  {
    "prop": "regionCode",
    "label": "区域编码",
    "minWidth": "",
    "sortable": false,
    "show": true
  }
]
```

- 仅"复制全部"会在首位包含 `selection` 列
- "复制选中"与"单条复制"不包含 `selection` 列
- `prop` 为叶子字段名（不带父级路径）
- 单条复制：返回对象；多条/全部复制：返回数组

## 命令

- `auto-columns.extractSwaggerInfo`: 解析选中文本中的接口地址并展示信息
- `auto-columns.collectApiUrls`: 自动收集当前文件中的接口 URL（仅在 Vue/JS 文件中显示）
- `auto-columns.setSwaggerBaseUrl`: 设置 Swagger 基地址（在任何文件中都可用）
- `auto-columns.helloWorld`: 示例命令

## 系统要求

- VS Code 1.60+（或与 `engines.vscode` 一致的版本）
- 可访问对应的 Swagger/OpenAPI 文档地址
- 项目中使用标准的 swagger.js 文件格式

## 反馈

有问题或建议，欢迎在仓库提交 Issue 或 PR。
