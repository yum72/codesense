import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Creates an AST parser using web-tree-sitter.
 * @returns {Promise<Object>} AST Parser API
 */
export async function createASTParser() {
  await Parser.init();
  const parser = new Parser();

  const tsWasmPath = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
  const tsxWasmPath = require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm');
  const jsWasmPath = require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm');

  const languages = {
    typescript: await Language.load(tsWasmPath),
    tsx: await Language.load(tsxWasmPath),
    javascript: await Language.load(jsWasmPath)
  };

  /**
   * Gets the appropriate language for a file.
   * @param {string} filePath 
   * @returns {Object} Tree-sitter language
   * @private
   */
  const _getLanguage = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.ts': return languages.typescript;
      case '.tsx': return languages.tsx;
      case '.js':
      case '.mjs':
      case '.cjs': return languages.javascript;
      case '.jsx': return languages.tsx;
      default: return languages.javascript;
    }
  };

  /**
   * Parses a file and extracts definitions and imports.
   * @param {string} filePath - Absolute path to file
   * @param {string} content - File content
   * @returns {Object} Parsed data { definitions, imports, calls }
   */
  const parseFile = (filePath, content) => {
    const lang = _getLanguage(filePath);
    parser.setLanguage(lang);
    const tree = parser.parse(content);

    const definitions = [];
    const imports = [];
    const calls = [];

    /**
     * Traverses the AST.
     * @param {Object} node 
     */
    const traverse = (node) => {
      // Extract definitions (functions, classes, variables)
      if (node.type === 'function_declaration' || node.type === 'method_definition' || node.type === 'class_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            type: node.type === 'class_declaration' ? 'class' : 
                  node.type === 'function_declaration' ? 'function' : 'method',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            exported: node.parent && node.parent.type === 'export_statement'
          });
        }
      }

      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        const isExported = node.parent && node.parent.type === 'export_statement';
        // Iterate through declarators
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child.type === 'variable_declarator') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
              definitions.push({
                name: nameNode.text,
                type: 'const',
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                exported: isExported
              });
            }
          }
        }
      }

      // Extract imports
      if (node.type === 'import_statement') {
        const sourceNode = node.childForFieldName('source') || node.children.find(c => c.type === 'string');
        if (sourceNode) {
          imports.push({
            source: sourceNode.text.replace(/['"]/g, ''),
            line: node.startPosition.row + 1
          });
        }
      }

      // Extract calls
      if (node.type === 'call_expression') {

        const functionNode = node.childForFieldName('function');
        if (functionNode) {
          calls.push({
            name: functionNode.text,
            line: node.startPosition.row + 1
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        traverse(node.child(i));
      }
    };

    traverse(tree.rootNode);

    return { definitions, imports, calls };
  };

  return { parseFile };
}
