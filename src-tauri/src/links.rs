//! External links from the preview (spec section 9). The URL is validated here
//! and handed to the system browser or mail client through the opener plugin's
//! Rust API; the webview itself has no opener permission.

use crate::notebook::IpcError;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAX_LINK_CHARS: usize = 2048;

#[tauri::command]
pub async fn link_open(app: AppHandle, url: String) -> Result<(), IpcError> {
    let target = external_link(&url)
        .ok_or_else(|| IpcError::new("LINK_REJECTED", "Only web and email links can be opened."))?;
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|_| IpcError::new("LINK_OPEN_FAILED", "The link could not be opened."))
}

/// Accepts absolute `https:`, `http:` and `mailto:` URLs only, without
/// credentials, and returns the normalized form that is passed to the OS.
fn external_link(input: &str) -> Option<Url> {
    if input.chars().count() > MAX_LINK_CHARS
        || input.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let url = Url::parse(input).ok()?;
    let valid = match url.scheme() {
        "https" | "http" => {
            url.host_str().is_some_and(|host| !host.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
        }
        // Only the RFC 6068 header fields mail apps agree on: some clients
        // honour `attach=` and would attach a local file to the draft.
        "mailto" => {
            url.cannot_be_a_base()
                && !url.path().is_empty()
                && url.query_pairs().all(|(key, _)| {
                    matches!(
                        key.to_ascii_lowercase().as_str(),
                        "to" | "cc" | "bcc" | "subject" | "body" | "in-reply-to"
                    )
                })
        }
        _ => false,
    };
    (valid && url.as_str().len() <= MAX_LINK_CHARS).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_and_mail_links_are_accepted() {
        for (input, normalized) in [
            ("https://example.com", "https://example.com/"),
            (
                "https://example.com/a/b?q=1&r=2#top",
                "https://example.com/a/b?q=1&r=2#top",
            ),
            ("http://example.com:8080/x", "http://example.com:8080/x"),
            ("HTTPS://Example.COM/Path", "https://example.com/Path"),
            ("https://bücher.example/", "https://xn--bcher-kva.example/"),
            (
                "mailto:someone@example.com?subject=Hi%20there",
                "mailto:someone@example.com?subject=Hi%20there",
            ),
            (
                "mailto:a@b.example?subject=x&body=y",
                "mailto:a@b.example?subject=x&body=y",
            ),
            (
                "mailto:a@b.example?CC=c@b.example&In-Reply-To=%3Cid%3E",
                "mailto:a@b.example?CC=c@b.example&In-Reply-To=%3Cid%3E",
            ),
        ] {
            assert_eq!(
                external_link(input).map(|url| url.to_string()).as_deref(),
                Some(normalized),
                "{input}"
            );
        }
    }

    #[test]
    fn everything_else_is_rejected() {
        for input in [
            "",
            "example.com",
            "/relative/path",
            "#footnote-1",
            "//example.com/protocol-relative",
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "vbscript:msgbox(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "file://server/share/x.exe",
            "tauri://localhost/",
            "ftp://example.com/",
            "tel:+123456",
            "smb://server/share",
            "ms-settings:privacy",
            "https://user:secret@example.com/",
            "https://user@example.com/",
            "mailto:",
            "mailto://example.com",
            "mailto:a@evil.example?attach=/etc/passwd",
            "mailto:a@evil.example?attachment=~/.ssh/id_ed25519&body=hi",
            "mailto:a@evil.example?%61ttach=%2Fetc%2Fpasswd",
            "mailto:a@evil.example?subject=x&ATTACH=/etc/passwd",
            "mailto:a@evil.example?=x",
            " https://example.com/",
            "https://example.com/\n",
            "https://exa\tmple.com/",
            "https://example.com/a b",
            "\u{0}https://example.com/",
        ] {
            assert!(external_link(input).is_none(), "{input:?}");
        }
    }

    #[test]
    fn length_is_capped() {
        let base = "https://example.com/";
        let fits = format!("{base}{}", "a".repeat(MAX_LINK_CHARS - base.len()));
        assert!(external_link(&fits).is_some());
        let too_long = format!("{fits}a");
        assert!(external_link(&too_long).is_none());
        // Percent-encoding may grow a URL past the cap after normalization.
        let grows = format!("{base}{}", "é".repeat(1000));
        assert!(grows.chars().count() <= MAX_LINK_CHARS);
        assert!(external_link(&grows).is_none());
    }
}
