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
    // finalize last field in row
    pushField();
    rows.push(currentRow);
    currentRow = [];
  };

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];

    if (char === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        // Escaped quote
        currentField += '"';
        i += 1; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      pushField();
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      // handle CRLF and LF
      // if CR followed by LF, skip the LF
      if (char === '\r' && csv[i + 1] === '\n') {
        i += 1;
      }
      pushRow();
    } else {
      currentField += char;
    }
  }

  // push remaining data if any
  if (inQuotes) {
    // unmatched quote - treat as literal
    // no extra handling, just let it fall through
  }
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

  const escapeCell = (cell: string): string => {
    // Escape pipe characters to avoid breaking the table structure
    return cell.replace(/\|/g, '\\|');
  };

  const headerLine = `| ${header.map((cell) => escapeCell(cell.trim())).join(' | ')} |`;
  const separatorLine = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyLines = body.map((row) => {
    const cells = row.map((cell) => escapeCell(cell.trim()));
    return `| ${cells.join(' | ')} |`;
  });

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

const plugin: ToolPlugin = {
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
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isCsvToMarkdownInput(input)) {
      return { content: 'Input must be an object with a string property "csv".', isError: true };
    }

    const rows = parseCsv(input.csv);
    const markdown = toMarkdownTable(rows);

    return { content: markdown };
  },
};

export default plugin;
