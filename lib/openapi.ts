import { SERVICE_VERSION } from './version';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const id = {
  name: 'profileId',
  in: 'path',
  required: true,
  schema: { type: 'integer', minimum: 1 }
};
const errors = {
  '400': { description: '输入错误', content: json(ref('Error')) },
  '401': { description: '管理员凭据无效' },
  '428': { description: '缺少 If-Match 版本前提条件' },
  '503': { description: '服务未配置管理员认证' },
  '404': { description: '资源不存在' },
  '409': {
    description: '版本冲突、引用冲突或没有成功生成的版本；revision.conflict 含 currentRevision 和 expectedRevision',
    content: json(ref('Error'))
  }
};
function operation(
  summary: string,
  body?: object,
  response: object = { type: 'object' }
) {
  return {
    summary,
    ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
    responses: {
      '200': { description: '成功', content: json(response) },
      ...errors
    }
  };
}
const object = { type: 'object', additionalProperties: true };
const name = { type: 'string', minLength: 1, maxLength: 160 };
const configToken = { name: 'token', in: 'path', required: true, schema: { type: 'string' } };
const shadowrocketFile = {
  description: 'Shadowrocket .conf 附件；X-Config-Revision 表示实际下载版本',
  content: { 'text/plain': { schema: { type: 'string' } } }
};
const paths: Record<string, object> = {
  '/api/profiles': {
    get: operation('列出配置'),
    post: {
      ...operation(
        '创建最小配置、导入 YAML 或显式选择示例',
        ref('ProfileCreate')
      ),
      responses: { '201': { description: '已创建，返回脱敏快照' }, ...errors }
    }
  },
  '/api/profiles/{profileId}': {
    parameters: [id],
    get: operation('读取配置元数据'),
    put: operation('重命名或切换活动配置', {
      type: 'object',
      properties: { name, active: { type: 'boolean' } }
    }),
    delete: operation('删除非活动配置')
  },
  '/api/profiles/{profileId}/snapshot': {
    parameters: [id],
    get: operation('读取资源快照与检查结果；代理源 URL 和 headers 不返回')
  },
  '/api/profiles/{profileId}/settings': {
    parameters: [id],
    get: operation('读取全局和 DNS 设置'),
    put: operation('保存设置并自动检查', ref('Settings'))
  },
  '/api/profiles/{profileId}/advanced': {
    parameters: [id],
    get: operation('读取扩展 YAML 区块'),
    put: operation('替换扩展区块', {
      type: 'object',
      required: ['sections'],
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'value'],
            properties: { key: { type: 'string' }, value: {} }
          }
        }
      }
    })
  },
  '/api/profiles/{profileId}/import': {
    parameters: [id],
    post: operation('导入完整 YAML；同名 provider 的占位 URL 保留已有来源', {
      type: 'object',
      required: ['yaml'],
      properties: { yaml: { type: 'string' } }
    })
  },
  '/api/profiles/{profileId}/validate': {
    parameters: [id],
    get: operation('结构、引用、平台与有限范围覆盖分析', ref('Diagnostics'))
  },
  '/api/profiles/{profileId}/relationships': {
    parameters: [id],
    get: operation('读取从实际配置引用生成的资源节点和关系，包含缺失引用标记')
  },
  '/api/profiles/{profileId}/simulate': {
    parameters: [id],
    post: operation(
      '静态解释首条可确定的候选匹配；远程与脚本等标为不确定',
      ref('MatchInput')
    )
  },
  '/api/profiles/{profileId}/delivery': {
    parameters: [id],
    get: operation(
      '读取 Stash 与 Shadowrocket 的交付状态、最近成功版本及链接',
      undefined,
      { allOf: [ref('Delivery'), { type: 'object', properties: {
        shadowrocket: ref('ShadowrocketDelivery'),
        targets: { type: 'object', additionalProperties: ref('ShadowrocketDelivery') }
      } }] }
    )
  },
  '/api/profiles/{profileId}/config_download': {
    parameters: [id],
    get: {
      summary: '下载最近成功的完整 YAML，无请求体和查询参数',
      responses: {
        '200': {
          description:
            'YAML 附件，含私人来源地址；X-Config-Revision 表示实际下载版本',
          content: { 'application/yaml': { schema: { type: 'string' } } }
        },
        ...errors
      }
    }
  },
  '/api/profiles/{profileId}/bundle': {
    parameters: [id],
    get: {
      summary:
        '下载 config.yaml、manifest.json、diagnostics.json 和 README.txt；不会抓取或包含远程依赖',
      responses: {
        '200': {
          description: '私人交付包，不是离线资源包',
          content: {
            'application/zip': { schema: { type: 'string', format: 'binary' } }
          }
        },
        ...errors
      }
    }
  },
  '/api/profiles/{profileId}/download-link': {
    parameters: [id],
    post: operation(
      '生成或轮换设备下载令牌；旧链接立即失效',
      undefined,
      ref('Delivery')
    ),
    delete: operation('撤销设备下载链接')
  },
  '/api/config_download/{token}/config.yaml': {
    parameters: [configToken],
    get: {
      security: [],
      summary: '通过独立下载令牌读取最近成功版本，只读；不授予管理权限',
      responses: {
        '200': {
          description: '含 #SUBSCRIBED 的完整 YAML',
          content: { 'application/yaml': { schema: { type: 'string' } } }
        },
        '404': { description: '链接不存在或已撤销' },
        '409': { description: '尚无成功版本' }
      }
    }
  },
  '/api/profiles/{profileId}/shadowrocket/config_download': {
    parameters: [id],
    get: {
      summary: '刷新已配置的远程来源并下载 Shadowrocket .conf，无查询参数',
      responses: { '200': shadowrocketFile, ...errors }
    }
  },
  '/api/profiles/{profileId}/shadowrocket/download-link': {
    parameters: [id],
    post: operation('首次生成 .conf 并创建链接，或轮换已有 Shadowrocket 更新链接', undefined, ref('ShadowrocketDelivery')),
    delete: {
      summary: '撤销 Shadowrocket 更新链接',
      responses: { '204': { description: '已撤销' }, ...errors }
    }
  },
  '/api/config_download/{token}/config.conf': {
    parameters: [configToken],
    get: {
      security: [],
      summary: '以 Shadowrocket 独立令牌刷新来源并读取 .conf；失败时保留最近成功的文件',
      responses: { '200': shadowrocketFile, '400': errors['400'], '404': errors['404'], '409': errors['409'] }
    }
  },
  '/api/profiles/{profileId}/rules/order': {
    parameters: [id],
    put: operation('提交全部规则 ID 的顺序，MATCH 必须在最后', {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, uniqueItems: true }
      }
    })
  },
  '/api/profiles/{profileId}/revisions': {
    parameters: [id],
    get: {
      ...operation('历史修订分页'),
      parameters: [
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        },
        { name: 'before', in: 'query', schema: { type: 'integer', minimum: 1 } }
      ]
    }
  },
  '/api/profiles/{profileId}/revisions/{revision}/restore': {
    parameters: [
      id,
      {
        name: 'revision',
        in: 'path',
        required: true,
        schema: { type: 'integer' }
      }
    ],
    post: operation('恢复修订并自动检查，成功后更新下载版本')
  },
  '/api/health': { get: { ...operation('服务健康状态'), security: [] } },
  '/api/meta': {
    get: { ...operation('可用规则类型和策略组类型'), security: [] }
  }
};
for (const [resource, schema] of Object.entries({
  proxies: 'Proxy',
  'proxy-providers': 'ProxyProvider',
  'proxy-groups': 'ProxyGroup',
  'rule-providers': 'RuleProvider',
  rules: 'Rule',
  hosts: 'Host'
})) {
  paths[`/api/profiles/{profileId}/${resource}`] = {
    parameters: [id],
    get: operation(`列出 ${resource}`),
    post: {
      ...operation(`创建 ${resource} 并自动检查`, ref(schema)),
      responses: { '201': { description: '已创建' }, ...errors }
    }
  };
  paths[`/api/profiles/{profileId}/${resource}/{itemId}`] = {
    parameters: [
      id,
      {
        name: 'itemId',
        in: 'path',
        required: true,
        schema: { type: 'integer' }
      }
    ],
    get: operation('读取资源'),
    put: operation('保存资源；未提供的 provider 私人凭据保留', ref(schema)),
    delete: operation('删除资源；仍有引用时返回 409')
  };
}
paths['/api/profiles/{profileId}/rule-providers/{providerId}/entries'] = {
  parameters: [
    id,
    {
      name: 'providerId',
      in: 'path',
      required: true,
      schema: { type: 'integer' }
    }
  ],
  get: operation('列出 inline 条目'),
  post: operation('新增 inline 条目', ref('Entry'))
};
paths[
  '/api/profiles/{profileId}/rule-providers/{providerId}/entries/{entryId}'
] = {
  parameters: [
    id,
    ...['providerId', 'entryId'].map((n) => ({
      name: n,
      in: 'path',
      required: true,
      schema: { type: 'integer' }
    }))
  ],
  put: operation('修改或移动 inline 条目', ref('Entry')),
  delete: operation('删除 inline 条目')
};
paths['/api/profiles/{profileId}/import-preview'] = {
  parameters: [id], post: operation('只读预览规范化导入的脱敏语义变化', { type: 'object', required: ['yaml'], properties: { yaml: { type: 'string' } } })
};
paths['/api/profiles/{profileId}/revisions/{revision}/compare'] = {
  parameters: [id, { name: 'revision', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
  get: operation('比较当前配置与历史版本；只返回脱敏变化摘要')
};
paths['/api/profiles/{profileId}/rules/batch'] = {
  parameters: [id], put: operation('批量修改策略、启停或有序移动规则；单事务单版本', {
    type: 'object', required: ['ids'], properties: {
      ids: { type: 'array', minItems: 1, maxItems: 10000, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      policy: { type: 'string' }, enabled: { type: 'boolean' }, move: { enum: ['top', 'bottom', 'up', 'down'] }
    }
  })
};
for (const [path, value] of Object.entries(paths)) {
  if (!path.startsWith('/api/profiles/{profileId}') || ['/simulate', '/download-link', '/import-preview'].some((suffix) => path.endsWith(suffix))) continue;
  for (const [method, operation] of Object.entries(value as Record<string, unknown>)) {
    if (!['put', 'post', 'delete', 'patch'].includes(method) || !operation || typeof operation !== 'object') continue;
    Object.assign(operation, { parameters: [{ name: 'If-Match', in: 'header', required: true, description: '编辑基线版本的强 ETag，从 snapshot 响应读取；冲突返回409且不写入', schema: { type: 'string', example: '"12"' } }] });
  }
}
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Stash 配置管理 API',
    version: SERVICE_VERSION,
    description:
      '保存配置后自动检查，成功版本更新 YAML 下载；有错误时仍保存草稿并保留上次成功版本。私人订阅 URL 绑定到各 provider，加密保存，普通响应不返回。配置写入必须携带基线 If-Match，缺失428，过期409。导入/恢复前可读取脱敏变化预览。旧 /api?url= 和导出时模板过滤已移除。'
  },
  security: [{ BearerAuth: [] }, { AdminToken: [] }],
  paths,
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer' },
      AdminToken: { type: 'apiKey', in: 'header', name: 'X-Admin-Token' }
    },
    schemas: {
      Delivery: {
        type: 'object',
        properties: {
          currentRevision: { type: 'integer' },
          compiledRevision: { type: ['integer', 'null'] },
          current: { type: 'boolean' },
          generatedAt: { type: ['string', 'null'] },
          configDownloadUrl: { type: 'string', format: 'uri' },
          subscriptionUrl: {
            type: ['string', 'null'],
            description: '完整设备订阅链接，未启用时为 null'
          },
          subscriptionPath: { type: ['string', 'null'] }
        }
      },
      ShadowrocketDelivery: {
        allOf: [ref('Delivery'), {
          type: 'object',
          properties: {
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  severity: { enum: ['error', 'warning', 'info'] },
                  code: { type: 'string' },
                  message: { type: 'string' },
                  resource: { type: 'string' },
                  resourceId: { type: 'integer' }
                }
              }
            },
            remoteSources: { type: 'boolean', description: '下载时会尝试刷新配置引用的远程来源' }
          }
        }]
      },
      ProfileCreate: {
        type: 'object',
        required: ['name'],
        properties: {
          name,
          importYaml: { type: 'string', description: '可选完整 YAML' },
          example: { type: 'boolean', default: false }
        }
      },
      Settings: {
        type: 'object',
        required: ['mode', 'logLevel', 'settings'],
        properties: {
          mode: { enum: ['rule', 'global', 'direct'] },
          logLevel: { enum: ['silent', 'info', 'warning', 'error', 'debug'] },
          ipv6: { type: ['boolean', 'null'] },
          targetPlatform: { enum: ['any', 'ios', 'tvos', 'macos'] },
          settings: object
        }
      },
      Proxy: {
        type: 'object',
        required: ['name', 'type'],
        properties: { name, type: { type: 'string' }, config: object }
      },
      ProxyProvider: {
        type: 'object',
        required: ['name'],
        properties: {
          name,
          sourceType: { enum: ['remote', 'local'] },
          sourceUrl: {
            type: 'string',
            format: 'uri',
            writeOnly: true,
            description:
              'HTTP/HTTPS 私人 URL，绑定本 provider；留空字段应省略以保留现有值'
          },
          sourceHeaders: { ...object, writeOnly: true },
          clearSource: { type: 'boolean', description: '明确清除 URL' },
          clearHeaders: { type: 'boolean' },
          config: {
            ...object,
            description:
              '缓存 path、interval、filter 等。URL/headers 不在普通响应中返回。'
          }
        }
      },
      ProxyGroup: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name,
          type: {
            enum: ['select', 'url-test', 'fallback', 'load-balance', 'relay']
          },
          config: {
            ...object,
            description:
              'proxies 为有序成员名列表；use 为 provider 名列表；filter 为节点筛选条件'
          }
        }
      },
      RuleProvider: {
        type: 'object',
        required: ['name', 'behavior', 'providerType'],
        properties: {
          name,
          displayName: { type: 'string', maxLength: 160 },
          behavior: { enum: ['domain', 'ipcidr', 'classical'] },
          providerType: { enum: ['inline', 'remote', 'local'] },
          sourceUrl: { type: 'string', format: 'uri', writeOnly: true },
          sourceHeaders: { ...object, writeOnly: true },
          clearSource: { type: 'boolean' }, clearHeaders: { type: 'boolean' },
          sourceConfigured: { type: 'boolean', readOnly: true }, headersConfigured: { type: 'boolean', readOnly: true },
          config: { ...object, description: '来源类型必须与字段一致；普通响应不含 URL/headers。inline 不能包含远程或文件参数。' },
          entries: { type: 'array', items: { type: 'string' } }
        }
      },
      Rule: {
        type: 'object',
        required: ['type', 'policy'],
        properties: {
          type: { type: 'string' },
          payload: { type: 'string' },
          policy: { type: 'string' },
          options: {
            type: 'array',
            items: { enum: ['no-resolve', 'no-track', 'pre-matching'] }
          },
          priority: { type: 'integer', minimum: 1 },
          enabled: { type: 'boolean', default: true },
          note: { type: 'string' }
        }
      },
      Host: {
        type: 'object',
        required: ['pattern', 'value'],
        properties: { pattern: { type: 'string' }, value: { type: 'string' } }
      },
      Entry: {
        type: 'object',
        required: ['value'],
        properties: {
          value: { type: 'string' },
          position: { type: 'integer', minimum: 1 }
        }
      },
      MatchInput: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          ip: { type: 'string' },
          network: { enum: ['tcp', 'udp'] },
          protocol: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          process: { type: 'string' }
        }
      },
      Diagnostics: {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { enum: ['error', 'warning', 'info'] },
                code: { type: 'string' },
                message: { type: 'string' },
                resource: { type: 'string' },
                resourceId: { type: 'integer' }
              }
            }
          }
        }
      },
      Error: {
        type: 'object',
        properties: {
          detail: { type: 'string' },
          code: { type: 'string' }, currentRevision: { type: 'integer' }, expectedRevision: { type: 'integer' },
          issues: { type: 'array', items: object }
        }
      }
    }
  }
};
