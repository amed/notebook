//! Passphrase normalization, bounded Argon2id derivation, and calibration.

use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use super::keys::{KeyEncryptionKey, KEY_LEN};

pub const KDF_SALT_LEN: usize = 16;
pub const MIN_MEMORY_KIB: u32 = 64 * 1024;
pub const MAX_MEMORY_KIB: u32 = 2 * 1024 * 1024;
pub const MIN_ITERATIONS: u32 = 3;
pub const MAX_ITERATIONS: u32 = 10;
pub const MIN_LANES: u32 = 1;
pub const MAX_LANES: u32 = 8;
pub const CALIBRATION_TARGET_MIN: Duration = Duration::from_millis(500);
pub const CALIBRATION_TARGET_MAX: Duration = Duration::from_millis(1_000);

const CALIBRATION_TARGET: Duration = Duration::from_millis(750);
const MAX_CALIBRATION_STEPS: usize = 6;
const ONE_MIB_IN_KIB: u32 = 1024;

/// The only KDF parameters accepted from an index header.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_kib: 128 * 1024,
            t: MIN_ITERATIONS,
            p: MIN_LANES,
        }
    }
}

impl KdfParams {
    /// Rejects hostile parameters before Argon2 allocates memory or starts work.
    pub fn validate(self) -> Result<Self, KdfError> {
        if !(MIN_MEMORY_KIB..=MAX_MEMORY_KIB).contains(&self.m_kib) {
            return Err(KdfError::MemoryOutOfBounds {
                actual_kib: self.m_kib,
            });
        }
        if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&self.t) {
            return Err(KdfError::IterationsOutOfBounds { actual: self.t });
        }
        if !(MIN_LANES..=MAX_LANES).contains(&self.p) {
            return Err(KdfError::LanesOutOfBounds { actual: self.p });
        }
        Ok(self)
    }

    fn to_argon2(self) -> Result<Params, KdfError> {
        self.validate()?;
        Params::new(self.m_kib, self.t, self.p, Some(KEY_LEN))
            .map_err(|_| KdfError::Argon2ParametersRejected)
    }
}

/// A public, random Argon2 salt.  It is not a secret.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct KdfSalt([u8; KDF_SALT_LEN]);

impl std::fmt::Debug for KdfSalt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("KdfSalt").field(&self.0).finish()
    }
}

impl KdfSalt {
    pub const fn from_bytes(bytes: [u8; KDF_SALT_LEN]) -> Self {
        Self(bytes)
    }

    pub fn try_from_slice(bytes: &[u8]) -> Result<Self, KdfError> {
        let bytes = bytes
            .try_into()
            .map_err(|_| KdfError::InvalidSaltLength {
                actual: bytes.len(),
            })?;
        Ok(Self(bytes))
    }

