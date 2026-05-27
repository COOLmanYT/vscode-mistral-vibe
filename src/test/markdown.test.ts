import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Test the markdown rendering function

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/g, '&#10;');
}

function markdownWithLists(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | undefined;
  let codeFence: { language?: string; lines: string[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    output.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) {
      return;
    }
    output.push(`</${listType}>`);
    listType = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine;

    if (codeFence) {
      if (/^```/.test(line)) {
        const className = codeFence.language ? ` class="language-${escapeAttr(codeFence.language)}"` : '';
        output.push(`<pre><code${className}>${escapeHtml(codeFence.lines.join('\n'))}</code></pre>`);
        codeFence = undefined;
      } else {
        codeFence.lines.push(line);
      }
      continue;
    }

    const fenceStart = line.match(/^```([a-zA-Z0-9_./\\-]+)?\s*$/);
    if (fenceStart) {
      flushParagraph();
      closeList();
      codeFence = { language: fenceStart[1], lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = line.match(/^>\s+(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.*)$/);
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextListType = unordered ? 'ul' : 'ol';
      if (listType && listType !== nextListType) {
        closeList();
      }
      if (!listType) {
        listType = nextListType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderInline((unordered ?? ordered)![1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  flushParagraph();
  closeList();

  if (codeFence) {
    const className = codeFence.language ? ` class="language-${escapeAttr(codeFence.language)}"` : '';
    output.push(`<pre><code${className}>${escapeHtml(codeFence.lines.join('\n'))}</code></pre>`);
  }

  return output.join('');
}

function renderInline(value: string): string {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

describe('markdown rendering', () => {
  it('should render simple text as paragraph', () => {
    const result = markdownWithLists('Hello world');
    assert(result.includes('<p>'));
    assert(result.includes('Hello world'));
    assert(result.includes('</p>'));
  });

  it('should render code blocks', () => {
    const result = markdownWithLists('```javascript\nconst x = 1;\n```');
    assert(result.includes('<pre><code class="language-javascript">'));
    assert(result.includes('const x = 1;'));
    assert(result.includes('</code></pre>'));
  });

  it('should render code blocks without language', () => {
    const result = markdownWithLists('```\nconst x = 1;\n```');
    assert(result.includes('<pre><code>'));
    assert(result.includes('const x = 1;'));
    assert(result.includes('</code></pre>'));
  });

  it('should render headings', () => {
    assert(markdownWithLists('# Heading 1').includes('<h1>Heading 1</h1>'));
    assert(markdownWithLists('## Heading 2').includes('<h2>Heading 2</h2>'));
    assert(markdownWithLists('### Heading 3').includes('<h3>Heading 3</h3>'));
  });

  it('should render blockquotes', () => {
    const result = markdownWithLists('> This is a quote');
    assert(result.includes('<blockquote>This is a quote</blockquote>'));
  });

  it('should render unordered lists', () => {
    const result = markdownWithLists('- Item 1\n- Item 2\n- Item 3');
    assert(result.includes('<ul>'));
    assert(result.includes('<li>Item 1</li>'));
    assert(result.includes('<li>Item 2</li>'));
    assert(result.includes('<li>Item 3</li>'));
    assert(result.includes('</ul>'));
    // Should not have standalone <li> tags
    assert(!result.match(/<li>[^<]*<\/li>/g)?.length || result.match(/<li>[^<]*<\/li>/g)?.length === 3);
  });

  it('should render ordered lists', () => {
    const result = markdownWithLists('1. First\n2. Second\n3. Third');
    assert(result.includes('<ol>'));
    assert(result.includes('<li>First</li>'));
    assert(result.includes('<li>Second</li>'));
    assert(result.includes('<li>Third</li>'));
    assert(result.includes('</ol>'));
  });

  it('should render mixed lists', () => {
    const result = markdownWithLists('- Item 1\n- Item 2\n1. Number 1\n2. Number 2');
    assert(result.includes('<ul>'));
    assert(result.includes('<ol>'));
    assert(result.includes('</ul>'));
    assert(result.includes('</ol>'));
  });

  it('should render inline formatting', () => {
    const result = markdownWithLists('This is **bold** and this is *italic* and this is `code`.');
    assert(result.includes('<strong>bold</strong>'));
    assert(result.includes('<em>italic</em>'));
    assert(result.includes('<code>code</code>'));
  });

  it('should handle code with special characters in inline code', () => {
    const result = markdownWithLists('Use `npm install` to install.');
    assert(result.includes('<code>npm install</code>'));
  });

  it('should handle multiple paragraphs', () => {
    const result = markdownWithLists('First paragraph.\n\nSecond paragraph.');
    assert(result.includes('<p>First paragraph.</p>'));
    assert(result.includes('<p>Second paragraph.</p>'));
  });

  it('should handle lists with multiple lines', () => {
    const result = markdownWithLists('Text before\n\n- Item 1\n- Item 2\n\nText after');
    assert(result.includes('<p>Text before</p>'));
    assert(result.includes('<ul>'));
    assert(result.includes('<li>Item 1</li>'));
    assert(result.includes('<li>Item 2</li>'));
    assert(result.includes('</ul>'));
    assert(result.includes('<p>Text after</p>'));
  });

  it('should escape HTML in content', () => {
    const result = markdownWithLists('<script>alert("xss")</script>');
    assert(result.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
    assert(!result.includes('<script>'));
  });

  it('should handle asterisks in code blocks', () => {
    const result = markdownWithLists('```\n* not bold\n```');
    assert(result.includes('* not bold'));
    assert(!result.includes('<em>not bold</em>'));
  });
});
