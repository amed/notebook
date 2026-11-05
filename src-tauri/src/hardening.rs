//! Startup hygiene from spec sections 11 and 14: stderr-only logging, a panic
//! hook that never prints the panic payload, and core-dump suppression.

/// Runs before the window opens, so no vault material exists in memory yet.
pub fn init() {
    init_logging();
    install_panic_hook();
    disable_core_dumps();
}

fn init_logging() {
    let level = if cfg!(debug_assertions) {
        tracing::Level::DEBUG
    } else {
        tracing::Level::WARN
    };
    let _ = tracing_subscriber::fmt()
        .with_max_level(level)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_target(false)
        .try_init();
}

fn install_panic_hook() {
    // The payload can carry document text or names; the location cannot.
    std::panic::set_hook(Box::new(|info| match info.location() {
        Some(location) => eprintln!("panic at {}:{}", location.file(), location.line()),
        None => eprintln!("panic at unknown location"),
    }));
}

fn disable_core_dumps() {
    #[cfg(all(unix, not(debug_assertions)))]
    if rlimit::setrlimit(rlimit::Resource::CORE, 0, 0).is_err() {
        tracing::warn!("could not disable core dumps");
    }

    #[cfg(all(target_os = "linux", not(debug_assertions)))]
    if rustix::process::set_dumpable_behavior(rustix::process::DumpableBehavior::NotDumpable)
        .is_err()
    {
        tracing::warn!("could not mark the process non-dumpable");
    }
}
