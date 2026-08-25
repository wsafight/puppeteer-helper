#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { createRenderer, installCompatibleChrome } from '../dist/index.js';

const HELP = `pptr-helper JSON CLI

Usage:
  pptr-helper --input request.json
  pptr-helper < request.json

Actions: image, pdf, extract, batch, install-browser
The command writes one JSON result to stdout and errors to stderr.
`;

const parseArguments = async () => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return undefined;
  }

  const inputIndex = args.indexOf('--input');
  if (inputIndex >= 0) {
    const path = args[inputIndex + 1];
    if (!path) {
      throw new Error('--input requires a JSON file path');
    }
    return JSON.parse(await readFile(path, 'utf8'));
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (!input) {
    throw new Error('Provide a JSON request through --input or stdin');
  }
  return JSON.parse(input);
};

const serializeError = (error, depth = 0) => ({
  name: error instanceof Error ? error.name : 'Error',
  message: error instanceof Error ? error.message : String(error),
  ...(error && typeof error === 'object' && 'code' in error
    ? { code: error.code }
    : {}),
  ...(depth < 3 && error instanceof Error && error.cause !== undefined
    ? { cause: serializeError(error.cause, depth + 1) }
    : {}),
});

const getOutputPath = task =>
  typeof task?.output?.path === 'string' ? task.output.path : undefined;

const serializeResult = (result, action, task) => {
  const outputPath = getOutputPath(task);
  if (action === 'extract') {
    return { data: result.data, metadata: result.metadata };
  }
  if (outputPath) {
    return { outputPath, metadata: result.metadata };
  }
  const base64 =
    typeof result.data === 'string'
      ? result.data
      : Buffer.from(result.data).toString('base64');
  return { base64, metadata: result.metadata };
};

const createExtractor = fields => {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('extract requires a fields object');
  }

  return page =>
    page.evaluate(fieldDefinitions => {
      const readElement = (element, definition) => {
        if (definition.attribute) {
          return element.getAttribute(definition.attribute);
        }
        switch (definition.property) {
          case 'html':
            return element.innerHTML;
          case 'value':
            return 'value' in element ? element.value : null;
          case 'text':
          case undefined:
            return element.textContent?.trim() ?? '';
          default:
            throw new Error(
              `Unsupported extraction property: ${definition.property}`,
            );
        }
      };

      return Object.fromEntries(
        Object.entries(fieldDefinitions).map(([name, definition]) => {
          if (definition.page === 'title') {
            return [name, document.title];
          }
          if (definition.page === 'url') {
            return [name, location.href];
          }
          if (typeof definition.selector !== 'string') {
            throw new Error(`Field ${name} requires selector or page`);
          }
          if (definition.all) {
            return [
              name,
              Array.from(
                document.querySelectorAll(definition.selector),
                element => readElement(element, definition),
              ),
            ];
          }
          const element = document.querySelector(definition.selector);
          return [name, element ? readElement(element, definition) : null];
        }),
      );
    }, fields);
};

const toBatchTask = item => {
  const type = item.action === 'extract' ? 'evaluate' : item.action;
  if (!['image', 'pdf', 'evaluate'].includes(type)) {
    throw new Error(`Unsupported batch action: ${item.action}`);
  }
  return {
    id: item.id,
    type,
    options:
      type === 'evaluate'
        ? { ...item.task, evaluate: createExtractor(item.fields) }
        : item.task,
  };
};

const executeRequest = async request => {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('The CLI request must be a JSON object');
  }
  if (request.action === 'install-browser') {
    return installCompatibleChrome(request.browser);
  }

  const events = [];
  const renderer = createRenderer({
    ...request.renderer,
    ...(request.includeEvents
      ? { onEvent: event => events.push({ ...event, error: undefined }) }
      : {}),
  });

  try {
    let result;
    switch (request.action) {
      case 'image':
        result = serializeResult(
          await renderer.imageResult(request.task),
          request.action,
          request.task,
        );
        break;
      case 'pdf':
        result = serializeResult(
          await renderer.pdfResult(request.task),
          request.action,
          request.task,
        );
        break;
      case 'extract':
        result = serializeResult(
          await renderer.evaluateResult({
            ...request.task,
            evaluate: createExtractor(request.fields),
          }),
          request.action,
          request.task,
        );
        break;
      case 'batch': {
        if (!Array.isArray(request.tasks)) {
          throw new Error('batch requires a tasks array');
        }
        const batch = await renderer.batch(request.tasks.map(toBatchTask), {
          concurrency: request.concurrency,
        });
        result = batch.map((item, index) => {
          if (item.status === 'rejected') {
            return { ...item, error: serializeError(item.error) };
          }
          const source = request.tasks[index];
          return {
            id: item.id,
            index,
            status: item.status,
            result: serializeResult(item.result, source.action, source.task),
          };
        });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${request.action}`);
    }
    return request.includeEvents ? { result, events } : result;
  } finally {
    await renderer.close();
  }
};

try {
  const request = await parseArguments();
  if (request !== undefined) {
    process.stdout.write(`${JSON.stringify(await executeRequest(request))}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: serializeError(error) })}\n`);
  process.exitCode = 1;
}
