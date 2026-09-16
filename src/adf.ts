import type { AdfNode, Attachment } from './jira/types.js';

export function fromAdf(node: AdfNode | null | undefined, attachments: readonly Attachment[] = [], depth = 0): string {
  if (!node) return '';
  if (depth > 100) return '[ADF nesting limit reached]';
  const text = () => (node.content ?? []).map(n => fromAdf(n, attachments, depth + 1)).join('');
  switch (node.type) {
    case 'text': {
      const link = node.marks?.find(m => m.type === 'link')?.attrs?.href;
      return (node.text ?? '') + (typeof link === 'string' && link !== node.text ? ` (${link})` : '');
    }
    case 'hardBreak': return '\n';
    case 'mention': return String(node.attrs?.text ?? '[mention]');
    case 'emoji': return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard': case 'blockCard': return String(node.attrs?.url ?? '[link]');
    case 'media': case 'mediaInline': {
      // ADF normally uses a Media Services UUID, not Jira's numeric attachment ID.
      // Use the node's label; never pair media and attachment arrays by position.
      const id = typeof node.attrs?.id === 'string' ? node.attrs.id : undefined;
      const alt = typeof node.attrs?.alt === 'string' && node.attrs.alt.trim() ? node.attrs.alt : undefined;
      const filename = attachments.find(a => a.id === id)?.filename ?? alt;
      return filename ? `[attachment: ${filename}]` : id ? `[attachment: media ID ${id}; filename unavailable]` : '[attachment: filename unavailable]';
    }
    case 'rule': return '\n---\n';
    case 'listItem': return `- ${text().trim()}\n`;
    case 'tableRow': return text() + '\n';
    case 'tableCell': case 'tableHeader': return text().trim() + '\t';
    case 'paragraph': case 'heading': case 'blockquote': case 'codeBlock': return text() + '\n';
    case 'status': return String(node.attrs?.text ?? '');
    default: return text();
  }
}

export function toAdf(text: string): AdfNode {
  return { type: 'doc', version: 1, content: text.replace(/\r\n?/g, '\n').split('\n').map(line => ({
    type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
  })) };
}
