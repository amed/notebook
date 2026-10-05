//! Markdown preview (spec section 9): pulldown-cmark with tables, strikethrough,
//! task lists and footnotes, then an ammonia allowlist. Raw HTML is shown as
//! text. Images are shown only when inline as base64 PNG, JPEG, GIF or WebP
//! (Notebook stores images that way); anything else becomes a placeholder, so
//! the preview never fetches a remote resource.

use crate::notebook::IpcError;
use ammonia::{Builder, UrlRelative};
use pulldown_cmark::{Alignment, CowStr, Event, Options, Parser, Tag, TagEnd};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use url::Url;

pub const MAX_PREVIEW_BYTES: usize = 16 * 1024 * 1024;
const BLOCKED_IMAGE: &str = r#"<span class="blocked-image">Image blocked</span>"#;
const FOOTNOTE_ID_PREFIX: &str = "footnote-";
/// Containers nested deeper than this are flattened into their parent: the
/// sanitizer's HTML parser takes time quadratic in the nesting depth.
const MAX_NESTING: usize = 32;

/// Renders unsaved editor text; it never reads vault state.
#[tauri::command]
pub async fn preview_render(text: String) -> Result<String, IpcError> {
    render_off_thread(text).await
}

async fn render_off_thread(text: String) -> Result<String, IpcError> {
    if text.len() > MAX_PREVIEW_BYTES {
        return Err(IpcError::invalid("Documents are limited to 16 MiB."));
    }
    tauri::async_runtime::spawn_blocking(move || render(&text))
        .await
        .map_err(|_| IpcError::internal("PREVIEW"))
}

pub fn render(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let events = Rewriter::new(Parser::new_ext(markdown, options));
    let mut html = String::with_capacity(markdown.len() + markdown.len() / 2);
    pulldown_cmark::html::push_html(&mut html, events);
    SANITIZER.clean(&html).to_string()
}

fn is_inline_image(src: &str) -> bool {
    let Some((kind, data)) = src
        .strip_prefix("data:image/")
        .and_then(|rest| rest.split_once(";base64,"))
    else {
        return false;
    };
    let body = data.trim_end_matches('=');
    matches!(kind, "png" | "jpeg" | "gif" | "webp")
        && !body.is_empty()
        && data.len() - body.len() <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn is_footnote_id(value: &str) -> bool {
    value
        .strip_prefix(FOOTNOTE_ID_PREFIX)
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn is_allowed_href(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(is_footnote_id)
        || Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"))
}

/// The spec section 9 allowlist. `data` is a permitted scheme only so that the
/// attribute filter can admit inline images; it drops `data:` everywhere else.
static SANITIZER: LazyLock<Builder<'static>> = LazyLock::new(|| {
    let alignments = HashMap::from([("align", HashSet::from(["left", "center", "right"]))]);
    let mut builder = Builder::default();
    builder
        .tags(HashSet::from([
            "p",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "ul",
            "ol",
            "li",
            "blockquote",
            "pre",
            "code",
            "em",
            "strong",
            "del",
            "a",
            "img",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
            "hr",
            "br",
            "sup",
            "section",
            "input",
            "span",
        ]))
        .generic_attributes(HashSet::new())
        .tag_attributes(HashMap::from([
            ("a", HashSet::from(["href"])),
            ("img", HashSet::from(["src", "alt", "title"])),
            ("input", HashSet::from(["checked"])),
            ("section", HashSet::from(["id"])),
        ]))
        .tag_attribute_values(HashMap::from([
            ("th", alignments.clone()),
            ("td", alignments),
        ]))
        .set_tag_attribute_values(HashMap::from([(
            "input",
            HashMap::from([("type", "checkbox"), ("disabled", "")]),
        )]))
        .allowed_classes(HashMap::from([
            ("span", HashSet::from(["blocked-image"])),
            (
                "sup",
                HashSet::from(["footnote-reference", "footnote-definition-label"]),
            ),
            ("section", HashSet::from(["footnote-definition"])),
        ]))
        .url_schemes(HashSet::from(["https", "http", "mailto", "data"]))
        .url_relative(UrlRelative::PassThrough)
        .link_rel(Some("noopener noreferrer"))
        .strip_comments(true)
        .attribute_filter(|element, attribute, value| {
            let keep = match (element, attribute) {
                ("img", "src") => is_inline_image(value),
                (_, "href") => is_allowed_href(value),
                ("section", "id") => is_footnote_id(value),
                _ => true,
            };
            keep.then(|| value.into())
        });
    builder
});

