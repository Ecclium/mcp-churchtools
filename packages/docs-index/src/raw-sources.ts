/**
 * Recognises raw sources by their form (ADR 0027, ADR 0066). A raw source
 * is what the refresh fetches: the OpenAPI document as a whole or a help
 * page as HTML. Neither may lie in the repository or in the package, only
 * the facts taken from them. The checks look at the form, not at the
 * meaning: a document rewritten into another form passes them, which
 * only the review of every change under `data/` catches.
 *
 * @packageDocumentation
 */

// Each pattern starts at a fixed text or at the start of a line and has
// no nested quantifier, so it runs in linear time on any text.
const jsonOpenApiKey = /"(?:openapi|swagger)"\s{0,20}:/;
const jsonPathsKey = /"paths"\s{0,20}:/;
const yamlOpenApiKey = /^\uFEFF?["']?(?:openapi|swagger)["']?[ \t]{0,20}:/m;
const yamlPathsKey = /^["']?paths["']?[ \t]{0,20}:/m;
// Comments may come before the page; each is bounded, and the pattern is
// anchored at the start, so it stays linear.
const htmlStart =
  /^\uFEFF?\s{0,200}(?:<!--[\s\S]{0,2000}?-->\s{0,200}){0,10}<(?:!doctype\s{1,20}html|html|head|body)[\s>]/i;
// The answer of the WordPress API for a page holds its HTML in a field
// "rendered".
const wordPressRendered = /"rendered"\s{0,20}:\s{0,20}"/;
// A tag, a comment, a declaration such as a doctype or CDATA, or a
// processing instruction: every kind of raw HTML that CommonMark passes on.
const htmlTag = /<(?:\/?[a-z][a-z0-9-]{0,30}(?=[\s/>])|!--|![a-z[]|\?)/i;

/**
 * Whether a text looks like an OpenAPI or Swagger document: in JSON with
 * the keys `"openapi"` or `"swagger"` and `"paths"` anywhere, or in YAML
 * with both keys at the start of a line.
 *
 * @param text - The content of a file.
 * @returns True if it has the form of such a document.
 * @example
 * ```ts
 * looksLikeOpenApiDocument(JSON.stringify({ openapi: '3.1.0', paths: {} })); // true
 * ```
 */
export function looksLikeOpenApiDocument(text: string): boolean {
  return (
    (jsonOpenApiKey.test(text) && jsonPathsKey.test(text)) ||
    (yamlOpenApiKey.test(text) && yamlPathsKey.test(text))
  );
}

/**
 * Whether a text is an HTML page: it starts, after white space and
 * comments, with a doctype for HTML or an element `html`, `head` or
 * `body`, or it is an answer of the WordPress API with a page in its field
 * `rendered`.
 *
 * @param text - The content of a file.
 * @returns True if it has the form of an HTML page.
 * @example
 * ```ts
 * looksLikeHtmlPage('<!DOCTYPE html><html></html>'); // true
 * looksLikeHtmlPage('const page = "<html>";'); // false
 * ```
 */
export function looksLikeHtmlPage(text: string): boolean {
  return htmlStart.test(text) || wordPressRendered.test(text);
}

/**
 * Whether a text holds markup of HTML: a start or end tag, a comment, a
 * declaration such as a doctype or CDATA, or a processing instruction. The prepared texts of the facts hold none, since the refresh
 * turns every page into simple Markdown (ADR 0066).
 *
 * @param text - A text of the facts.
 * @returns True if it holds markup.
 * @example
 * ```ts
 * hasHtmlTag('Use <b>bold</b>'); // true
 * hasHtmlTag('1 < 2 and **bold**'); // false
 * ```
 */
export function hasHtmlTag(text: string): boolean {
  return htmlTag.test(text);
}
