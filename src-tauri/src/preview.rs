//! Markdown preview (spec section 9): pulldown-cmark with tables, strikethrough,
//! task lists and footnotes, then an ammonia allowlist. Raw HTML is shown as
//! text. Images are shown only when inline as base64 PNG, JPEG, GIF or WebP
//! (Notebook stores images that way); anything else becomes a placeholder, so
//! the preview never fetches a remote resource.
//!
//! Links (README "Links"): every heading gets a generated id ("h-" and a
//! GitHub-style slug of its text), and `#Heading` links point at it; links to
//! other vault documents (`notes/a.md#part`, `[[Note#Heading|alias]]`) become
//! `nb-doc:` / `nb-wiki:` hrefs that only the app's link handler follows
//! (main.ts resolves them against the tree). Document text never chooses an
//! id or an internal href: both are built here and checked by the sanitizer.

use crate::notebook::IpcError;
use ammonia::{Builder, UrlRelative};
use pulldown_cmark::{
    Alignment, CowStr, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Write as _;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;
use url::Url;

pub const MAX_PREVIEW_BYTES: usize = 16 * 1024 * 1024;
const BLOCKED_IMAGE: &str = r#"<span class="blocked-image">Image blocked</span>"#;
const FOOTNOTE_ID_PREFIX: &str = "footnote-";
/// Heading ids: a fixed prefix, so no id can name an app element or a
/// global (`__proto__` becomes `h-__proto__`).
const HEADING_ID_PREFIX: &str = "h-";
/// Hrefs of links to other vault documents: a relative path, or a wikilink
/// target, percent-encoded, and an optional heading id. The WebView never
/// loads them (navigation.ts hands them to main.ts; the navigation guard
/// would refuse them anyway).
pub const DOC_LINK_SCHEME: &str = "nb-doc:";
pub const WIKI_LINK_SCHEME: &str = "nb-wiki:";
/// Slugs are cut here (in chars), before a duplicate's suffix.
const MAX_SLUG_CHARS: usize = 200;
/// Longest path or wikilink target (in chars) that becomes an internal link.
const MAX_LINK_TARGET_CHARS: usize = 1024;
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
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_WIKILINKS;
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

/// GitHub's heading slug (github-slugger): the whole text lowercased (so a
/// final `Σ` becomes `ς`; `str::to_lowercase` applies that rule, per-char
/// lowercasing does not), letters, numbers, marks, `-` and `_` kept, each
/// whitespace character a `-`, everything else dropped. src/vault-links.ts
/// `slugify` is the same function.
pub fn slug(text: &str) -> String {
    text.nfc()
        .collect::<String>()
        .to_lowercase()
        .chars()
        .filter_map(|c| {
            if c.is_whitespace() {
                Some('-')
            } else {
                is_slug_char(c).then_some(c)
            }
        })
        .take(MAX_SLUG_CHARS)
        .collect()
}

fn is_slug_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_' || is_combining_mark(c)
}

/// A generated heading id: the prefix and slug characters only.
fn is_heading_id(value: &str) -> bool {
    value
        .strip_prefix(HEADING_ID_PREFIX)
        .is_some_and(|slug| slug.chars().all(is_slug_char))
}

