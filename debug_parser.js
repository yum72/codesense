import { createASTParser } from './src/indexing/ast-parser.js';
const parser = await createASTParser();
const code = "import { a } from './utils.js';";
const res = parser.parseFile('test.js', code);
console.log(JSON.stringify(res, null, 2));
