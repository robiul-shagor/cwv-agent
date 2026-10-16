import { z } from 'zod';
import { SourceError } from '../source/types.js';
import { ToolError, type Tool, type ToolContext } from './types.js';

function requireSource(ctx: ToolContext) {
  if (!ctx.source) throw new ToolError('No source code is linked to this run.');
  return ctx.source;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SourceError) throw new ToolError(err.message);
    throw err;
  }
}

const ListInput = z.object({
  path: z.string().default('.').describe('Directory relative to the project root'),
  glob: z.string().optional().describe('Filter, e.g. "*.tsx", "**/components/**", "*.{css,scss}"'),
  limit: z.number().int().min(1).max(500).default(200),
});

export const listFiles: Tool<z.infer<typeof ListInput>> = {
  name: 'list_files',
  description:
    'List files in the linked project source (dependencies, build output and secrets are excluded). ' +
    'Use first to learn the project structure (framework, components/, pages/ or app/, theme folders).',
  inputSchema: ListInput,
  async execute(input, ctx) {
    const source = requireSource(ctx);
    return wrap(async () => {
      const { files, truncated } = await source.listFiles(input.path, input.glob, input.limit);
      return { root: source.label, path: input.path, count: files.length, truncated, files };
    });
  },
};

const SearchInput = z.object({
  query: z
    .string()
    .min(2)
    .max(300)
    .describe('Text to find, e.g. a class name, id, image file name, script URL path or visible text'),
  regex: z.boolean().default(false).describe('Interpret query as a regular expression'),
  caseSensitive: z.boolean().default(false),
  path: z.string().optional().describe('Limit to a directory'),
  glob: z.string().optional().describe('Limit to files, e.g. "*.{tsx,jsx}"'),
  maxResults: z.number().int().min(1).max(100).default(40),
});

export const searchCode: Tool<z.infer<typeof SearchInput>> = {
  name: 'search_code',
  description:
    'Search the linked project source for text (ripgrep). Returns file, line and the matching line. ' +
    'Search for the most specific clue first: CSS class names / ids from the LCP or CLS selector, image or font file names, ' +
    'script/stylesheet file names from resource URLs, distinctive visible text, then framework APIs (e.g. "next/image", "loading=").',
  inputSchema: SearchInput,
  async execute(input, ctx) {
    const source = requireSource(ctx);
    return wrap(async () => {
      const { matches, truncated } = await source.search(input.query, input);
      return {
        query: input.query,
        count: matches.length,
        truncated,
        matches,
        hint:
          matches.length === 0
            ? 'No matches. Try a shorter/different token (e.g. one class name, file name without hash).'
            : undefined,
      };
    });
  },
};

const ReadInput = z.object({
  file: z
    .string()
    .min(1)
    .describe('File path relative to the project root (as returned by search_code/list_files)'),
  startLine: z.number().int().min(1).default(1),
  endLine: z.number().int().min(1).optional().describe('Inclusive; at most 300 lines are returned per call'),
});

export const readFileTool: Tool<z.infer<typeof ReadInput>> = {
  name: 'read_file',
  description:
    'Read lines of a source file (with line numbers). Read around search matches to confirm the root cause and get exact line ' +
    'numbers for findings. Secret files (.env, keys, credentials) cannot be read; secret-looking values are masked.',
  inputSchema: ReadInput,
  async execute(input, ctx) {
    const source = requireSource(ctx);
    return wrap(() => source.readFile(input.file, input.startLine, input.endLine));
  },
};

export const codeTools = [listFiles, searchCode, readFileTool];