/// Rewrites parser events before HTML generation: raw HTML becomes text,
/// non-inline images become placeholders, table cells carry `align`, and
/// footnotes use numbered ids instead of document-controlled labels.
struct Rewriter<I> {
    events: I,
    footnotes: HashMap<String, usize>,
    alignments: Vec<Alignment>,
    in_table_head: bool,
    cell: usize,
    /// Nesting depth inside a blocked image, whose events are dropped.
    blocked: usize,
    /// Nesting depth inside an allowed image, whose events become alt text.
    image: usize,
    /// Depth of open containers (block quotes, lists, items, footnotes,
    /// emphasis and links); those beyond `MAX_NESTING` are dropped.
    depth: usize,
}

impl<'a, I: Iterator<Item = Event<'a>>> Rewriter<I> {
    fn new(events: I) -> Self {
        Self {
            events,
            footnotes: HashMap::new(),
            alignments: Vec::new(),
            in_table_head: false,
            cell: 0,
            blocked: 0,
            image: 0,
            depth: 0,
        }
    }

    /// False for the start or end of a container nested beyond `MAX_NESTING`.
    /// pulldown-cmark always balances them, so the depth count stays exact.
    fn within_nesting_limit(&mut self, event: &Event<'a>) -> bool {
        match event {
            Event::Start(
                Tag::BlockQuote(_)
                | Tag::List(_)
                | Tag::Item
                | Tag::FootnoteDefinition(_)
                | Tag::Emphasis
                | Tag::Strong
                | Tag::Strikethrough
                | Tag::Link { .. },
            ) => {
                self.depth += 1;
                self.depth <= MAX_NESTING
            }
            Event::End(
                TagEnd::BlockQuote(_)
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::FootnoteDefinition
                | TagEnd::Emphasis
                | TagEnd::Strong
                | TagEnd::Strikethrough
                | TagEnd::Link,
            ) => {
                self.depth -= 1;
                self.depth < MAX_NESTING
            }
            _ => true,
        }
    }

    fn footnote_number(&mut self, label: &str) -> usize {
        let next = self.footnotes.len() + 1;
        *self.footnotes.entry(label.to_lowercase()).or_insert(next)
    }

    fn cell_tag(&self) -> &'static str {
        if self.in_table_head { "th" } else { "td" }
    }

    fn rewrite(&mut self, event: Event<'a>) -> Option<Event<'a>> {
        if self.blocked > 0 {
            match event {
                Event::Start(Tag::Image { .. }) => self.blocked += 1,
                Event::End(TagEnd::Image) => self.blocked -= 1,
                _ => {}
            }
            return None;
        }
        if self.image > 0 {
            return Some(match event {
                Event::Start(Tag::Image { .. }) => {
                    self.image += 1;
                    event
                }
                Event::End(TagEnd::Image) => {
                    self.image -= 1;
                    event
                }
                Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
                Event::FootnoteReference(label) => {
                    Event::Text(format!("[{}]", self.footnote_number(&label)).into())
                }
                other => other,
            });
        }
        Some(match event {
            Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
            Event::Start(Tag::HtmlBlock) => Event::Start(Tag::Paragraph),
            Event::End(TagEnd::HtmlBlock) => Event::End(TagEnd::Paragraph),
            Event::Start(Tag::Image { ref dest_url, .. }) => {
                if is_inline_image(dest_url) {
                    self.image = 1;
                    event
                } else {
                    self.blocked = 1;
                    Event::InlineHtml(CowStr::Borrowed(BLOCKED_IMAGE))
                }
            }
            Event::FootnoteReference(label) => {
                let n = self.footnote_number(&label);
                Event::InlineHtml(
                    format!(
                        r##"<sup class="footnote-reference"><a href="#{FOOTNOTE_ID_PREFIX}{n}">{n}</a></sup>"##
                    )
                    .into(),
                )
            }
            Event::Start(Tag::FootnoteDefinition(label)) => {
                let n = self.footnote_number(&label);
                Event::Html(
                    format!(
                        r#"<section class="footnote-definition" id="{FOOTNOTE_ID_PREFIX}{n}"><sup class="footnote-definition-label">{n}</sup>"#
                    )
                    .into(),
                )
            }
            Event::End(TagEnd::FootnoteDefinition) => Event::Html("</section>\n".into()),
            Event::Start(Tag::Table(ref alignments)) => {
                self.alignments = alignments.clone();
                event
            }
            Event::Start(Tag::TableHead) => {
                self.in_table_head = true;
                self.cell = 0;
                event
            }
            Event::End(TagEnd::TableHead) => {
                self.in_table_head = false;
                event
            }
            Event::Start(Tag::TableRow) => {
                self.cell = 0;
                event
            }
            Event::Start(Tag::TableCell) => {
                let align = match self.alignments.get(self.cell) {
                    Some(Alignment::Left) => r#" align="left""#,
                    Some(Alignment::Center) => r#" align="center""#,
                    Some(Alignment::Right) => r#" align="right""#,
                    _ => "",
                };
                Event::InlineHtml(format!("<{}{align}>", self.cell_tag()).into())
            }
            Event::End(TagEnd::TableCell) => {
                self.cell += 1;
                Event::InlineHtml(format!("</{}>", self.cell_tag()).into())
            }
            other => other,
        })
    }
}

