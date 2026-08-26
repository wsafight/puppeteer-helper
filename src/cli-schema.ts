export const CLI_REQUEST_SCHEMA = {
  $id: 'https://github.com/wsafight/pptr-helper/schema/cli-request.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    { $ref: '#/$defs/imageRequest' },
    { $ref: '#/$defs/pdfRequest' },
    { $ref: '#/$defs/extractRequest' },
    { $ref: '#/$defs/compareRequest' },
    { $ref: '#/$defs/batchRequest' },
    { $ref: '#/$defs/installBrowserRequest' },
  ],
  $defs: {
    source: {
      oneOf: [
        {
          type: 'object',
          properties: { url: { type: 'string', minLength: 1 } },
          required: ['url'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { html: { type: 'string', minLength: 1 } },
          required: ['html'],
          additionalProperties: false,
        },
      ],
    },
    task: {
      type: 'object',
      properties: {
        source: { $ref: '#/$defs/source' },
        taskId: { type: 'string', minLength: 1 },
        timeout: { type: 'integer', minimum: 0 },
      },
      required: ['source'],
      additionalProperties: true,
    },
    renderer: {
      type: 'object',
      additionalProperties: true,
    },
    field: {
      type: 'object',
      properties: {
        all: { type: 'boolean' },
        attribute: { type: 'string', minLength: 1 },
        page: { enum: ['title', 'url'] },
        property: { enum: ['html', 'text', 'value'] },
        selector: { type: 'string', minLength: 1 },
      },
      anyOf: [{ required: ['page'] }, { required: ['selector'] }],
      additionalProperties: false,
    },
    fields: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { $ref: '#/$defs/field' },
    },
    requestOptions: {
      type: 'object',
      properties: {
        includeEvents: { type: 'boolean' },
        renderer: { $ref: '#/$defs/renderer' },
      },
    },
    imageRequest: {
      type: 'object',
      properties: {
        action: { const: 'image' },
        includeEvents: { type: 'boolean' },
        renderer: { $ref: '#/$defs/renderer' },
        task: { $ref: '#/$defs/task' },
      },
      required: ['action', 'task'],
      additionalProperties: false,
    },
    pdfRequest: {
      type: 'object',
      properties: {
        action: { const: 'pdf' },
        includeEvents: { type: 'boolean' },
        renderer: { $ref: '#/$defs/renderer' },
        task: { $ref: '#/$defs/task' },
      },
      required: ['action', 'task'],
      additionalProperties: false,
    },
    extractRequest: {
      type: 'object',
      properties: {
        action: { const: 'extract' },
        fields: { $ref: '#/$defs/fields' },
        includeEvents: { type: 'boolean' },
        renderer: { $ref: '#/$defs/renderer' },
        task: { $ref: '#/$defs/task' },
      },
      required: ['action', 'fields', 'task'],
      additionalProperties: false,
    },
    compareTask: {
      allOf: [
        { $ref: '#/$defs/task' },
        {
          type: 'object',
          properties: { baseline: { type: 'string', minLength: 1 } },
          required: ['baseline'],
        },
      ],
    },
    compareRequest: {
      type: 'object',
      properties: {
        action: { const: 'compare' },
        includeEvents: { type: 'boolean' },
        renderer: { $ref: '#/$defs/renderer' },
        task: { $ref: '#/$defs/compareTask' },
      },
      required: ['action', 'task'],
      additionalProperties: false,
    },
    batchItem: {
      oneOf: [
        {
          type: 'object',
          properties: {
            action: { enum: ['image', 'pdf'] },
            id: { type: 'string' },
            task: { $ref: '#/$defs/task' },
          },
          required: ['action', 'task'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'extract' },
            fields: { $ref: '#/$defs/fields' },
            id: { type: 'string' },
            task: { $ref: '#/$defs/task' },
          },
          required: ['action', 'fields', 'task'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'compare' },
            id: { type: 'string' },
            task: { $ref: '#/$defs/compareTask' },
          },
          required: ['action', 'task'],
          additionalProperties: false,
        },
      ],
    },
    batchRequest: {
      type: 'object',
      properties: {
        action: { const: 'batch' },
        concurrency: { type: 'integer', minimum: 1 },
        includeEvents: { type: 'boolean' },
        renderer: { $ref: '#/$defs/renderer' },
        tasks: {
          type: 'array',
          items: { $ref: '#/$defs/batchItem' },
        },
      },
      required: ['action', 'tasks'],
      additionalProperties: false,
    },
    installBrowserRequest: {
      type: 'object',
      properties: {
        action: { const: 'install-browser' },
        browser: { type: 'object', additionalProperties: true },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
} as const;
