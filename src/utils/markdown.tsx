import type { ReactNode } from "react";

function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+(#{1,6}\s+)/g, "\n$1")
    .replace(/\s+([*-]\s+)/g, "\n$1")
    .trim();
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function renderMarkdownText(text: string): ReactNode {
  const blocks: ReactNode[] = [];
  let listItems: ReactNode[] = [];

  const flushList = () => {
    if (!listItems.length) {
      return;
    }
    blocks.push(
      <ul key={`list-${blocks.length}`} className="markdown-list">
        {listItems}
      </ul>
    );
    listItems = [];
  };

  normalizeMarkdown(text)
    .split("\n")
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        flushList();
        return;
      }

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushList();
        blocks.push(
          <h3 key={`heading-${index}`}>
            {renderInlineMarkdown(headingMatch[2])}
          </h3>
        );
        return;
      }

      const bulletMatch = trimmed.match(/^[*-]\s+(.+)$/);
      if (bulletMatch) {
        listItems.push(
          <li key={`item-${index}`}>{renderInlineMarkdown(bulletMatch[1])}</li>
        );
        return;
      }

      flushList();
      blocks.push(
        <p key={`paragraph-${index}`}>{renderInlineMarkdown(trimmed)}</p>
      );
    });

  flushList();
  return <>{blocks}</>;
}
