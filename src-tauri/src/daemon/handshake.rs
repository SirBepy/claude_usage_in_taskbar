use crate::daemon::health::PROTOCOL_VERSION;
use serde_json::Value;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum HandshakeError {
    #[error("missing protocol_version field")]
    MissingField,
    #[error("protocol_version mismatch: client={client}, daemon={daemon}")]
    VersionMismatch { client: u32, daemon: u32 },
}

pub fn verify_handshake(first_frame: &Value) -> Result<(), HandshakeError> {
    let v = first_frame.get("protocol_version")
        .and_then(Value::as_u64)
        .ok_or(HandshakeError::MissingField)?;
    let v = v as u32;
    if v != PROTOCOL_VERSION {
        return Err(HandshakeError::VersionMismatch { client: v, daemon: PROTOCOL_VERSION });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matching_version_passes() {
        assert!(verify_handshake(&json!({"protocol_version": PROTOCOL_VERSION})).is_ok());
    }

    #[test]
    fn missing_field_fails() {
        assert_eq!(
            verify_handshake(&json!({})),
            Err(HandshakeError::MissingField)
        );
    }

    #[test]
    fn mismatched_version_fails() {
        assert_eq!(
            verify_handshake(&json!({"protocol_version": 999})),
            Err(HandshakeError::VersionMismatch { client: 999, daemon: PROTOCOL_VERSION })
        );
    }
}
