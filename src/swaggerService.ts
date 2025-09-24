import axios from "axios";
/* import SwaggerParser from 'swagger-parser'; */
// @ts-ignore
/* import SwaggerClient from 'swagger-client'; */
/* const SwaggerClient = require('swagger-client'); */
// import SwaggerParser from "swagger-parser";
import SwaggerParser from "@apidevtools/swagger-parser";

export interface ResponseNode {
  name: string;
  type: string;
  description?: string;
  children?: ResponseNode[];
}

export interface SwaggerInfo {
  byMethod: Record<
    string,
    {
      parameters: Array<{
        name: string;
        type: string;
        required: boolean;
        description?: string;
      }>;
      responses: ResponseNode[];
    }
  >;
}

export class SwaggerService {
  private static instance: SwaggerService;

  public static getInstance(): SwaggerService {
    if (!SwaggerService.instance) {
      SwaggerService.instance = new SwaggerService();
    }
    return SwaggerService.instance;
  }
  /**
   * 从Swagger URL解析API信息
   * @param swaggerUrl Swagger文档URL
   * @param apiPath API路径
   */
  async parseSwaggerApi(
    swaggerUrl: string,
    apiPath: string
  ): Promise<SwaggerInfo | null> {
    try {
      // 使用 SwaggerParser 解析 Swagger 文档，自动处理 $ref 引用
      console.log("开始解析 Swagger 文档:", swaggerUrl);
      const swaggerDoc: any = await SwaggerParser.dereference(swaggerUrl);
      // console.log('解析后的 Swagger 客户端:', client);

      // 获取解析后的 API 文档
      // const swaggerDoc = client.spec;
      console.log("解析后的 API 文档:", swaggerDoc);

      // 查找匹配的API路径
      const paths = swaggerDoc.paths;
      if (!paths || !paths[apiPath]) {
        console.log("可用的路径:", Object.keys(paths || {}));
        throw new Error(`未找到API路径: ${apiPath}`);
      }
      console.log("找到路径:", apiPath, paths[apiPath]);

      const pathItem = paths[apiPath];
      const methods = ["get", "post", "put", "delete", "patch"];

      const byMethod: Record<
        string,
        { parameters: any[]; responses: ResponseNode[] }
      > = {};
      for (const method of methods) {
        if (pathItem[method]) {
          const operation = pathItem[method];
          console.log("找到的操作方法:", method, operation);

          // 提取参数信息
          const parameters = this.extractParameters(operation);
          console.log("提取的参数:", parameters);

          // 提取响应信息（树形结构）
          const responses = this.extractResponses(operation);
          console.log("提取的响应（树形）:", responses);

          byMethod[method.toUpperCase()] = { parameters, responses };
        }
      }

      if (Object.keys(byMethod).length === 0) {
        throw new Error(`未找到有效的HTTP方法: ${apiPath}`);
      }

      return { byMethod };
    } catch (error) {
      console.error("解析Swagger API失败:", error);
      throw error;
    }
  }