    pub const fn as_bytes(&self) -> &[u8; KDF_SALT_LEN] {
        &self.0
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum KdfError {
    #[error("Argon2 memory cost {actual_kib} KiB is outside the accepted range")]
    MemoryOutOfBounds { actual_kib: u32 },
    #[error("Argon2 iteration count {actual} is outside the accepted range")]
    IterationsOutOfBounds { actual: u32 },
    #[error("Argon2 lane count {actual} is outside the accepted range")]
    LanesOutOfBounds { actual: u32 },
    #[error("Argon2 rejected otherwise bounded parameters")]
    Argon2ParametersRejected,
    #[error("Argon2 key derivation failed")]
    DerivationFailed,
    #[error("the operating system random source is unavailable")]
    RandomUnavailable,
    #[error("KDF salt has length {actual}, expected {KDF_SALT_LEN}")]
    InvalidSaltLength { actual: usize },
    #[error("the calibration measurement failed")]
    CalibrationMeasurementFailed,
}

/// NFC-normalizes a passphrase into a buffer that wipes itself on drop.
pub fn normalize_passphrase(passphrase: &str) -> Zeroizing<String> {
    Zeroizing::new(passphrase.nfc().collect())
}

/// Generates a fresh 128-bit KDF salt from the operating system RNG.
pub fn random_salt() -> Result<KdfSalt, KdfError> {
    let mut salt = [0_u8; KDF_SALT_LEN];
    getrandom::fill(&mut salt).map_err(|_| KdfError::RandomUnavailable)?;
    Ok(KdfSalt::from_bytes(salt))
}

/// Derives a KEK with Argon2id v1.3 after validating all resource bounds.
pub fn derive_kek(
    passphrase: &str,
    salt: &KdfSalt,
    params: KdfParams,
) -> Result<KeyEncryptionKey, KdfError> {
    let argon_params = params.to_argon2()?;
    let normalized = normalize_passphrase(passphrase);
    let mut output = [0_u8; KEY_LEN];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params)
        .hash_password_into(normalized.as_bytes(), salt.as_bytes(), &mut output)
        .map_err(|_| KdfError::DerivationFailed)?;
    Ok(KeyEncryptionKey::from_bytes(output))
}

/// Calibrates Argon2id on this machine toward a 0.5–1.0 second run time.
///
/// Calibration never emits parameters outside the same bounds enforced during
/// unlock.  If even a boundary parameter cannot meet the window, that boundary
/// is returned instead of weakening or exceeding the resource limits.
pub fn calibrate(passphrase: &str, salt: &KdfSalt) -> Result<KdfParams, KdfError> {
    calibrate_with(|params| {
        let started = Instant::now();
        let key = derive_kek(passphrase, salt, params)?;
        let elapsed = started.elapsed();
        drop(key);
        Ok(elapsed)
    })
}

/// Deterministic calibration engine with an injectable measurement function.
///
/// This is public so callers can run calibration on a blocking worker and so
/// tests can exercise the policy without consuming hundreds of MiB repeatedly.
pub fn calibrate_with<F>(mut measure: F) -> Result<KdfParams, KdfError>
where
    F: FnMut(KdfParams) -> Result<Duration, KdfError>,
{
    let mut current = KdfParams::default();
    for _ in 0..MAX_CALIBRATION_STEPS {
        current.validate()?;
        let elapsed = measure(current).map_err(|error| match error {
            KdfError::MemoryOutOfBounds { .. }
            | KdfError::IterationsOutOfBounds { .. }
            | KdfError::LanesOutOfBounds { .. }
            | KdfError::Argon2ParametersRejected
            | KdfError::DerivationFailed
            | KdfError::RandomUnavailable
            | KdfError::InvalidSaltLength { .. } => error,
            KdfError::CalibrationMeasurementFailed => KdfError::CalibrationMeasurementFailed,
        })?;

        if (CALIBRATION_TARGET_MIN..=CALIBRATION_TARGET_MAX).contains(&elapsed) {
            return Ok(current);
        }

        let next = tuned_params(current, elapsed);
        if next == current {
            return Ok(current);
        }
        current = next;
    }
    Ok(current)
}

fn tuned_params(current: KdfParams, elapsed: Duration) -> KdfParams {
    let current_cost = u128::from(current.m_kib) * u128::from(current.t);
    let elapsed_nanos = elapsed.as_nanos();
    let desired_cost = if elapsed_nanos == 0 {
        current_cost.saturating_mul(4)
    } else {
        current_cost
            .saturating_mul(CALIBRATION_TARGET.as_nanos())
            .checked_div(elapsed_nanos)
            .unwrap_or(u128::MAX)
    };

    let min_cost = u128::from(MIN_MEMORY_KIB) * u128::from(MIN_ITERATIONS);
    let max_cost = u128::from(MAX_MEMORY_KIB) * u128::from(MAX_ITERATIONS);
    let desired_cost = desired_cost.clamp(min_cost, max_cost);

    let (mut memory, iterations) =
        if desired_cost <= u128::from(MAX_MEMORY_KIB) * u128::from(MIN_ITERATIONS) {
            let memory = ceil_div(desired_cost, u128::from(MIN_ITERATIONS));
            (memory, MIN_ITERATIONS)
        } else {
            let iterations = ceil_div(desired_cost, u128::from(MAX_MEMORY_KIB))
                .min(u128::from(MAX_ITERATIONS)) as u32;
            let memory = ceil_div(desired_cost, u128::from(iterations));
            (memory, iterations)
        };

    memory = ceil_div(memory, u128::from(ONE_MIB_IN_KIB)) * u128::from(ONE_MIB_IN_KIB);
    let memory = (memory.min(u128::from(MAX_MEMORY_KIB)) as u32).max(MIN_MEMORY_KIB);
    let mut candidate = KdfParams {
        m_kib: memory,
        t: iterations.clamp(MIN_ITERATIONS, MAX_ITERATIONS),
        p: MIN_LANES,
    };

    // Coarse MiB rounding can otherwise stall one step just outside the window.
    if candidate == current {
        if elapsed < CALIBRATION_TARGET_MIN {
            if candidate.m_kib < MAX_MEMORY_KIB {
                candidate.m_kib = candidate
                    .m_kib
                    .saturating_add(ONE_MIB_IN_KIB)
                    .min(MAX_MEMORY_KIB);
            } else if candidate.t < MAX_ITERATIONS {
                candidate.t += 1;
            }
        } else if candidate.t > MIN_ITERATIONS {
            candidate.t -= 1;
        } else if candidate.m_kib > MIN_MEMORY_KIB {
            candidate.m_kib = candidate
                .m_kib
                .saturating_sub(ONE_MIB_IN_KIB)
                .max(MIN_MEMORY_KIB);
        }
    }

    candidate
}

const fn ceil_div(dividend: u128, divisor: u128) -> u128 {
    dividend / divisor + u128::from(dividend % divisor != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;

    fn minimum() -> KdfParams {
        KdfParams {
            m_kib: MIN_MEMORY_KIB,
            t: MIN_ITERATIONS,
            p: MIN_LANES,
        }
    }

    #[test]
    fn exact_parameter_boundaries_are_accepted() {
        assert!(minimum().validate().is_ok());
        assert!(KdfParams {
            m_kib: MAX_MEMORY_KIB,
            t: MAX_ITERATIONS,
            p: MAX_LANES,
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn every_parameter_outside_the_bounds_is_rejected() {
        for m_kib in [0, MIN_MEMORY_KIB - 1, MAX_MEMORY_KIB + 1, u32::MAX] {
            assert_eq!(
                KdfParams {
                    m_kib,
                    ..minimum()
                }
                .validate(),
                Err(KdfError::MemoryOutOfBounds { actual_kib: m_kib })
            );
        }
        for t in [0, MIN_ITERATIONS - 1, MAX_ITERATIONS + 1, u32::MAX] {
            assert_eq!(
                KdfParams { t, ..minimum() }.validate(),
                Err(KdfError::IterationsOutOfBounds { actual: t })
            );
        }
        for p in [0, MAX_LANES + 1, u32::MAX] {
            assert_eq!(
                KdfParams { p, ..minimum() }.validate(),
                Err(KdfError::LanesOutOfBounds { actual: p })
            );
        }
    }

    #[test]
    fn invalid_parameters_are_rejected_before_derivation() {
        let error = derive_kek(
            "does not matter",
            &KdfSalt::from_bytes([0; KDF_SALT_LEN]),
            KdfParams {
                m_kib: MAX_MEMORY_KIB + 1,
                ..minimum()
            },
        )
        .unwrap_err();
        assert_eq!(
            error,
            KdfError::MemoryOutOfBounds {
                actual_kib: MAX_MEMORY_KIB + 1
            }
        );
    }

    #[test]
    fn nfc_equivalent_passphrases_derive_the_same_kek() {
        let salt = KdfSalt::from_bytes(*b"fixed test salt!");
        let composed = derive_kek("Caf\u{00e9}\u{1f510}", &salt, minimum()).unwrap();
        let decomposed = derive_kek("Cafe\u{0301}\u{1f510}", &salt, minimum()).unwrap();
        assert_eq!(composed.expose_secret(), decomposed.expose_secret());
    }

    #[test]
    fn normalization_buffer_contains_nfc() {
        let normalized = normalize_passphrase("A\u{030a}ngstro\u{0308}m");
        assert_eq!(&*normalized, "\u{00c5}ngstr\u{00f6}m");
    }

    #[test]
    fn salt_parser_requires_exact_length() {
        assert!(KdfSalt::try_from_slice(&[0; KDF_SALT_LEN]).is_ok());
        for length in [0, KDF_SALT_LEN - 1, KDF_SALT_LEN + 1, 32] {
            assert_eq!(
                KdfSalt::try_from_slice(&vec![0; length]),
                Err(KdfError::InvalidSaltLength { actual: length })
            );
        }
    }

    #[test]
    fn deterministic_calibration_reaches_the_target_window() {
        // Simulate a machine where the default costs 96 ms. Runtime scales with
        // memory*iterations, which is the model used by the policy.
        let default_cost = u64::from(KdfParams::default().m_kib)
            * u64::from(KdfParams::default().t);
        let result = calibrate_with(|params| {
            let cost = u64::from(params.m_kib) * u64::from(params.t);
            Ok(Duration::from_millis(96 * cost / default_cost))
        })
        .unwrap();
        let measured = Duration::from_millis(
            96 * u64::from(result.m_kib) * u64::from(result.t) / default_cost,
        );
        assert!((CALIBRATION_TARGET_MIN..=CALIBRATION_TARGET_MAX).contains(&measured));
        assert!(result.validate().is_ok());
    }

    #[test]
    fn calibration_stays_at_minimum_on_an_extremely_slow_machine() {
        let result = calibrate_with(|params| {
            let relative = u64::from(params.m_kib) * u64::from(params.t);
            Ok(Duration::from_secs(relative / u64::from(MIN_MEMORY_KIB)))
        })
        .unwrap();
        assert_eq!(result, minimum());
    }

    #[test]
    fn calibration_stays_within_maximum_on_an_extremely_fast_machine() {
        let result = calibrate_with(|_| Ok(Duration::ZERO)).unwrap();
        assert!(result.validate().is_ok());
        assert!(result.m_kib <= MAX_MEMORY_KIB);
        assert!(result.t <= MAX_ITERATIONS);
    }

    #[test]
    fn random_salts_are_not_reused() {
        assert_ne!(random_salt().unwrap(), random_salt().unwrap());
    }
}
