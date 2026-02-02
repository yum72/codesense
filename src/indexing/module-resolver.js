import path from 'node:path';
import fs from 'node:fs';

/**
 * Creates a module resolver.
 * @param {Object} config - Configuration
 * @param {string} config.rootPath - Project root path
 * @param {Object} [config.aliases] - Path aliases
 * @returns {Object} Module Resolver API
 */
export function createModuleResolver(config) {
  const { rootPath, aliases = {} } = config;

  /**
   * Resolves an import path to an absolute file path.
   * @param {string} sourceFile - Path of the file containing the import
   * @param {string} importPath - The import string (e.g. "./utils" or "@/core")
   * @returns {string|null} Resolved absolute path or null if external/unresolved
   */
  const resolve = (sourceFile, importPath) => {
    // Normalize sourceFile to use platform separators for path.resolve
    const normalizedSourceFile = sourceFile.split('/').join(path.sep);

    // 1. Handle aliases
    let substitutedPath = importPath;
    for (const [alias, replacement] of Object.entries(aliases)) {
      if (importPath.startsWith(alias)) {
        substitutedPath = path.join(rootPath, replacement, importPath.slice(alias.length));
        break;
      }
    }

    let absolutePath;
    if (path.isAbsolute(substitutedPath)) {
      absolutePath = substitutedPath;
    } else if (substitutedPath.startsWith('.')) {
      absolutePath = path.resolve(path.dirname(normalizedSourceFile), substitutedPath);
    } else {
      return null;
    }

    // Normalize to forward slashes for consistency with fast-glob
    absolutePath = absolutePath.split(path.sep).join('/');

    // 2. Resolve extensions and index files
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    
    // Check if it's a direct file
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      return absolutePath;
    }

    // Check with extensions
    for (const ext of extensions) {
      if (fs.existsSync(absolutePath + ext)) {
        return absolutePath + ext;
      }
    }

    // Check for index files
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
      for (const ext of extensions) {
        const indexPath = path.join(absolutePath, `index${ext}`);
        if (fs.existsSync(indexPath)) {
          return indexPath;
        }
      }
    }

    return null;
  };

  return { resolve };
}

/**
 * Parses jsconfig.json or tsconfig.json for aliases.
 * @param {string} rootPath 
 * @returns {Object} Aliases map
 */
export function parseConfigAliases(rootPath) {
  const configFiles = ['tsconfig.json', 'jsconfig.json'];
  for (const file of configFiles) {
    const configPath = path.join(rootPath, file);
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        // Simple JSON parse, might need to handle comments in tsconfig
        const json = JSON.parse(content.replace(/\/\/.*/g, '')); 
        const paths = json.compilerOptions?.paths || {};
        const aliases = {};
        for (const [key, values] of Object.entries(paths)) {
          const alias = key.replace(/\/\*$/, '');
          const replacement = values[0].replace(/\/\*$/, '');
          aliases[alias] = replacement;
        }
        return aliases;
      } catch (e) {
        // Ignore
      }
    }
  }
  return {};
}
