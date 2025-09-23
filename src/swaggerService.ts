import axios from 'axios';
/* import SwaggerParser from 'swagger-parser'; */
// @ts-ignore
/* import SwaggerClient from 'swagger-client'; */
/* const SwaggerClient = require('swagger-client'); */
import SwaggerParser from 'swagger-parser';

export interface ResponseNode {
  name: string;
  type: string;
  description?: string;
  children?: ResponseNode[];
}

export interface SwaggerInfo {
  byMethod: Record<string, {
    parameters: Array<{
      name: string;
      type: string;
      required: boolean;
      description?: string;
    }>;
    responses: ResponseNode[];
  }>;
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
  async parseSwaggerApi(swaggerUrl: string, apiPath: string): Promise<SwaggerInfo | null> {
    try {
      // 使用 SwaggerParser 解析 Swagger 文档，自动处理 $ref 引用
      console.log('开始解析 Swagger 文档:', swaggerUrl);
      const swaggerDoc: any = await SwaggerParser.dereference(swaggerUrl);
      // console.log('解析后的 Swagger 客户端:', client);
      
      // 获取解析后的 API 文档
      // const swaggerDoc = client.spec;
      console.log('解析后的 API 文档:', swaggerDoc);
      
      // 查找匹配的API路径
      const paths = swaggerDoc.paths;
      if (!paths || !paths[apiPath]) {
        console.log('可用的路径:', Object.keys(paths || {}));
        throw new Error(`未找到API路径: ${apiPath}`);
      }
      console.log('找到路径:', apiPath, paths[apiPath]);

      const pathItem = paths[apiPath];
      const methods = ['get', 'post', 'put', 'delete', 'patch'];
      
      const byMethod: Record<string, { parameters: any[]; responses: ResponseNode[] }> = {};
      for (const method of methods) {
        if (pathItem[method]) {
          const operation = pathItem[method];
          console.log('找到的操作方法:', method, operation);

          // 提取参数信息
          const parameters = this.extractParameters(operation);
          console.log('提取的参数:', parameters);
          
          // 提取响应信息（树形结构）
          const responses = this.extractResponses(operation);
          console.log('提取的响应（树形）:', responses);

          byMethod[method.toUpperCase()] = { parameters, responses };
        }
      }

      if (Object.keys(byMethod).length === 0) {
        throw new Error(`未找到有效的HTTP方法: ${apiPath}`);
      }

      return { byMethod };
    } catch (error) {
      console.error('解析Swagger API失败:', error);
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
  }> {
    const parameters: Array<{
      name: string;
      type: string;
      required: boolean;
      description?: string;
    }> = [];

    if (operation.parameters) {
      for (const param of operation.parameters) {
        parameters.push({
          name: param.name,
          type: param.schema?.type || param.type || 'string',
          required: param.required || false,
          description: param.description
        });
      }
    }

    // 提取请求体参数
    if (operation.requestBody) {
      const content = operation.requestBody.content;
      if (content) {
        for (const [contentType, contentSchema] of Object.entries(content)) {
          const schema = (contentSchema as any).schema;
          if (!schema) continue;

          // 仅处理 JSON 请求体
          if (contentType === 'application/json') {
            // 顶层 object 的 required 列表
            const requiredProps: string[] = Array.isArray((schema as any).required) ? (schema as any).required : [];

            // 仅处理 object 的 properties（常见情况）
            if ((schema as any).type === 'object' && (schema as any).properties) {
              for (const [propName, propSchema] of Object.entries((schema as any).properties)) {
                parameters.push({
                  name: propName,
                  type: (propSchema as any).type || 'string',
                  // 按 schema.required 判定字段级必填
                  required: requiredProps.includes(propName),
                  description: (propSchema as any).description
                });
              }
            }

            // 若 schema 没声明 type 但有 properties（有些 dereference 后可能如此）
            if (!(schema as any).type && (schema as any).properties) {
              for (const [propName, propSchema] of Object.entries((schema as any).properties)) {
                parameters.push({
                  name: propName,
                  type: (propSchema as any).type || 'string',
                  required: requiredProps.includes(propName),
                  description: (propSchema as any).description
                });
              }
            }
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
    console.log('操作对象结构:', operation);

    if (!operation.responses) {
      console.log('操作对象中没有 responses 字段');
      return tree;
    }

    // 优先选择 2xx 成功响应
    const successResponse =
      operation.responses['200'] ||
      operation.responses['201'] ||
      operation.responses['202'] ||
      Object.entries(operation.responses).find(([code]: any) => String(code).startsWith('2'))?.[1];

    if (!successResponse) {
      console.log('未找到成功状态码的响应');
      return tree;
    }

    const responseObj = successResponse as any;
    if (!responseObj.content) {
      console.log('响应没有 content，返回空');
      return tree;
    }

    for (const [contentType, contentSchema] of Object.entries(responseObj.content)) {
      if (contentType !== 'application/json') continue;
      const schema = (contentSchema as any).schema;
      if (!schema) continue;

      // 构建根层级节点
      const top = this.buildNodesFromSchema(schema);

      // 如果顶层是对象，则将其 children 作为顶层字段（items、totalCount 等）
      if (top.type === 'object' && top.children) {
        tree.push(...top.children);
      } else {
        tree.push(top);
      }
    }

    console.log('最终提取的响应树:', tree);
    return tree;
  }

  /**
   * 根据 Schema 生成节点（递归）
   */
  private buildNodesFromSchema(schema: any, name: string = '', description?: string): ResponseNode {
    const resolvedType = this.resolveSchemaType(schema);

    // 对象
    if (resolvedType === 'object') {
      const node: ResponseNode = {
        name: name || (schema.title || ''),
        type: 'object',
        description: description || schema.description,
        children: []
      };

      const props = schema.properties || {};
      for (const [propName, propSchema] of Object.entries<any>(props)) {
        const childNode = this.buildNodesFromSchema(propSchema, propName, (propSchema as any).description);
        node.children!.push(childNode);
      }

      // 处理 additionalProperties（Map结构）
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const apNode = this.buildNodesFromSchema(schema.additionalProperties, '[key]', schema.description);
        (node.children as ResponseNode[]).push(apNode);
      }

      if (!node.children || node.children.length === 0) delete node.children;
      return node;
    }

    // 数组（扁平化中间层：不再生成 name[] 节点）
    if (resolvedType === 'array') {
      const itemsSchema = schema.items || {};
      // 先生成元素节点（可递归为对象/数组/基础类型）
      const elementNode = this.buildNodesFromSchema(itemsSchema, '', (itemsSchema as any).description);
      console.log(5555,elementNode);

      // 数组节点的类型标注为 array<元素类型>
      const node: ResponseNode = {
        name: name || (schema.title || ''),
        type: `array`,
        // type: `array<${elementNode.type}>`,
        description: description || schema.description
      };

      // 如果元素是对象，则直接将对象的属性作为数组节点的 children（不再多出一层元素行）
      if (elementNode.type === 'object' && elementNode.children && elementNode.children.length > 0) {
        node.children = elementNode.children;
      }
      // 如果元素还是数组（多维数组），延用其 children 并在类型上已体现为 array<array<...>>
      if (elementNode.type.startsWith('array') && elementNode.children && elementNode.children.length > 0) {
        node.children = elementNode.children;
      }

      return node;
    }
    // 基本类型
    return {
      name: name || (schema.title || ''),
      type: resolvedType || 'string',
      description: description || schema.description
    };
  }

  /**
   * 解析 schema.type，兼容 allOf/oneOf/anyOf（已 dereference）
   */
  private resolveSchemaType(schema: any): string {
    if (!schema) return 'object';
    if (schema.type) return schema.type;

    // allOf 合并后可能没有 type，但有 properties/items
    if (schema.properties) return 'object';
    if (schema.items) return 'array';

    // oneOf/anyOf 简单取第一个
    const candidate =
      (Array.isArray(schema.allOf) && schema.allOf.find((s: any) => s.type)) ||
      (schema.oneOf && schema.oneOf[0]) ||
      (schema.anyOf && schema.anyOf[0]);

    if (candidate) {
      if (candidate.type) return candidate.type;
      if (candidate.properties) return 'object';
      if (candidate.items) return 'array';
    }

    return 'object';
  }

  
  /**
   * 从URL中提取Swagger基础URL和API路径
   */
  private sanitizeInputUrl(raw: string): string {
    // 去掉前后空白与前缀@（如：@http://...）
    return (raw || '').trim().replace(/^@+/, '');
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  extractSwaggerInfoFromUrl(url: string): { swaggerUrl: string; apiPath: string } | null {
    try {
      const original = this.sanitizeInputUrl(url);
      // 匹配常见的Swagger URL模式
      const swaggerPatterns = [
        /^(https?:\/\/[^\/]+)\/swagger\/v\d+\/swagger\.json$/,
        /^(https?:\/\/[^\/]+)\/v\d+\/api-docs$/,
        /^(https?:\/\/[^\/]+)\/swagger-ui\/swagger\.json$/,
        /^(https?:\/\/[^\/]+)\/api-docs$/,
        /^(https?:\/\/[^\/]+)\/swagger\.json$/
      ];

      for (const pattern of swaggerPatterns) {
        const match = original.match(pattern);
        if (match) {
          const swaggerUrl = match[0];
          // 从原URL中提取API路径（保留花括号），并去掉查询/锚点
          let apiPath = original.replace(swaggerUrl, '');
          apiPath = apiPath.split('#')[0].split('?')[0];
          return { swaggerUrl, apiPath: apiPath || '/' };
        }
      }

      // 如果不是标准的Swagger URL，尝试从URL中推断
      // 为了能构造 URL 对象，先对 {} 做临时编码
      const tempForParse = original.replace(/{/g, '%7B').replace(/}/g, '%7D');
      const urlObj = new URL(tempForParse);

      // 使用 origin，从原始字符串中减去 origin 获得原始的路径（保留花括号）
      const originRe = new RegExp('^' + this.escapeRegExp(urlObj.origin));
      let rawPath = original.replace(originRe, '');
      // 去掉查询/锚点
      rawPath = rawPath.split('#')[0].split('?')[0];
      if (!rawPath.startsWith('/')) rawPath = '/' + rawPath.replace(/^\/+/, '');

      const possibleSwaggerUrls = [
        `${urlObj.origin}/swagger/v1/swagger.json`,
        `${urlObj.origin}/v1/api-docs`,
        `${urlObj.origin}/swagger-ui/swagger.json`,
        `${urlObj.origin}/api-docs`,
        `${urlObj.origin}/swagger.json`
      ];

      return { swaggerUrl: possibleSwaggerUrls[0], apiPath: rawPath || '/' };
    } catch (error) {
      console.error('解析URL失败:', error);
      return null;
    }
  }
}