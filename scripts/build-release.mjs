import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/runtime');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const entry of readdirSync(join(root, 'src'))) {
  if (!entry.endsWith('.ts')) continue;
  const result = ts.transpileModule(readFileSync(join(root, 'src', entry), 'utf8'), {
    fileName: entry,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      rewriteRelativeImportExtensions: true,
      erasableSyntaxOnly: true,
    },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  // Worker entry points use URL construction, which TS's import rewrite does not touch.
  const code = result.outputText.replace(/(new URL\(['"])(\.{1,2}\/[^'"]+)\.ts(['"],\s*import\.meta\.url)/g, '$1$2.js$3');
  writeFileSync(join(output, entry.replace(/\.ts$/, '.js')), code);
}
// npm excludes package-lock.json from packed packages; retain it for remote npm ci.
writeFileSync(join(output, 'dependencies.lock.json'), readFileSync(join(root, 'package-lock.json')));
console.log(`Built installable JavaScript runtime: ${resolve(output)}`);
