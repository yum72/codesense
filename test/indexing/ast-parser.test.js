import { describe, it, expect, beforeAll } from 'vitest';
import { createASTParser } from '../../src/indexing/ast-parser.js';
import { createModuleResolver } from '../../src/indexing/module-resolver.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('ASTParser', () => {
  let parser;

  beforeAll(async () => {
    parser = await createASTParser();
  });

  it('should extract definitions and imports', () => {
    const code = `
      import { foo } from './foo';
      import bar from '@/bar';

      export function main() {
        console.log('hello');
        utils.helper();
      }

      class MyClass {
        method() {}
      }
    `;

    const result = parser.parseFile('test.js', code);
    
    expect(result.definitions).toContainEqual(expect.objectContaining({ name: 'main', type: 'function' }));
    expect(result.definitions).toContainEqual(expect.objectContaining({ name: 'MyClass', type: 'class' }));
    expect(result.definitions).toContainEqual(expect.objectContaining({ name: 'method', type: 'method' }));
    
    expect(result.imports).toContainEqual(expect.objectContaining({ source: './foo' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: '@/bar' }));
    
    expect(result.calls).toContainEqual(expect.objectContaining({ name: 'console.log' }));
    expect(result.calls).toContainEqual(expect.objectContaining({ name: 'utils.helper' }));
  });
});

describe('ModuleResolver', () => {
  const rootPath = path.resolve(__dirname, '../../test/fixtures/project1');
  const resolver = createModuleResolver({
    rootPath,
    aliases: { '@': './src' }
  });

  // Normalize path separators for cross-platform compatibility
  const normalizePath = (p) => p.replace(/\\/g, '/');

  it('should resolve relative imports', () => {
    const sourceFile = path.join(rootPath, 'src/main.js');
    const resolved = resolver.resolve(sourceFile, './utils');
    expect(normalizePath(resolved)).toBe(normalizePath(path.join(rootPath, 'src/utils.js')));
  });

  it('should resolve alias imports', () => {
    const sourceFile = path.join(rootPath, 'src/main.js');
    const resolved = resolver.resolve(sourceFile, '@/utils');
    expect(normalizePath(resolved)).toBe(normalizePath(path.join(rootPath, 'src/utils.js')));
  });
});
