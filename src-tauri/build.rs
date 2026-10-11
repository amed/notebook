fn main() {
    let mut attributes = tauri_build::Attributes::new();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV");
    if target_os.as_deref() == Ok("windows") && target_env.as_deref() == Ok("msvc") {
        // tauri-build embeds its Common-Controls v6 manifest into bins only, so
        // test harnesses would load comctl32 v5 and fail with
        // STATUS_ENTRYPOINT_NOT_FOUND. The linker embeds this copy everywhere.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    // macOS release binaries: strip at link time (no debug map, no local
    // symbols), whatever the PATH; see ../.cargo/config.toml.
    if target_os.as_deref() == Ok("macos") && std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:rustc-link-arg-bins=-Wl,-S");
        println!("cargo:rustc-link-arg-bins=-Wl,-x");
    }
    tauri_build::try_build(attributes).expect("failed to run build script");
}