  /**
   * 提取参数信息
   */
  private extractParameters(operation: any): Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
    format?: string;
    enum?: any[];
  }> {
    const parameters: Array<{
      name: string;
      type: string;
      required: boolean;
      description?: string;
      format?: string;
      enum?: any[];
    }> = [];

    // helper: 递归提取 requestBody schema 的叶子字段（仅保留叶子名，不带父路径）
    const collectLeaves = (
      schema: any,
      cb: (info: {
        name: string;
        type: string;
        description?: string;
        format?: string;
        enum?: any[];
      }) => void
    ) => {
      if (!schema) return;

      // 解析类型
      const sType = this.resolveSchemaType(schema);

      // 数组：深入 items
      if (sType === "array") {
        const items = schema.items || {};
        collectLeaves(items, cb);
        return;
      }

      // 对象：遍历 properties；若无 properties 但有 additionalProperties，当作 map，深入其值类型
      if (sType === "object") {
        const props = schema.properties || {};
        for (const [propName, propSchema] of Object.entries<any>(props)) {
          const t = this.resolveSchemaType(propSchema);
          if (t === "object" || t === "array") {
            collectLeaves(propSchema, cb);
          } else {
            cb({
              name: propName,
              type: propSchema.type || t || "string",
              description: propSchema.description,
              format: propSchema.format,
              enum: propSchema.enum,
            });
          }
        }
        if (
          !schema.properties &&
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object"
        ) {
          collectLeaves(schema.additionalProperties, cb);
        }
        return;
      }

      // 基础类型：自身为叶子，但没有名字（顶部叶子不常见，跳过）
      // 此分支通常不会用于 requestBody 的顶层
    };

    if (operation.parameters) {
      for (const param of operation.parameters) {
        const pSchema = param.schema || {};
        parameters.push({
          name: param.name,
          type: pSchema.type || param.type || "string",
          required: param.required || false,
          description: param.description,
          format: pSchema.format,
          enum: pSchema.enum,
        });
      }
    }

    // 提取请求体参数（递归所有层级叶子）
    if (operation.requestBody) {
      const content = operation.requestBody.content;
      if (content) {
        for (const [contentType, contentSchema] of Object.entries(content)) {
          const schema = (contentSchema as any).schema;
          if (!schema) continue;

          // 仅处理 JSON 请求体
          if (contentType === "application/json") {
            collectLeaves(schema, (info) => {
              parameters.push({
                name: info.name,
                type: info.type || "string",
                required: false, // 叶子级别的 required 在 schema.required（父级）里，递归时难以精确映射，统一 false
                description: info.description,
                format: info.format,
                enum: info.enum,
              });
            });
          }
        }
      }
    }

    return parameters;
  }

  /**
   * 提取响应信息（树形结构）
   */
  private extractResponses(operation: any): ResponseNode[] {
    const tree: ResponseNode[] = [];
    console.log("操作对象结构:", operation);

    if (!operation.responses) {
      console.log("操作对象中没有 responses 字段");
      return tree;
    }

    // 优先选择 2xx 成功响应
    const successResponse =
      operation.responses["200"] ||
      operation.responses["201"] ||
      operation.responses["202"] ||
      Object.entries(operation.responses).find(([code]: any) =>
        String(code).startsWith("2")
      )?.[1];

    if (!successResponse) {
      console.log("未找到成功状态码的响应");
      return tree;
    }

    const responseObj = successResponse as any;
    if (!responseObj.content) {
      console.log("响应没有 content，返回空");
      return tree;
    }

    for (const [contentType, contentSchema] of Object.entries(
      responseObj.content
    )) {
      if (contentType !== "application/json") continue;
      const schema = (contentSchema as any).schema;
      if (!schema) continue;

      // 构建根层级节点
      const top = this.buildNodesFromSchema(schema);

      // 如果顶层是对象，则将其 children 作为顶层字段（items、totalCount 等）
      if (top.type === "object" && top.children) {
        tree.push(...top.children);
      } else {
        tree.push(top);
      }
    }

    console.log("最终提取的响应树:", tree);
    return tree;
  }

  /**
   * 根据 Schema 生成节点（递归）
   */
  private buildNodesFromSchema(
    schema: any,
    name: string = "",
    description?: string
  ): ResponseNode {
    const resolvedType = this.resolveSchemaType(schema);

    // 对象
    if (resolvedType === "object") {
      const node: ResponseNode = {
        name: name || schema.title || "",
        type: "object",
        description: description || schema.description,
        children: [],
      };

      const props = schema.properties || {};
      for (const [propName, propSchema] of Object.entries<any>(props)) {
        const childNode = this.buildNodesFromSchema(
          propSchema,
          propName,
          (propSchema as any).description
        );
        node.children!.push(childNode);
      }

      // 处理 additionalProperties（Map结构）
      if (
        !schema.properties &&
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        const apNode = this.buildNodesFromSchema(
          schema.additionalProperties,
          "[key]",
          schema.description
        );
        (node.children as ResponseNode[]).push(apNode);
      }

      if (!node.children || node.children.length === 0) delete node.children;
      return node;
    }

    // 数组（扁平化中间层：不再生成 name[] 节点）
    if (resolvedType === "array") {
      const itemsSchema = schema.items || {};
      // 先生成元素节点（可递归为对象/数组/基础类型）
      const elementNode = this.buildNodesFromSchema(
        itemsSchema,
        "",
        (itemsSchema as any).description
      );
      console.log(5555, elementNode);

      // 数组节点的类型标注为 array<元素类型>
      const node: ResponseNode = {
        name: name || schema.title || "",
        type: `array`,
        // type: `array<${elementNode.type}>`,
        description: description || schema.description,
      };

      // 如果元素是对象，则直接将对象的属性作为数组节点的 children（不再多出一层元素行）
      if (
        elementNode.type === "object" &&
        elementNode.children &&
        elementNode.children.length > 0
      ) {
        node.children = elementNode.children;
      }
      // 如果元素还是数组（多维数组），延用其 children 并在类型上已体现为 array<array<...>>
      if (
        elementNode.type.startsWith("array") &&
        elementNode.children &&
        elementNode.children.length > 0
      ) {
        node.children = elementNode.children;
      }

      return node;
    }
    // 基本类型
    return {
      name: name || schema.title || "",
      type: resolvedType || "string",
      description: description || schema.description,
    };
  }

  /**
   * 解析 schema.type，兼容 allOf/oneOf/anyOf（已 dereference）
   */
  private resolveSchemaType(schema: any): string {
    if (!schema) return "object";
    if (schema.type) return schema.type;

    // allOf 合并后可能没有 type，但有 properties/items
    if (schema.properties) return "object";
    if (schema.items) return "array";

    // oneOf/anyOf 简单取第一个
    const candidate =
      (Array.isArray(schema.allOf) && schema.allOf.find((s: any) => s.type)) ||
      (schema.oneOf && schema.oneOf[0]) ||
      (schema.anyOf && schema.anyOf[0]);

    if (candidate) {
      if (candidate.type) return candidate.type;
      if (candidate.properties) return "object";
      if (candidate.items) return "array";
    }

    return "object";
  }

  /**
   * 从URL中提取Swagger基础URL和API路径
   */
  private sanitizeInputUrl(raw: string): string {
    // 去掉前后空白与前缀@（如：@http://...）
    return (raw || "").trim().replace(/^@+/, "");
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  extractSwaggerInfoFromUrl(
    url: string
  ): { swaggerUrl: string; apiPath: string } | null {
    try {
      const original = this.sanitizeInputUrl(url);
      // 匹配常见的Swagger URL模式
      const swaggerPatterns = [
        /^(https?:\/\/[^\/]+)\/swagger\/v\d+\/swagger\.json$/,
        /^(https?:\/\/[^\/]+)\/v\d+\/api-docs$/,
        /^(https?:\/\/[^\/]+)\/swagger-ui\/swagger\.json$/,
        /^(https?:\/\/[^\/]+)\/api-docs$/,
        /^(https?:\/\/[^\/]+)\/swagger\.json$/,
      ];

      for (const pattern of swaggerPatterns) {
        const match = original.match(pattern);
        if (match) {
          const swaggerUrl = match[0];
          // 从原URL中提取API路径（保留花括号），并去掉查询/锚点
          let apiPath = original.replace(swaggerUrl, "");
          apiPath = apiPath.split("#")[0].split("?")[0];
          return { swaggerUrl, apiPath: apiPath || "/" };
        }
      }

      // 如果不是标准的Swagger URL，尝试从URL中推断
      // 为了能构造 URL 对象，先对 {} 做临时编码
      const tempForParse = original.replace(/{/g, "%7B").replace(/}/g, "%7D");
      const urlObj = new URL(tempForParse);

      // 使用 origin，从原始字符串中减去 origin 获得原始的路径（保留花括号）
      const originRe = new RegExp("^" + this.escapeRegExp(urlObj.origin));
      let rawPath = original.replace(originRe, "");
      // 去掉查询/锚点
      rawPath = rawPath.split("#")[0].split("?")[0];
      if (!rawPath.startsWith("/")) rawPath = "/" + rawPath.replace(/^\/+/, "");

      const possibleSwaggerUrls = [
        `${urlObj.origin}/swagger/v1/swagger.json`,
        `${urlObj.origin}/v1/api-docs`,
        `${urlObj.origin}/swagger-ui/swagger.json`,
        `${urlObj.origin}/api-docs`,
        `${urlObj.origin}/swagger.json`,
      ];

      return { swaggerUrl: possibleSwaggerUrls[0], apiPath: rawPath || "/" };
    } catch (error) {
      console.error("解析URL失败:", error);
      return null;
    }
  }

  /**
   * 从多个URL中提取Swagger信息
   */
  extractSwaggerInfoFromUrls(
    urls: string | string[]
  ): { swaggerUrl: string; apiPath: string }[] {
    try {
      let urlList: string[];

      // 判断输入是字符串还是数组
      if (typeof urls === "string") {
        // 尝试解析JSON数组格式
        try {
          const parsed = JSON.parse(urls);
          if (Array.isArray(parsed)) {
            urlList = parsed;
          } else {
            urlList = [urls];
          }
        } catch {
          // 如果不是JSON格式，当作单个URL处理
          urlList = [urls];
        }
      } else {
        urlList = urls;
      }

      const results: { swaggerUrl: string; apiPath: string }[] = [];

      for (const url of urlList) {
        const swaggerInfo = this.extractSwaggerInfoFromUrl(url);
        if (swaggerInfo) {
          results.push(swaggerInfo);
        }
      }

      return results;
    } catch (error) {
      console.error("解析多URL失败:", error);
      return [];
    }
  }

  /**
   * 解析多个Swagger API
   */
  async parseMultipleSwaggerApis(
    swaggerInfos: { swaggerUrl: string; apiPath: string }[]
  ): Promise<{ [apiPath: string]: SwaggerInfo }> {
    const results: { [apiPath: string]: SwaggerInfo } = {};

    for (const swaggerInfo of swaggerInfos) {
      try {
        const apiInfo = await this.parseSwaggerApi(
          swaggerInfo.swaggerUrl,
          swaggerInfo.apiPath
        );
        if (apiInfo) {
          results[swaggerInfo.apiPath] = apiInfo;
        }
      } catch (error) {
        console.error(`解析API失败 ${swaggerInfo.apiPath}:`, error);
      }
    }

    return results;
  }
}