impl<'a, I: Iterator<Item = Event<'a>>> Iterator for Rewriter<I> {
    type Item = Event<'a>;

    fn next(&mut self) -> Option<Event<'a>> {
        loop {
            let event = self.events.next()?;
            if !self.within_nesting_limit(&event) {
                continue;
            }
            if let Some(event) = self.rewrite(event) {
                return Some(event);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const ALLOWED_TAGS: &[&str] = &[
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "blockquote",
        "pre",
        "code",
        "em",
        "strong",
        "del",
        "a",
        "img",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "hr",
        "br",
        "sup",
        "section",
        "input",
        "span",
    ];

    #[derive(Debug)]
    struct Element {
        name: String,
        attributes: Vec<(String, String)>,
    }

    impl Element {
        fn get(&self, name: &str) -> Option<&str> {
            self.attributes
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        }
    }

    /// Reads start tags from html5ever's serializer output, which always
    /// double-quotes attribute values and escapes `"` inside them.
    fn elements(html: &str) -> Vec<Element> {
        let mut found = Vec::new();
        let mut rest = html;
        while let Some(start) = rest.find('<') {
            rest = &rest[start + 1..];
            if rest.starts_with('/') || rest.starts_with('!') {
                continue;
            }
            let name_end = rest
                .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .unwrap();
            let name = rest[..name_end].to_owned();
            rest = &rest[name_end..];
            let mut attributes = Vec::new();
            loop {
                rest = rest.trim_start();
                if let Some(after) = rest.strip_prefix('>') {
                    rest = after;
                    break;
                }
                if let Some(after) = rest.strip_prefix("/>") {
                    rest = after;
                    break;
                }
                let key_end = rest
                    .find(|c: char| c == '=' || c.is_whitespace() || c == '>')
                    .unwrap();
                let key = rest[..key_end].to_owned();
                rest = &rest[key_end..];
                let value = if let Some(after) = rest.strip_prefix("=\"") {
                    let close = after.find('"').unwrap();
                    rest = &after[close + 1..];
                    after[..close].replace("&amp;", "&")
                } else {
                    String::new()
                };
                attributes.push((key, value));
            }
            found.push(Element { name, attributes });
        }
        found
    }

    fn assert_safe(markdown: &str) -> String {
        let html = render(markdown);
        for element in elements(&html) {
            assert!(
                ALLOWED_TAGS.contains(&element.name.as_str()),
                "tag {} in {html}",
                element.name
            );
            for (key, value) in &element.attributes {
                assert!(!key.starts_with("on"), "{key} in {html}");
                assert!(
                    matches!(
                        key.as_str(),
                        "href"
                            | "rel"
                            | "src"
                            | "alt"
                            | "title"
                            | "align"
                            | "type"
                            | "checked"
                            | "disabled"
                            | "class"
                            | "id"
                    ),
                    "attribute {key} in {html}"
                );
                let lower = value.to_ascii_lowercase();
                for scheme in ["javascript:", "vbscript:", "data:text", "data:image/svg"] {
                    assert!(!lower.contains(scheme), "{value} in {html}");
                }
                if key == "src" {
                    assert!(is_inline_image(value), "src {value} in {html}");
                }
                if key == "href" {
                    assert!(is_allowed_href(value), "href {value} in {html}");
                }
            }
        }
        assert!(!html.to_ascii_lowercase().contains("<script"), "{html}");
        html
    }

    #[test]
    fn malicious_corpus_renders_without_active_content() {
        let corpus = [
            "<script>alert(1)</script>",
            "<ScRiPt>alert(1)</sCrIpT>",
            "before <script>alert(1)</script> after",
            "<img src=x onerror=alert(1)>",
            "<IMG SRC=\"x\" ONERROR=\"alert(1)\">",
            "<svg onload=alert(1)><circle r=1 /></svg>",
            "<svg><script>alert(1)</script></svg>",
            "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>",
            "<iframe src=\"https://evil.example/\"></iframe>",
            "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
            "<object data=\"https://evil.example/x.swf\"></object>",
            "<embed src=\"https://evil.example/x\">",
            "<style>body { display: none }</style>",
            "<link rel=stylesheet href=https://evil.example/x.css>",
            "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example/\">",
            "<base href=\"https://evil.example/\">",
            "<form action=\"https://evil.example/\"><input name=q></form>",
            "<a href=\"javascript:alert(1)\">raw link</a>",
            "<div onclick=alert(1)>*markdown inside html*</div>",
            "<div>\n\n*nested* [x](javascript:alert(1)) <b onmouseover=alert(1)>b</b>\n\n</div>",
            "<details open ontoggle=alert(1)><summary>x</summary></details>",
            "<!-- <script>alert(1)</script> -->",
            "<![CDATA[<script>alert(1)</script>]]>",
            "&lt;script&gt;alert(1)&lt;/script&gt;",
            "&#60;script&#62;alert(1)&#60;/script&#62;",
            "[click](javascript:alert(1))",
            "[click](JaVaScRiPt:alert(1))",
            "[click](java&#x09;script:alert(1))",
            "[click](&#106;avascript:alert(1))",
            "[click](vbscript:msgbox(1))",
            "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
            "[click](data:image/png;base64,iVBORw0KGgo=)",
            "[click](//evil.example/protocol-relative)",
            "[click](relative/path.md)",
            "[click](file:///etc/passwd)",
            "[click](tauri://localhost/)",
            "<javascript:alert(1)>",
            "[ref]\n\n[ref]: javascript:alert(1)",
            "[x](https://example.com \"a\\\" onmouseover=\\\"alert(1)\")",
            "![x](javascript:alert(1))",
            "![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
            "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
            "![x](data:image/svg+xml,<svg onload=alert(1)>)",
            "![x](data:image/png;base64,iVBOR\"onerror=\"alert(1))",
            "![x](https://tracker.example/pixel.gif)",
            "![x](//tracker.example/pixel.gif)",
            "![x](file:///etc/passwd)",
            "![a\" onerror=\"alert(1)](https://x.example/a.png)",
            "![ok](data:image/png;base64,iVBORw0KGgo= \"t\\\" onerror=\\\"alert(1)\")",
            "[![inner](https://x.example/a.png)](javascript:alert(1))",
            "![outer ![inner](https://x.example/a.png)](data:image/png;base64,iVBORw0KGgo=)",
            "Footnote[^<img src=x onerror=alert(1)>]\n\n[^<img src=x onerror=alert(1)>]: <script>alert(1)</script>",
            "| <script>alert(1)</script> | <img src=x onerror=alert(1)> |\n|---|:-:|\n| [x](javascript:alert(1)) | ![y](https://x.example/y.png) |",
            "- [x] <input type=text onfocus=alert(1) autofocus>",
            "<input type=\"checkbox\" onclick=alert(1)>",
            "<span class=\"blocked-image\" onclick=alert(1)>fake</span>",
            "<section id=\"app\">clobber</section>",
            "```html\n<script>alert(1)</script>\n```",
            "`<script>alert(1)</script>`",
        ];
        for markdown in corpus {
            assert_safe(markdown);
        }
    }

    #[test]
    fn raw_html_is_shown_as_text() {
        let html = assert_safe("<script>alert(1)</script>");
        assert!(
            html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "{html}"
        );
        let html = assert_safe("a <b onmouseover=alert(1)>bold</b> *em*");
        assert!(
            html.contains("&lt;b onmouseover=alert(1)&gt;bold&lt;/b&gt;"),
            "{html}"
        );
        assert!(html.contains("<em>em</em>"), "{html}");
        let html = assert_safe("<div>\n\n*nested*\n\n</div>");
        assert!(html.contains("&lt;div&gt;"), "{html}");
        assert!(html.contains("<em>nested</em>"), "{html}");
        let html = assert_safe("<section id=\"app\">clobber</section>");
        assert!(
            !elements(&html).iter().any(|e| e.name == "section"),
            "{html}"
        );
    }

    #[test]
    fn dangerous_links_lose_their_target() {
        for markdown in [
            "[x](javascript:alert(1))",
            "[x](data:text/html,hi)",
            "[x](//evil.example/)",
            "[x](relative.md)",
            "[x](#not-a-footnote)",
        ] {
            let html = assert_safe(markdown);
            let links = elements(&html)
                .into_iter()
                .filter(|e| e.name == "a")
                .collect::<Vec<_>>();
            assert_eq!(links.len(), 1, "{html}");
            assert_eq!(links[0].get("href"), None, "{html}");
        }
    }

    #[test]
    fn web_and_mail_links_keep_href_and_get_rel() {
        let html = assert_safe(
            "[site](https://example.com/a?b=1&c=2 \"title\") <https://example.org> <me@example.com>",
        );
        let links = elements(&html)
            .into_iter()
            .filter(|e| e.name == "a")
            .collect::<Vec<_>>();
        let hrefs = links.iter().map(|e| e.get("href")).collect::<Vec<_>>();
        assert_eq!(
            hrefs,
            [
                Some("https://example.com/a?b=1&c=2"),
                Some("https://example.org"),
                Some("mailto:me@example.com"),
            ]
        );
        assert!(
            links
                .iter()
                .all(|e| e.get("rel") == Some("noopener noreferrer"))
        );
        assert!(links.iter().all(|e| e.get("title").is_none()));
    }

    #[test]
    fn inline_raster_images_survive_and_others_are_blocked() {
        let html = assert_safe(&format!("![dot]({PNG} \"Dot\")"));
        let images = elements(&html)
            .into_iter()
            .filter(|e| e.name == "img")
            .collect::<Vec<_>>();
        assert_eq!(images.len(), 1, "{html}");
        assert_eq!(images[0].get("src"), Some(PNG));
        assert_eq!(images[0].get("alt"), Some("dot"));
        assert_eq!(images[0].get("title"), Some("Dot"));
        for kind in ["jpeg", "gif", "webp"] {
            let html = assert_safe(&format!("![x](data:image/{kind};base64,AAAA)"));
            assert!(html.contains("<img "), "{html}");
        }

        for markdown in [
            "![remote](https://example.com/pixel.png)",
            "![relative](images/a.png)",
            "![svg](data:image/svg+xml;base64,PHN2Zz4=)",
            "![bmp](data:image/bmp;base64,Qk0=)",
            "![upper](DATA:IMAGE/PNG;base64,iVBORw0KGgo=)",
            "![not base64](data:image/png,raw)",
            "![secure](secure-img://0b6b2e1e-9e43-4b39-9f61-0f3f0b0e7f10)",
        ] {
            let html = assert_safe(markdown);
            assert!(!html.contains("<img"), "{html}");
            assert!(
                html.contains(r#"<span class="blocked-image">Image blocked</span>"#),
                "{html}"
            );
            assert!(!html.contains("example.com"), "{html}");
        }
    }

    #[test]
    fn tables_render_with_alignment() {
        let html = assert_safe(
            "| Left | Center | Right | None |\n|:-----|:------:|------:|------|\n| a | **b** | c | d |",
        );
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("<thead>"), "{html}");
        assert!(html.contains("<tbody>"), "{html}");
        assert!(html.contains(r#"<th align="left">Left</th>"#), "{html}");
        assert!(html.contains(r#"<th align="center">Center</th>"#), "{html}");
        assert!(html.contains(r#"<th align="right">Right</th>"#), "{html}");
        assert!(html.contains("<th>None</th>"), "{html}");
        assert!(
            html.contains(r#"<td align="center"><strong>b</strong></td>"#),
            "{html}"
        );
        assert!(html.contains("<td>d</td>"), "{html}");
    }

    #[test]
    fn task_lists_render_disabled_checkboxes() {
        let html = assert_safe("- [ ] open\n- [x] done\n- plain");
        let boxes = elements(&html)
            .into_iter()
            .filter(|e| e.name == "input")
            .collect::<Vec<_>>();
        assert_eq!(boxes.len(), 2, "{html}");
        for checkbox in &boxes {
            assert_eq!(checkbox.get("type"), Some("checkbox"));
            assert_eq!(checkbox.get("disabled"), Some(""));
        }
        assert_eq!(boxes[0].get("checked"), None);
        assert_eq!(boxes[1].get("checked"), Some(""));
    }

    #[test]
    fn footnotes_link_to_numbered_sections() {
        let html = assert_safe(
            "First[^note] and second[^Other].\n\n[^note]: The *note*.\n[^other]: Another.",
        );
        assert!(
            html.contains(r##"<sup class="footnote-reference"><a href="#footnote-1" rel="noopener noreferrer">1</a></sup>"##),
            "{html}"
        );
        assert!(html.contains(r##"<a href="#footnote-2""##), "{html}");
        assert!(
            html.contains(r#"<section class="footnote-definition" id="footnote-1"><sup class="footnote-definition-label">1</sup>"#),
            "{html}"
        );
        assert!(html.contains(r#"id="footnote-2""#), "{html}");
        assert!(html.contains("<em>note</em>"), "{html}");
        assert!(!html.contains("id=\"note\""), "{html}");
    }

    #[test]
    fn common_markdown_still_renders() {
        let html = assert_safe(
            "# Title\n\nSome ~~old~~ **bold** and *em* text.\n\n> quote\n\n1. one\n2. two\n\n---\n\n```\ncode <b>\n```\n\nline  \nbreak",
        );
        for fragment in [
            "<h1>Title</h1>",
            "<del>old</del>",
            "<strong>bold</strong>",
            "<em>em</em>",
            "<blockquote>",
            "<ol>",
            "<li>one</li>",
            "<hr>",
            "<pre><code>code &lt;b&gt;",
            "<br>",
        ] {
            assert!(html.contains(fragment), "{fragment} missing from {html}");
        }
    }

    #[test]
    fn deep_nesting_is_flattened_quickly() {
        let started = std::time::Instant::now();
        for (markdown, tag) in [
            (format!("{}x", "- ".repeat(200_000)), "<ul>"),
            (format!("{}x", ">".repeat(200_000)), "<blockquote>"),
            (
                format!("{}x{}", "*a ".repeat(50_000), " a*".repeat(50_000)),
                "<em>",
            ),
            (
                format!(
                    "{}x{}",
                    "[".repeat(50_000),
                    "](https://example.com/)".repeat(50_000)
                ),
                "<a ",
            ),
        ] {
            let html = render(&markdown);
            assert!(html.contains('x'), "{tag}");
            assert!(html.matches(tag).count() <= MAX_NESTING, "{tag}");
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
        let html = assert_safe("> > quote\n\n- a\n  - b\n    - c");
        assert_eq!(html.matches("<blockquote>").count(), 2, "{html}");
        assert_eq!(html.matches("<ul>").count(), 3, "{html}");
    }

    #[test]
    fn oversized_text_is_rejected() {
        let text = "a".repeat(MAX_PREVIEW_BYTES + 1);
        let result = tauri::async_runtime::block_on(render_off_thread(text));
        assert!(result.is_err());
        let result = tauri::async_runtime::block_on(render_off_thread("*ok*".into()));
        assert_eq!(result.ok().as_deref(), Some("<p><em>ok</em></p>\n"));
    }
}
