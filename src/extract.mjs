import crypto from 'node:crypto';
import { htmlToMarkdown, normalizeProblemMarkdown } from './markdown.mjs';

export function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

export function dedupeSubmissions(items) {
  const map = new Map();
  for (const item of items) {
    if (!item?.code) continue;
    const key = item.submissionId || `${item.attempt || ''}:${sha1(item.code)}`;
    const previous = map.get(key) || {};
    map.set(key, { ...previous, ...item });
  }
  return [...map.values()];
}

export async function extractProblem(page) {
  const raw = await page.evaluate(() => {
    const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
    const bodyText = document.body?.innerText || '';
    const headingCandidates = [...document.querySelectorAll('h1,h2,h3,[class*=title i]')]
      .map(node => cleanText(node.textContent))
      .filter(text => text && text.length < 160 && /^[A-Za-z]{1,10}\d+\s*[.．]/.test(text));

    const candidateSelectors = [
      '[class*=problem-content i]', '[class*=question-content i]',
      '[class*=problem-detail i]', '[class*=question-detail i]',
      '[class*=markdown i]', '.vditor-reset', 'article', 'main'
    ];
    const candidates = [...new Set(candidateSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(node => cleanText(node.innerText).length > 80)
      .sort((a, b) => cleanText(b.innerText).length - cleanText(a.innerText).length);

    const root = candidates[0] || document.querySelector('main') || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('nav,aside,footer,script,style,button,[role=navigation],[class*=breadcrumb i],[class*=menu i]').forEach(node => node.remove());
    clone.querySelectorAll('.katex').forEach(node => {
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (!annotation) return;
      const display = Boolean(node.closest('.katex-display'));
      const replacement = document.createTextNode(display ? `\n$$${annotation.textContent}$$\n` : `$${annotation.textContent}$`);
      node.replaceWith(replacement);
    });

    const limitMatch = (patterns) => {
      for (const pattern of patterns) {
        const match = bodyText.match(pattern);
        if (match) return cleanText(match[1]);
      }
      return '';
    };

    return {
      title: headingCandidates[0] || '',
      timeLimit: limitMatch([/时间限制\s*[:：]?\s*([^\n]+)/i, /Time\s*Limit\s*[:：]?\s*([^\n]+)/i]),
      memoryLimit: limitMatch([/(?:空间|内存)限制\s*[:：]?\s*([^\n]+)/i, /Memory\s*Limit\s*[:：]?\s*([^\n]+)/i]),
      html: clone.innerHTML,
      textLength: cleanText(clone.innerText).length
    };
  });

  const converted = htmlToMarkdown(raw.html, page.url());
  const normalized = normalizeProblemMarkdown(converted);
  return {
    ...raw,
    title: normalized.title || raw.title,
    difficulty: normalized.difficulty,
    url: page.url(),
    markdown: normalized.body
  };
}
