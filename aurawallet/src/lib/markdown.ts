import { marked, type Tokens } from 'marked';

export const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

interface RenderMarkdownToHtmlOptions {
  rewriteLinkHref?: (href: string) => string | null;
  preserveSingleLineBreaks?: boolean;
  decodeEscapedNewlines?: boolean;
}

const isExternalHttpHref = (href: string): boolean => /^https?:\/\//i.test(href);

export const renderMarkdownToHtml = (
  content: string,
  options: RenderMarkdownToHtmlOptions = {},
): string => {
  const renderer = new marked.Renderer();
  const defaultLinkRenderer = renderer.link;
  const normalizedContent = options.decodeEscapedNewlines ? content.replace(/\\n/g, '\n') : content;

  renderer.heading = ({ text, depth }) => {
    const id = slugify(text.replace(/<[^>]*>/g, ''));
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };

  renderer.link = function link(token: Tokens.Link): string {
    const rewrittenHref = options.rewriteLinkHref?.(token.href) ?? token.href;
    const linkHtml = defaultLinkRenderer.call(this, { ...token, href: rewrittenHref });
    if (!isExternalHttpHref(rewrittenHref)) return linkHtml;
    return linkHtml.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
  };

  return marked.parse(normalizedContent, {
    async: false,
    renderer,
    breaks: options.preserveSingleLineBreaks ?? false,
  }) as string;
};
