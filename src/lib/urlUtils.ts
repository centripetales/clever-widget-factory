/**
 * Utility functions for generating URLs in the application
 */

/**
 * Generate a shareable URL for an action
 * @param actionId - The ID of the action
 * @param baseUrl - Optional base URL, defaults to window.location.origin
 * @returns The full URL to the action
 */
export function generateActionUrl(actionId: string, baseUrl?: string): string {
  const base = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/actions/${actionId}`;
}

/**
 * Generate a shareable URL for a mission
 * @param missionId - The ID of the mission
 * @param baseUrl - Optional base URL, defaults to window.location.origin
 * @returns The full URL to the mission
 */
export function generateMissionUrl(missionId: string, baseUrl?: string): string {
  const base = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/missions/${missionId}/edit`;
}

/**
 * Generate a shareable URL for an issue
 * @param issueId - The ID of the issue
 * @param baseUrl - Optional base URL, defaults to window.location.origin
 * @returns The full URL to the issue
 */
export function generateIssueUrl(issueId: string, baseUrl?: string): string {
  const base = baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/issues/${issueId}`;
}

/**
 * Copy text to clipboard with error handling
 * @param text - The text to copy
 * @returns Promise that resolves to true if successful, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Try Clipboard API first — works on HTTPS and localhost (even when
  // isSecureContext is false on some mobile browsers hitting local IP)
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('Clipboard API failed, trying fallback:', err);
    }
  }

  // Fallback for older browsers — unreliable on mobile, so we
  // verify by reading back from clipboard when possible
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);

    // execCommand returns true on mobile even when it didn't actually copy,
    // so don't trust it — report failure so the user knows to copy manually
    if (!successful) return false;

    // On mobile, execCommand('copy') is unreliable — detect mobile and
    // warn rather than falsely claiming success
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      console.warn('execCommand copy on mobile is unreliable');
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    return false;
  }
}

/**
 * Convert a Maxwell conversation to rich HTML suitable for pasting into Google Docs.
 * Images embedded as Markdown ![alt](url) are converted to <img> tags so they
 * render inline when pasted into Google Docs or other rich-text editors.
 */
export function conversationToHtml(
  messages: Array<{ role: string; content: string }>
): string {
  const lines: string[] = ['<div style="font-family: Arial, sans-serif; font-size: 14px;">'];

  for (const msg of messages) {
    const label = msg.role === 'user' ? 'You' : 'Maxwell';
    const labelColor = msg.role === 'user' ? '#1a56db' : '#166534';
    lines.push(`<p><strong style="color:${labelColor}">${label}:</strong></p>`);

    // Convert Markdown to HTML (basic subset needed for Maxwell responses)
    let html = msg.content
      // Images — must come before links to avoid double-processing
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) =>
        `<img src="${url}" alt="${alt}" style="max-width:100%;margin:8px 0;display:block;" />`
      )
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:2px 4px;border-radius:3px;">$1</code>')
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Unordered list items
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      // Ordered list items
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      // Blockquotes
      .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid #d1d5db;padding-left:8px;color:#6b7280;">$1</blockquote>')
      // Horizontal rules
      .replace(/^---$/gm, '<hr/>')
      // Paragraphs — double newlines become paragraph breaks
      .replace(/\n\n/g, '</p><p>')
      // Single newlines become line breaks
      .replace(/\n/g, '<br/>');

    lines.push(`<p>${html}</p>`);
    lines.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;"/>');
  }

  lines.push('</div>');
  return lines.join('\n');
}

/**
 * Copy a Maxwell conversation to the clipboard as both rich HTML and plain text.
 * Rich HTML allows images to render when pasting into Google Docs.
 * Falls back to plain text if ClipboardItem is not supported.
 */
export async function copyConversationRich(
  messages: Array<{ role: string; content: string }>
): Promise<boolean> {
  const plainText = messages
    .map(m => `${m.role === 'user' ? 'You' : 'Maxwell'}: ${m.content}`)
    .join('\n\n');

  const html = conversationToHtml(messages);

  // Use ClipboardItem for rich copy (requires HTTPS or localhost)
  if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ]);
      return true;
    } catch (err) {
      console.warn('Rich clipboard copy failed, falling back to plain text:', err);
    }
  }

  // Fallback to plain text
  return copyToClipboard(plainText);
}
