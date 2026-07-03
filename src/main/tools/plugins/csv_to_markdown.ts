import type { ToolPlugin, ToolContext, ToolResult } from '../types';

interface CsvToMarkdownInput {
  csv: string;
}

function isCsvToMarkdownInput(value: unknown): value is CsvToMarkdownInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as { csv?: unknown };
  return typeof v.csv === 'string';
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let currentField = '';
  let currentRow: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    currentRow.push(currentField);
    currentField = '';
  };

  const pushRow = () => {
    pushField();
    rows.push(currentRow);
    currentRow = [];
  };

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];

    if (char === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        currentField += '"'; // RFC4180: 引用符内の "" はリテラルの "
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      pushField();
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && csv[i + 1] === '\n') i += 1; // CRLF は1行区切りとして扱う
      pushRow();
    } else {
      currentField += char;
    }
  }

  // 末尾に行区切りが無い場合の最終行を取りこぼさない
  if (currentField.length > 0 || currentRow.length > 0) {
    pushField();
    rows.push(currentRow);
  }

  return rows;
}

function toMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) {
    return '';
  }

  const header = rows[0] ?? [];
  const body = rows.slice(1);

  // セル内の | はエスケープしないと表の列区切りとして誤解釈される
  const escapeCell = (cell: string): string => cell.replace(/\|/g, '\\|');

  const headerLine = `| ${header.map((cell) => escapeCell(cell.trim())).join(' | ')} |`;
  const separatorLine = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyLines = body.map((row) => {
    const cells = row.map((cell) => escapeCell(cell.trim()));
    return `| ${cells.join(' | ')} |`;
  });

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

export default {
  name: 'csv_to_markdown',
  description: 'Convert CSV text into a Markdown table string, using the first row as header.',
  inputSchema: {
    type: 'object',
    properties: {
      csv: { type: 'string', description: 'CSV text to convert. First row is treated as header.' },
    },
    required: ['csv'],
    additionalProperties: false,
  },
  risk: 'safe',
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    if (!isCsvToMarkdownInput(input)) {
      return { content: 'Input must be an object with a string property "csv".', isError: true };
    }
    const rows = parseCsv(input.csv);
    return { content: toMarkdownTable(rows) };
  },
} satisfies ToolPlugin;
