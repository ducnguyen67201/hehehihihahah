import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
type ChunkTypeInput = "FUNCTION" | "CLASS" | "ROUTE" | "TYPE" | "MODULE";

export interface ParsedChunk {
  chunkType: ChunkTypeInput;
  symbolName: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

// File size guard: skip files larger than 1 MB to avoid OOM on huge generated files.
const MAX_FILE_BYTES = 1_000_000;

// Lines guard: log a warning but still parse files up to 10k lines.
const MAX_LINES_WARN = 10_000;

type Language = "typescript" | "python" | "go";

function detectLanguage(filePath: string): Language | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  return null;
}

/**
 * Parse a source file into structured code chunks using tree-sitter.
 *
 * Returns an array of ParsedChunk objects with type, symbol name, line range,
 * and content. Falls back to a single MODULE chunk if tree-sitter is unavailable.
 */
export function parseFile(params: {
  filePath: string;
  repoRoot: string;
}): ParsedChunk[] | null {
  const { filePath, repoRoot } = params;
  const language = detectLanguage(filePath);
  if (!language) return null;

  const absolutePath = join(repoRoot, filePath);

  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return null;
  }

  if (stat.size > MAX_FILE_BYTES) {
    console.warn(`[parser] Skipping large file (${stat.size} bytes): ${filePath}`);
    return null;
  }

  const source = readFileSync(absolutePath, "utf-8");
  const lines = source.split("\n");

  if (lines.length > MAX_LINES_WARN) {
    console.warn(`[parser] Large file (${lines.length} lines): ${filePath}`);
  }

  try {
    return parseWithTreeSitter(source, language, lines);
  } catch (err) {
    console.warn(`[parser] tree-sitter failed for ${filePath}:`, err);
    // Fallback: return the whole file as a single MODULE chunk.
    return [
      {
        chunkType: "MODULE",
        symbolName: null,
        startLine: 1,
        endLine: lines.length,
        content: source.slice(0, 8000), // cap snippet size
      },
    ];
  }
}

function parseWithTreeSitter(
  source: string,
  language: Language,
  lines: string[],
): ParsedChunk[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Parser = require("tree-sitter") as typeof import("tree-sitter");
  const parser = new Parser();

  let grammar: unknown;
  if (language === "typescript") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsGrammar = require("tree-sitter-typescript") as {
      typescript: unknown;
      tsx: unknown;
    };
    grammar = tsGrammar.typescript;
  } else if (language === "python") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    grammar = require("tree-sitter-python");
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    grammar = require("tree-sitter-go");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parser.setLanguage(grammar as any);
  const tree = parser.parse(source);

  const chunks: ParsedChunk[] = [];
  const seenRanges = new Set<string>();

  function visit(node: import("tree-sitter").SyntaxNode): void {
    const { type, startPosition, endPosition } = node;

    const chunkType = nodeTypeToChunkType(type, language);
    if (chunkType) {
      const rangeKey = `${startPosition.row}-${endPosition.row}`;
      if (!seenRanges.has(rangeKey)) {
        seenRanges.add(rangeKey);
        const symbolName = extractSymbolName(node, language);
        const startLine = startPosition.row + 1;
        const endLine = endPosition.row + 1;
        const content = lines.slice(startPosition.row, endPosition.row + 1).join("\n");

        chunks.push({ chunkType, symbolName, startLine, endLine, content });
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(tree.rootNode);

  // If no named chunks were found, emit a single MODULE chunk for the file.
  if (chunks.length === 0) {
    chunks.push({
      chunkType: "MODULE",
      symbolName: null,
      startLine: 1,
      endLine: lines.length,
      content: source.slice(0, 8000),
    });
  }

  return chunks;
}

function nodeTypeToChunkType(
  nodeType: string,
  language: Language,
): ChunkTypeInput | null {
  if (language === "typescript") {
    if (nodeType === "function_declaration" || nodeType === "arrow_function" || nodeType === "method_definition") return "FUNCTION";
    if (nodeType === "class_declaration") return "CLASS";
    if (nodeType === "type_alias_declaration" || nodeType === "interface_declaration") return "TYPE";
  } else if (language === "python") {
    if (nodeType === "function_definition") return "FUNCTION";
    if (nodeType === "class_definition") return "CLASS";
  } else if (language === "go") {
    if (nodeType === "function_declaration" || nodeType === "method_declaration") return "FUNCTION";
    if (nodeType === "type_declaration") return "TYPE";
  }
  return null;
}

function extractSymbolName(
  node: import("tree-sitter").SyntaxNode,
  language: Language,
): string | null {
  if (language === "typescript") {
    const nameNode =
      node.childForFieldName("name") ??
      node.children.find((c) => c.type === "identifier");
    return nameNode?.text ?? null;
  } else if (language === "python") {
    const nameNode = node.childForFieldName("name");
    return nameNode?.text ?? null;
  } else if (language === "go") {
    const nameNode = node.childForFieldName("name");
    return nameNode?.text ?? null;
  }
  return null;
}

export { detectLanguage };
