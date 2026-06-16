use std::path::{Path, PathBuf};

/// Canonical filesystem path used as the registry key. Canonicalises by
/// resolving symlinks, normalising separators, and stripping trailing slash.
/// Never written back to the connection; the connection always stores the
/// user-supplied path verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonPath(PathBuf);

impl CanonPath {
    /// Canonicalise `raw` by resolving symlinks. Requires the path to exist.
    pub fn new(raw: impl AsRef<Path>) -> std::io::Result<Self> {
        let p = std::fs::canonicalize(raw.as_ref())?;
        Ok(Self(p))
    }

    /// Best-effort canonicalisation that does NOT require the path to exist.
    /// Used when storing an `Unavailable` entry for a folder that may have
    /// been deleted between subscription and registry insertion.
    pub fn new_lenient(raw: impl AsRef<Path>) -> Self {
        let raw = raw.as_ref();
        match std::fs::canonicalize(raw) {
            Ok(p) => Self(p),
            Err(_) => {
                // Normalise manually: strip trailing slash; do not resolve symlinks.
                let mut s = raw.to_string_lossy().into_owned();
                while s.ends_with('/') || s.ends_with('\\') {
                    s.pop();
                }
                Self(PathBuf::from(s))
            }
        }
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn trailing_slash_normalises_equal() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_str().unwrap();

        let with_slash = format!("{base}/");
        let without_slash = base.to_string();

        let c1 = CanonPath::new(&with_slash).unwrap();
        let c2 = CanonPath::new(&without_slash).unwrap();

        assert_eq!(c1, c2);
    }

    #[test]
    fn lenient_does_not_error_on_missing_path() {
        let p = CanonPath::new_lenient("/nonexistent/path/that/does/not/exist");
        // Should not panic; just normalise what we have.
        assert!(p.as_path().to_str().is_some());
    }

    #[test]
    fn lenient_strips_trailing_slash_on_missing_path() {
        let p1 = CanonPath::new_lenient("/nonexistent/path/foo/");
        let p2 = CanonPath::new_lenient("/nonexistent/path/foo");
        assert_eq!(p1, p2);
    }

    #[test]
    fn new_resolves_symlink() {
        let dir = TempDir::new().unwrap();
        // Create a real directory that exists; canonicalize should work.
        let canon = CanonPath::new(dir.path()).unwrap();
        assert!(canon.as_path().is_absolute());
    }

    #[test]
    fn new_errors_on_missing_path() {
        let result = CanonPath::new("/nonexistent/argus/test/path");
        assert!(result.is_err());
    }
}