fn is_heading_tag(tag: &str) -> bool {
    matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

/// The ids of a document's headings, in order; a repeated slug gets `-1`,
/// `-2`, … as on GitHub, so every id is unique.
#[derive(Default)]
struct HeadingIds {
    seen: HashMap<String, usize>,
}

impl HeadingIds {
    fn next(&mut self, text: &str) -> String {
        let base = slug(text);
        let mut id = base.clone();
        while self.seen.contains_key(&id) {
            let count = self.seen.entry(base.clone()).or_insert(0);
            *count += 1;
            id = format!("{base}-{count}");
        }
        self.seen.insert(id.clone(), 0);
        format!("{HEADING_ID_PREFIX}{id}")
    }
}

/// Percent-encodes every byte but ASCII letters, digits, `-._~` (and `/`
/// with `keep_slash`), so an internal href is plain ASCII.
fn percent_encode(value: &str, keep_slash: bool) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'_' | b'~')
            || (keep_slash && byte == b'/')
        {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// Decodes `%XX` escapes (a `%` without two hex digits stays as it is);
/// None when the bytes are not UTF-8.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escape = (bytes[index] == b'%')
            .then(|| bytes.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(byte) = escape {
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// A link's `#fragment` as the id it targets: a footnote id as it is, else
/// the heading id of its (decoded) text. None when nothing is left of it.
fn fragment_id(fragment: &str) -> Option<String> {
    if is_footnote_id(fragment) {
        return Some(fragment.to_owned());
    }
    let slug = slug(&percent_decode(fragment)?);
    (!slug.is_empty()).then(|| format!("{HEADING_ID_PREFIX}{slug}"))
}

/// A path or wikilink target that may become an internal link.
fn is_link_target(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_LINK_TARGET_CHARS
        && !value.chars().any(char::is_control)
}

fn internal_href(scheme: &str, target: &str, fragment: Option<&str>) -> String {
    let mut href = format!("{scheme}{}", percent_encode(target, true));
    if let Some(id) = fragment.and_then(fragment_id) {
        href.push('#');
        href.push_str(&percent_encode(&id, false));
    }
    href
}

/// An in-page `#…` href exactly as `fragment_id` writes it.
fn is_fragment_href(value: &str) -> bool {
    is_footnote_id(value)
        || percent_decode(value)
            .is_some_and(|id| is_heading_id(&id) && percent_encode(&id, false) == value)
}

/// An `nb-doc:` or `nb-wiki:` href exactly as `internal_href` writes it.
pub fn is_internal_href(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix(DOC_LINK_SCHEME)
        .or_else(|| value.strip_prefix(WIKI_LINK_SCHEME))
    else {
        return false;
    };
    let (target, fragment) = rest
        .split_once('#')
        .map_or((rest, None), |(target, fragment)| (target, Some(fragment)));
    percent_decode(target)
        .is_some_and(|decoded| is_link_target(&decoded) && percent_encode(&decoded, true) == target)
        && fragment.is_none_or(|id| !id.is_empty() && is_fragment_href(id))
}

/// The href a Markdown link gets, when it is not left to the sanitizer
/// (web and mail links, and anything it refuses): `#Heading` targets the
/// heading's id, a relative path or a wikilink becomes an internal link.
/// An empty href is removed by the sanitizer.
fn link_href(link_type: LinkType, dest: &str) -> Option<String> {
    match link_type {
        LinkType::Email => return None,
        LinkType::WikiLink { .. } => return Some(wiki_href(dest).unwrap_or_default()),
        _ => {}
    }
    if let Some(fragment) = dest.strip_prefix('#') {
        return Some(
            fragment_id(fragment)
                .map_or_else(String::new, |id| format!("#{}", percent_encode(&id, false))),
        );
    }
    if let Ok(url) = Url::parse(dest) {
        // Only this module writes internal hrefs.
        let internal = format!("{}:", url.scheme());
        return [DOC_LINK_SCHEME, WIKI_LINK_SCHEME]
            .contains(&internal.as_str())
            .then(String::new);
    }
    // Protocol-relative (`//host`, `\\host`) is a web address, not a path.
    if dest.starts_with("//") || dest.starts_with('\\') || dest.starts_with("/\\") {
        return Some(String::new());
    }
    let (path, fragment) = dest
        .split_once('#')
        .map_or((dest, None), |(path, fragment)| (path, Some(fragment)));
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    let href = percent_decode(path)
        .filter(|path| is_link_target(path))
        .map(|path| internal_href(DOC_LINK_SCHEME, &path, fragment));
    Some(href.unwrap_or_default())
}

/// `[[Note]]`, `[[Folder/Note#Heading]]` (pulldown-cmark drops `|alias`):
/// the target as written, and the last `#` part as the heading
/// (`[[Note#A#B]]` is B). `[[#Heading]]` is a heading of this document.
fn wiki_href(dest: &str) -> Option<String> {
    let (target, heading) = dest
        .split_once('#')
        .map_or((dest, None), |(target, heading)| {
            (target, heading.rsplit('#').next())
        });
    let target = target.trim();
    if target.is_empty() {
        let id = fragment_id(heading?.trim())?;
        return Some(format!("#{}", percent_encode(&id, false)));
    }
    is_link_target(target).then(|| internal_href(WIKI_LINK_SCHEME, target, heading.map(str::trim)))
}

fn is_allowed_href(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(is_fragment_href)
        || is_internal_href(value)
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
            ("h1", HashSet::from(["id"])),
            ("h2", HashSet::from(["id"])),
            ("h3", HashSet::from(["id"])),
            ("h4", HashSet::from(["id"])),
            ("h5", HashSet::from(["id"])),
            ("h6", HashSet::from(["id"])),
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
        .url_schemes(HashSet::from([
            "https", "http", "mailto", "data", "nb-doc", "nb-wiki",
        ]))
        .url_relative(UrlRelative::PassThrough)
        .link_rel(Some("noopener noreferrer"))
        .strip_comments(true)
        .attribute_filter(|element, attribute, value| {
            let keep = match (element, attribute) {
                ("img", "src") => is_inline_image(value),
                (_, "href") => is_allowed_href(value),
                ("section", "id") => is_footnote_id(value),
                (tag, "id") if is_heading_tag(tag) => is_heading_id(value),
                _ => true,
            };
            keep.then(|| value.into())
        });
    builder
});

/// Rewrites parser events before HTML generation: raw HTML becomes text,
/// non-inline images become placeholders, table cells carry `align`,
/// footnotes use numbered ids instead of document-controlled labels,
/// headings get generated ids and links their app hrefs (`link_href`).
struct Rewriter<'a, I> {
    events: I,
    /// A heading's events, held back until its text has named it.
    pending: VecDeque<Event<'a>>,
    heading_ids: HeadingIds,
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

impl<'a, I: Iterator<Item = Event<'a>>> Rewriter<'a, I> {
    fn new(events: I) -> Self {
        Self {
            events,
            pending: VecDeque::new(),
            heading_ids: HeadingIds::default(),
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
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => Event::Start(Tag::Link {
                link_type,
                dest_url: link_href(link_type, &dest_url).map_or(dest_url, CowStr::from),
                title,
                id,
            }),
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

impl<'a, I: Iterator<Item = Event<'a>>> Rewriter<'a, I> {
    fn next_rewritten(&mut self) -> Option<Event<'a>> {
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

    /// The start of a heading, with the id of its visible text (text and
    /// code, not image alt text or footnote marks); its other events wait
    /// in `pending`.
    fn heading(&mut self, level: HeadingLevel) -> Event<'a> {
        let mut text = String::new();
        let mut image = 0_usize;
        while let Some(event) = self.next_rewritten() {
            let end = matches!(event, Event::End(TagEnd::Heading(_)));
            match &event {
                Event::Start(Tag::Image { .. }) => image += 1,
                Event::End(TagEnd::Image) => image = image.saturating_sub(1),
                Event::Text(value) | Event::Code(value) if image == 0 => text.push_str(value),
                Event::SoftBreak | Event::HardBreak if image == 0 => text.push(' '),
                _ => {}
            }
            self.pending.push_back(event);
            if end {
                break;
            }
        }
        Event::Start(Tag::Heading {
            level,
            id: Some(self.heading_ids.next(&text).into()),
            classes: Vec::new(),
            attrs: Vec::new(),
        })
    }
}

impl<'a, I: Iterator<Item = Event<'a>>> Iterator for Rewriter<'a, I> {
    type Item = Event<'a>;

    fn next(&mut self) -> Option<Event<'a>> {
        if let Some(event) = self.pending.pop_front() {
            return Some(event);
        }
        match self.next_rewritten()? {
            Event::Start(Tag::Heading { level, .. }) => Some(self.heading(level)),
            event => Some(event),
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
                if key == "id" {
                    let generated = match element.name.as_str() {
                        "section" => is_footnote_id(value),
                        tag => is_heading_tag(tag) && is_heading_id(value),
                    };
                    assert!(generated, "id {value} on {} in {html}", element.name);
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
            "[x](\\\\evil.example/share)",
            "[x](nb-doc:Notes/a.md)",
            "[x](NB-WIKI:Note)",
            "[x](#)",
            "[x](#!!!)",
            "[[ ]]",
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
            "<h1 id=\"h-title\">Title</h1>",
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

    fn hrefs(html: &str) -> Vec<Option<String>> {
        elements(html)
            .into_iter()
            .filter(|e| e.name == "a")
            .map(|e| e.get("href").map(str::to_owned))
            .collect()
    }

    fn heading_ids(html: &str) -> Vec<String> {
        elements(html)
            .into_iter()
            .filter(|e| is_heading_tag(&e.name))
            .map(|e| e.get("id").unwrap_or_default().to_owned())
            .collect()
    }

    #[test]
    fn slugs_follow_github() {
        for (text, expected) in [
            ("Hello World", "hello-world"),
            ("  What's new?  ", "--whats-new--"),
            ("Tom & Jerry", "tom--jerry"),
            ("snake_case and-dash", "snake_case-and-dash"),
            ("Über Größe", "über-größe"),
            ("Ünïcödé 日本語 Ελληνικά", "ünïcödé-日本語-ελληνικά"),
            ("e\u{301}t\u{e9}", "\u{e9}t\u{e9}"),
            ("Release 2.0 (beta)", "release-20-beta"),
            ("<script>", "script"),
            ("\"onclick=alert(1)", "onclickalert1"),
            ("!!!", ""),
            ("ΣΊΣΥΦΟΣ", "σίσυφος"),
            ("ΟΔΟΣ", "οδος"),
            ("ΟΔΟΣ ΣΤΟ ΣΠΙΤΙ", "οδος-στο-σπιτι"),
            ("Σ", "σ"),
        ] {
            assert_eq!(slug(text), expected, "{text}");
        }
        assert_eq!(slug(&"a".repeat(500)).chars().count(), MAX_SLUG_CHARS);
    }

    #[test]
    fn headings_get_unique_generated_ids() {
        let html = assert_safe(
            "# Intro\n\n## Intro\n\nIntro\n-----\n\n## Intro 1\n\n### `code` *and* [link](https://x.example)\n\n# Über\n\n# `__proto__`\n\n#\n\n> # Quoted",
        );
        assert_eq!(
            heading_ids(&html),
            [
                "h-intro",
                "h-intro-1",
                "h-intro-2",
                "h-intro-1-1",
                "h-code-and-link",
                "h-über",
                "h-__proto__",
                "h-",
                "h-quoted",
            ]
        );
        // Headings in code are not headings.
        let html = assert_safe("```\n# not a heading\n```\n\n# Real");
        assert_eq!(heading_ids(&html), ["h-real"]);
    }

    /// tests/unit/vault-links.test.mjs expects the same ids from outline.ts
    /// labels (main.ts finds a fragment's editor line by them).
    #[test]
    fn heading_ids_keep_intraword_underscores_and_code() {
        let html = assert_safe(
            "## parse_config\n\n## snake_case_name\n\n## `parse_markdown()`\n\n## __proto__\n\n## a _b_ c\n\n## my__var\n\n## foo\\_bar\n\n## [`code`](https://x.example)\n\n## __init__.py\n\n## `__init__`\n\n## ΟΔΟΣ\n\n[a](#οδος) [b](#ΟΔΟΣ)",
        );
        assert_eq!(
            heading_ids(&html),
            [
                "h-parse_config",
                "h-snake_case_name",
                "h-parse_markdown",
                "h-proto",
                "h-a-b-c",
                "h-my__var",
                "h-foo_bar",
                "h-code",
                "h-initpy",
                "h-__init__",
                "h-οδος",
            ]
        );
        let greek = Some("#h-%CE%BF%CE%B4%CE%BF%CF%82".to_owned());
        assert_eq!(hrefs(&html)[1..], [greek.clone(), greek]);
    }

    #[test]
    fn heading_ids_ignore_image_alt_and_footnote_marks() {
        let html = assert_safe(&format!(
            "# Logo ![alt text]({PNG}) here[^1]\n\n# ![x](https://x.example/a.png) Blocked\n\n[^1]: note"
        ));
        assert_eq!(heading_ids(&html), ["h-logo--here", "h--blocked"]);
    }

    #[test]
    fn documents_cannot_choose_ids() {
        for markdown in [
            "<h1 id=\"__proto__\">x</h1>",
            "<h2 id=\"app\">clobber</h2>",
            "<a id=\"settings\" name=\"x\">a</a>",
            "# Title {#custom}",
            "<section id=\"footnote-1\">fake</section>",
        ] {
            let html = assert_safe(markdown);
            for element in elements(&html) {
                if let Some(id) = element.get("id") {
                    assert!(
                        is_heading_tag(&element.name) && id.starts_with("h-"),
                        "{html}"
                    );
                }
            }
        }
        let html = assert_safe("# Title {#custom}");
        assert_eq!(heading_ids(&html), ["h-title-custom"]);
        // The sanitizer itself drops ids it did not generate.
        let cleaned = SANITIZER
            .clean("<h1 id=\"__proto__\">a</h1><h2 id=\"h-ok\">b</h2><h3 id=\"h-a b\">c</h3><p id=\"h-x\">d</p><section id=\"x\">e</section>")
            .to_string();
        assert_eq!(
            cleaned,
            "<h1>a</h1><h2 id=\"h-ok\">b</h2><h3>c</h3><p>d</p><section>e</section>"
        );
    }

    #[test]
    fn in_page_links_target_heading_ids() {
        let html = assert_safe(
            "# Größe & Maß\n\n[a](#größe--maß) [b](#Gr%C3%B6%C3%9Fe%20%26%20Ma%C3%9F) [c](<#Größe & Maß>) [d](#h-x) [e](#footnote-2)",
        );
        assert_eq!(
            hrefs(&html),
            [
                Some("#h-gr%C3%B6%C3%9Fe--ma%C3%9F".into()),
                Some("#h-gr%C3%B6%C3%9Fe--ma%C3%9F".into()),
                Some("#h-gr%C3%B6%C3%9Fe--ma%C3%9F".into()),
                Some("#h-h-x".into()),
                Some("#footnote-2".into()),
            ]
        );
        assert_eq!(heading_ids(&html), ["h-größe--maß"]);
    }

    #[test]
    fn attack_fragments_stay_inert() {
        for markdown in [
            "[x](#%22onclick=alert(1))",
            "[x](#%22%20onmouseover%3D%22alert(1))",
            "[x](<#\" onclick=\"alert(1)>)",
            "[x](#javascript:alert(1))",
            "[x](#__proto__)",
            "[x](#%00%0A)",
            "[x](#%FF)",
        ] {
            let html = assert_safe(markdown);
            for href in hrefs(&html).into_iter().flatten() {
                let id = href.strip_prefix("#h-").expect("a heading href");
                assert!(
                    id.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_%".contains(&b)),
                    "{html}"
                );
            }
        }
        let html = assert_safe("[x](#%22onclick=alert(1))");
        assert_eq!(hrefs(&html), [Some("#h-onclickalert1".into())]);
    }

    #[test]
    fn relative_links_become_vault_links() {
        let html = assert_safe(
            "[a](notes/other.md) [b](../a/b.md#Section%20Two) [c](Other%20Note.md?x=1#intro) [d](./My%20Folder/) [e](/top.html) [f](<with space.md>) [g](a%ZZ.md)",
        );
        assert_eq!(
            hrefs(&html),
            [
                Some("nb-doc:notes/other.md".into()),
                Some("nb-doc:../a/b.md#h-section-two".into()),
                Some("nb-doc:Other%20Note.md#h-intro".into()),
                Some("nb-doc:./My%20Folder/".into()),
                Some("nb-doc:/top.html".into()),
                Some("nb-doc:with%20space.md".into()),
                Some("nb-doc:a%25ZZ.md".into()),
            ]
        );
        // Not UTF-8 once decoded, control characters, or a scheme: no link.
        for markdown in [
            "[x](a%FF.md)",
            "[x](a%0A.md)",
            "[x](c:/x.md)",
            "[x](tauri://localhost/)",
        ] {
            assert_eq!(hrefs(&assert_safe(markdown)), [None], "{markdown}");
        }
    }

    #[test]
    fn wikilinks_become_vault_links() {
        let html = assert_safe(
            "[[Note]] [[Folder/Other Note#Part One|alias]] [[Note#A#B]] [[#Local heading]] [[Café]]",
        );
        assert_eq!(
            hrefs(&html),
            [
                Some("nb-wiki:Note".into()),
                Some("nb-wiki:Folder/Other%20Note#h-part-one".into()),
                Some("nb-wiki:Note#h-b".into()),
                Some("#h-local-heading".into()),
                Some("nb-wiki:Caf%C3%A9".into()),
            ]
        );
        assert!(html.contains(">alias</a>"), "{html}");
        assert!(html.contains(">Note</a>"), "{html}");
        // An embed is an image: blocked like any other remote one.
        let html = assert_safe("![[picture.png]]");
        assert!(html.contains("Image blocked"), "{html}");
    }

    #[test]
    fn wikilink_targets_cannot_reach_other_schemes() {
        for markdown in [
            "[[javascript:alert(1)]]",
            "[[javascript:alert(1)|click]]",
            "[[https://evil.example/]]",
            "[[\"><script>alert(1)</script>]]",
            "[[x\" onclick=\"alert(1)]]",
        ] {
            let html = assert_safe(markdown);
            for href in hrefs(&html).into_iter().flatten() {
                assert!(href.starts_with(WIKI_LINK_SCHEME), "{html}");
                assert!(
                    href.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-._~/%:#".contains(&b)),
                    "{html}"
                );
            }
        }
        assert_eq!(
            hrefs(&assert_safe("[[javascript:alert(1)]]")),
            [Some("nb-wiki:javascript%3Aalert%281%29".into())]
        );
    }

    #[test]
    fn only_canonical_internal_hrefs_pass() {
        for valid in [
            "nb-doc:a.md",
            "nb-doc:../x/My%20Note.md#h-part",
            "nb-wiki:Caf%C3%A9#h-caf%C3%A9",
            "nb-doc:a.md#footnote-3",
        ] {
            assert!(is_internal_href(valid), "{valid}");
        }
        for invalid in [
            "nb-doc:",
            "nb-doc:a b.md",
            "nb-doc:a%20.md#",
            "nb-doc:a.md#x",
            "nb-doc:a.md#h-a%20b",
            "nb-doc:a%2fb.md",
            "nb-doc:%0A",
            "nb-doc:a.md#h-x#h-y",
            "nb-wiki:javascript:alert(1)",
            "nb-other:a.md",
            "javascript:alert(1)",
            "https://example.com",
        ] {
            assert!(!is_internal_href(invalid), "{invalid}");
        }
        assert!(!is_internal_href(&format!(
            "nb-doc:{}",
            "a".repeat(MAX_LINK_TARGET_CHARS + 1)
        )));
    }
}
